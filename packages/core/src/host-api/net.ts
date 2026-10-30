import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';
import { HelmError, ErrorCode } from '../errors.ts';
import { hostMatches, isPrivateAddress } from '../permissions/catalog.ts';

export interface NetRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface NetResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  encoding: 'utf8' | 'base64';
  url: string;
  truncated: boolean;
}

export type NetTransport = (req: NetRequest & { method: string }) => Promise<Omit<NetResponse, 'url' | 'truncated'> & { truncated?: boolean }>;

export interface NetPolicy {
  hosts: string[];
  allowLocal: boolean;
}

const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|.*\+json|.*\+xml))/i;

export function checkUrl(url: string, policy: NetPolicy): URL {
  let u: URL;
  try { u = new URL(url); } catch { throw new HelmError(ErrorCode.INPUT_INVALID, `Invalid URL: ${url}`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HelmError(ErrorCode.PERMISSION_DENIED, `Only http(s) URLs are allowed, not ${u.protocol}`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!hostMatches(host, policy.hosts) && !hostMatches(`${host}:${u.port}`, policy.hosts)) {
    throw new HelmError(ErrorCode.PERMISSION_DENIED, `net.http does not allow host "${host}" (granted: ${policy.hosts.join(', ') || 'none'})`);
  }
  if (!policy.allowLocal && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || (net.isIP(host) && isPrivateAddress(host)))) {
    throw new HelmError(ErrorCode.PERMISSION_DENIED, `"${host}" is a local/private address; that needs the net.local permission`);
  }
  return u;
}

/**
 * Perform an HTTP request on behalf of a plugin. DNS answers are validated at connect time
 * (custom lookup) so a public name that resolves to a private address is refused even if it
 * changes between check and connect (DNS rebinding). Redirects are followed manually and every
 * hop is re-checked against the policy.
 */
export async function brokerFetch(req: NetRequest, policy: NetPolicy, transport?: NetTransport): Promise<NetResponse> {
  const method = (req.method ?? 'GET').toUpperCase();
  const maxBytes = Math.min(req.maxBytes ?? 5 * 1024 * 1024, 20 * 1024 * 1024);
  const timeoutMs = Math.min(req.timeoutMs ?? 30_000, 300_000);
  let url = req.url;
  for (let hop = 0; hop < 6; hop++) {
    const u = checkUrl(url, policy);
    const res = transport
      ? { ...(await transport({ ...req, url, method, maxBytes, timeoutMs })), location: undefined as string | undefined }
      : await rawRequest(u, method, req.headers ?? {}, req.body, timeoutMs, maxBytes, policy.allowLocal);
    const location = res.location ?? res.headers['location'];
    if ([301, 302, 303, 307, 308].includes(res.status) && location) {
      url = new URL(location, url).toString();
      continue;
    }
    return { status: res.status, headers: res.headers, body: res.body, encoding: res.encoding, url, truncated: !!res.truncated };
  }
  throw new HelmError(ErrorCode.TOOL_ERROR, 'Too many redirects');
}

function safeLookup(allowLocal: boolean): net.LookupFunction {
  return (hostname, options, cb) => {
    dns.lookup(hostname, { ...(options as dns.LookupOptions), all: true }, (err, addresses) => {
      if (err) return (cb as any)(err);
      const list = addresses as dns.LookupAddress[];
      const bad = !allowLocal && list.find((a) => isPrivateAddress(a.address));
      if (bad) return (cb as any)(new HelmError(ErrorCode.PERMISSION_DENIED, `${hostname} resolves to private address ${bad.address}; that needs net.local`));
      if ((options as dns.LookupOptions).all) return (cb as any)(null, list);
      return (cb as any)(null, list[0]!.address, list[0]!.family);
    });
  };
}

function rawRequest(u: URL, method: string, headers: Record<string, string>, body: string | undefined, timeoutMs: number, maxBytes: number, allowLocal: boolean) {
  return new Promise<{ status: number; headers: Record<string, string>; body: string; encoding: 'utf8' | 'base64'; truncated: boolean; location?: string }>((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const r = mod.request(u, {
      method,
      headers: { 'user-agent': 'Helm-Agent/0.1 (+plugin broker)', 'accept-encoding': 'gzip, deflate, br', ...headers },
      lookup: safeLookup(allowLocal),
      timeout: timeoutMs,
    }, (res) => {
      const hdrs: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) hdrs[k] = Array.isArray(v) ? v.join(', ') : String(v);
      let stream: NodeJS.ReadableStream = res;
      const enc = (hdrs['content-encoding'] ?? '').toLowerCase();
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      stream.on('data', (c: Buffer) => {
        if (truncated) return;
        size += c.length;
        if (size > maxBytes) { truncated = true; chunks.push(c.subarray(0, c.length - (size - maxBytes))); res.destroy(); return; }
        chunks.push(c);
      });
      const done = () => {
        const buf = Buffer.concat(chunks);
        const textual = TEXTUAL.test(hdrs['content-type'] ?? 'text/plain');
        resolve({ status: res.statusCode ?? 0, headers: hdrs, body: textual ? buf.toString('utf8') : buf.toString('base64'), encoding: textual ? 'utf8' : 'base64', truncated, location: hdrs['location'] });
      };
      stream.on('end', done);
      stream.on('close', () => { if (truncated) done(); });
      stream.on('error', (e) => (truncated ? done() : reject(new HelmError(ErrorCode.TOOL_ERROR, `Response error: ${e.message}`))));
    });
    r.on('timeout', () => r.destroy(new HelmError(ErrorCode.CALL_TIMEOUT, `Request to ${u.host} timed out after ${timeoutMs} ms`)));
    r.on('error', (e) => reject(e instanceof HelmError ? e : new HelmError(ErrorCode.TOOL_ERROR, `Request to ${u.host} failed: ${e.message}`)));
    if (body !== undefined) r.write(body);
    r.end();
  });
}

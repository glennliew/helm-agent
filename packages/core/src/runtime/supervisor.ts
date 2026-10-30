import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Manifest, PluginLimits, PluginRecord } from '../types.ts';
import { HelmError, ErrorCode, explain } from '../errors.ts';
import { RpcPeer } from './rpc.ts';
import { buildLaunch } from './launch.ts';
import type { Isolation, LaunchSpec } from './launch.ts';
import { Broker } from '../permissions/broker.ts';
import type { BrokerHost } from '../permissions/broker.ts';
import { redactor } from '../permissions/secrets.ts';
import { HOST_VERSION, PROTOCOL_VERSION, ensureDirSync, pluginDataDir } from '../paths.ts';
import { effectiveConfig, effectiveLimits } from '../plugin-config.ts';
import { expectedIsolation } from './launch.ts';

export type ProcState = 'stopped' | 'starting' | 'active' | 'stopping' | 'crashed' | 'quarantined';

export interface Capabilities {
  tools: string[];
  commands: string[];
  hooks: string[];
  panels: string[];
  providers: string[];
}

export interface SupervisorHost extends BrokerHost {
  trace?: (pluginId: string, dir: 'in' | 'out', msg: unknown) => void;
  onStderr?: (pluginId: string, line: string) => void;
}

const CRASH_WINDOW_MS = 5 * 60_000;
const QUARANTINE_AFTER = 3;
const MAX_NOISE_LINES = 20;
const LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * One plugin = one OS process. The supervisor owns its lifecycle; nothing a plugin does
 * (crash, hang, spam, OOM, protocol garbage) can throw into the host — every failure is turned
 * into a structured HelmError on the affected call and a health record for the user.
 */
export class PluginProcess {
  readonly id: string;
  readonly manifest: Manifest;
  readonly broker: Broker;
  state: ProcState = 'stopped';
  isolation?: Isolation;
  layers: string[] = [];
  pid?: number;
  capabilities?: Capabilities;
  warnings: string[] = [];
  startedAt?: number;
  private host: SupervisorHost;
  private record: PluginRecord;
  private child?: ChildProcess;
  private peer?: RpcPeer;
  private starting?: Promise<void>;
  private stderrTail: string[] = [];
  /** First out-of-memory line seen; kept separately because the stack dump that follows pushes it out of the tail. */
  private oomLine?: string;
  private stderrBuf = '';
  private running = 0;
  private queue: Array<() => void> = [];
  private idleTimer?: NodeJS.Timeout;
  private watchdog?: NodeJS.Timeout;
  private noise = 0;
  private killReason?: { code: ErrorCode; message: string };
  private exited?: Promise<void>;
  /** Set while we check whether a process that timed out is wedged; new calls wait for the verdict. */
  private suspect?: Promise<void>;
  private logLines = { second: 0, count: 0, dropped: 0 };

  constructor(host: SupervisorHost, manifest: Manifest, record: PluginRecord) {
    this.host = host;
    this.manifest = manifest;
    this.record = record;
    this.id = manifest.id;
    this.broker = new Broker(host, manifest);
    if (record.health.quarantinedAt) this.state = 'quarantined';
  }

  limits(): Required<PluginLimits> {
    return effectiveLimits(this.manifest, this.host.state.get(this.id) ?? this.record);
  }

  private setState(to: ProcState, reason?: string, code?: string) {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    this.host.bus.emitEvent('plugin.state', { plugin: this.id, from, to, reason, code });
  }

  // ---------------- logging ----------------
  log(level: string, message: string) {
    const now = Math.floor(Date.now() / 1000);
    if (now !== this.logLines.second) {
      if (this.logLines.dropped) this.writeLog('warn', `[helm] dropped ${this.logLines.dropped} log lines (rate limit 200/s)`);
      this.logLines = { second: now, count: 0, dropped: 0 };
    }
    if (++this.logLines.count > 200) { this.logLines.dropped++; return; }
    this.writeLog(level, message);
  }

  private writeLog(level: string, message: string) {
    const clean = redactor.redact(message).slice(0, 4000);
    const file = path.join(this.host.paths.logs, `${this.id}.log`);
    try {
      ensureDirSync(this.host.paths.logs);
      try { if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, file + '.1'); } catch { /* no file yet */ }
      fs.appendFileSync(file, `${new Date().toISOString()} [${level}] ${clean}\n`);
    } catch { /* logging must never break the host */ }
    this.host.bus.emitEvent('plugin.log', { plugin: this.id, level, message: clean });
  }

  private onStderrChunk(chunk: string) {
    this.stderrBuf += chunk;
    let nl: number;
    while ((nl = this.stderrBuf.indexOf('\n')) !== -1) {
      const line = this.stderrBuf.slice(0, nl);
      this.stderrBuf = this.stderrBuf.slice(nl + 1);
      if (!this.oomLine && /heap out of memory|Reached heap limit|Allocation failed|MemoryError/.test(line)) this.oomLine = redactor.redact(line).slice(0, 500);
      this.stderrTail.push(redactor.redact(line).slice(0, 500));
      if (this.stderrTail.length > 40) this.stderrTail.shift();
      this.log('stderr', line);
      this.host.onStderr?.(this.id, redactor.redact(line));
    }
    if (this.stderrBuf.length > 64 * 1024) this.stderrBuf = this.stderrBuf.slice(-1024);
  }

  // ---------------- lifecycle ----------------
  async ensureStarted(): Promise<void> {
    if (this.state === 'active') return;
    if (this.starting) return this.starting;
    const rec = this.host.state.get(this.id);
    if (!rec) throw new HelmError(ErrorCode.PLUGIN_NOT_FOUND, `${this.id} is not installed`);
    this.record = rec;
    if (!rec.enabled) throw new HelmError(ErrorCode.PLUGIN_DISABLED, `${this.id} is disabled`, { hint: `helm plugin enable ${this.id}` });
    if (rec.health.quarantinedAt) {
      this.setState('quarantined');
      throw new HelmError(ErrorCode.PLUGIN_QUARANTINED, `${this.id} was quarantined after repeated crashes`, { hint: `Last error: ${rec.health.lastError?.message ?? 'unknown'}. Fix it, then run: helm plugin reset ${this.id}`, details: rec.health.lastError });
    }
    const iso = expectedIsolation(this.manifest);
    if (iso.level !== 'strict' && this.host.config().security.requireStrictIsolation && !rec.trusted) {
      throw new HelmError(ErrorCode.ISOLATION_UNAVAILABLE, `${this.id} needs the macOS sandbox, which is unavailable here: ${iso.reason}`, { hint: `Run Helm from a normal terminal, or run it with reduced (${iso.level}) isolation after reviewing it: helm plugin trust ${this.id}` });
    }
    const recent = rec.health.crashes.filter((t) => Date.now() - t < CRASH_WINDOW_MS);
    if (recent.length) {
      const backoff = Math.min(30_000, 500 * 2 ** (recent.length - 1));
      const wait = recent.at(-1)! + backoff - Date.now();
      if (wait > 3000) throw new HelmError(ErrorCode.PLUGIN_CRASHED, `${this.id} crashed recently; restarting in ${Math.ceil(wait / 1000)}s`, { details: rec.health.lastError });
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    this.starting = this.start().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async start() {
    this.setState('starting');
    this.killReason = undefined;
    this.noise = 0;
    this.stderrTail = [];
    this.oomLine = undefined;
    const limits = this.limits();
    let spec: LaunchSpec;
    try {
      spec = buildLaunch({ manifest: this.manifest, record: this.record, paths: this.host.paths, workspace: this.host.workspace, memoryMb: limits.memoryMb });
    } catch (e) {
      this.setState('stopped');
      throw new HelmError(ErrorCode.ACTIVATION_FAILED, `Cannot launch ${this.id}: ${(e as Error).message}`);
    }
    this.isolation = spec.isolation;
    this.layers = spec.layers;
    this.log('info', `[helm] starting ${this.id}@${this.manifest.version} (${spec.isolation} isolation: ${spec.layers.join(', ')})`);
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.pid = child.pid;
    this.startedAt = Date.now();
    child.stdin!.on('error', () => { /* EPIPE: handled by exit */ });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (c: string) => this.onStderrChunk(c));

    const peer = new RpcPeer(child.stdout!, child.stdin!, {
      name: this.id,
      onProtocolNoise: (line) => {
        this.noise++;
        this.log('warn', `[protocol] non-JSON line on stdout (use stderr for logs): ${line.slice(0, 200)}`);
        if (this.noise > MAX_NOISE_LINES) this.kill(ErrorCode.PROTOCOL_ERROR, `${this.id} wrote too much non-protocol output to stdout`);
      },
      onProtocolViolation: (reason) => this.kill(ErrorCode.PROTOCOL_ERROR, `${this.id} violated the protocol: ${reason}`),
      onTrace: this.host.trace ? (dir, msg) => this.host.trace!(this.id, dir, redactor.redactDeep(msg)) : undefined,
    });
    this.peer = peer;
    for (const [method, h] of Object.entries(this.broker.handlers())) peer.handle(method, h);
    peer.onNotification('host/log', (p) => this.log(String(p?.level ?? 'info'), String(p?.message ?? '')));
    peer.onNotification('host/progress', (p) => this.host.bus.emitEvent('plugin.progress', { plugin: this.id, callId: p?.callId, message: String(p?.message ?? '') }));
    peer.onNotification('host/ui.notify', (p) => this.host.bus.emitEvent('plugin.notify', { plugin: this.id, level: String(p?.level ?? 'info'), message: redactor.redact(String(p?.message ?? '')) }));
    peer.onNotification('host/ui.refresh', (p) => this.host.bus.emitEvent('panel.refresh', { plugin: this.id, panel: p?.panel }));

    let spawnError: Error | undefined;
    child.on('error', (e) => { spawnError = e; });
    this.exited = new Promise<void>((resolve) => {
      child.on('close', (code, signal) => {
        this.onExit(code, signal, spawnError);
        resolve();
      });
    });

    const exitedEarly = this.exited.then(() => { throw this.lastExitError ?? new HelmError(ErrorCode.ACTIVATION_FAILED, `${this.id} exited during start-up`); });
    exitedEarly.catch(() => { /* observed via Promise.race below; later exits are handled by onExit */ });
    try {
      const init = await Promise.race([
        peer.request<{ protocolVersion: string; capabilities: Capabilities }>('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          host: { name: 'helm', version: HOST_VERSION },
          plugin: { id: this.id, version: this.manifest.version, dataDir: pluginDataDir(this.host.paths, this.id).files },
          workspace: this.host.workspace,
          config: effectiveConfig(this.manifest, this.record.config),
          grants: this.record.grants.map((g) => ({ id: g.id, scope: g.scope })),
          isolation: spec.isolation,
        }, { timeoutMs: limits.activationTimeoutMs }),
        exitedEarly,
      ]);
      const major = (v: string) => String(v).split('.')[0];
      if (major(init.protocolVersion) !== major(PROTOCOL_VERSION)) {
        throw new HelmError(ErrorCode.INCOMPATIBLE_VERSION, `${this.id} speaks protocol ${init.protocolVersion}, host speaks ${PROTOCOL_VERSION}`);
      }
      this.capabilities = init.capabilities;
      this.checkCapabilities(init.capabilities);
      this.setState('active');
      this.startWatchdog(limits.memoryMb);
      this.armIdle();
    } catch (e) {
      const err = e instanceof HelmError ? e : new HelmError(ErrorCode.ACTIVATION_FAILED, String(e));
      const code = err.code === ErrorCode.CALL_TIMEOUT ? ErrorCode.ACTIVATION_TIMEOUT : err.code === ErrorCode.PLUGIN_CRASHED ? ErrorCode.ACTIVATION_FAILED : err.code;
      const final = new HelmError(code, code === ErrorCode.ACTIVATION_TIMEOUT ? `${this.id} did not finish activate() within ${limits.activationTimeoutMs} ms` : err.message, { details: { stderrTail: this.stderrTail.slice(-8) }, hint: err.hint });
      if (this.child && this.child.exitCode === null) this.kill(code, final.message);
      await this.exited?.catch(() => {});
      this.recordFailure(final, true);
      throw final;
    }
  }

  private lastExitError?: HelmError;

  private checkCapabilities(c: Capabilities) {
    const m = this.manifest.contributes ?? {};
    const missing = (kind: string, declared: string[] | undefined, impl: string[] | undefined) => {
      (declared ?? []).filter((n) => !(impl ?? []).includes(n)).forEach((n) => this.warnings.push(`manifest declares ${kind} "${n}" but the code does not implement it`));
      (impl ?? []).filter((n) => !(declared ?? []).includes(n)).forEach((n) => this.warnings.push(`code implements ${kind} "${n}" but helm-plugin.json does not declare it (Helm will never call it)`));
    };
    this.warnings = [];
    missing('tool', m.tools?.map((t) => t.name), c.tools);
    missing('command', m.commands?.map((t) => t.name), c.commands);
    missing('panel', m.panels?.map((t) => t.id), c.panels);
    missing('provider', m.providers?.map((t) => t.id), c.providers);
    const declaredHooks = new Set((m.hooks ?? []).map((h) => h.event));
    for (const h of c.hooks ?? []) if (!declaredHooks.has(h)) this.warnings.push(`code handles hook "${h}" that the manifest does not declare (it will never be called)`);
    for (const w of this.warnings) this.log('warn', `[helm] ${w}`);
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null, spawnError?: Error) {
    clearInterval(this.watchdog);
    clearTimeout(this.idleTimer);
    const wasStopping = this.state === 'stopping';
    const oom = !!this.oomLine;
    const reason = this.killReason ?? (oom ? { code: ErrorCode.MEMORY_LIMIT, message: `${this.id} ran out of memory (limit ${this.limits().memoryMb} MB)` } : undefined);
    const message = spawnError ? `Could not start ${this.id}: ${spawnError.message}` : reason?.message ?? `${this.id} exited unexpectedly (${signal ? `signal ${signal}` : `exit code ${code}`})`;
    const tail = oom && !this.killReason ? [this.oomLine!] : this.stderrTail.slice(-8);
    const err = new HelmError(reason?.code ?? ErrorCode.PLUGIN_CRASHED, message, { details: { exitCode: code, signal, stderrTail: tail } });
    this.lastExitError = err;
    this.peer?.close(err);
    this.peer = undefined;
    this.child = undefined;
    this.pid = undefined;
    for (const fn of this.queue.splice(0)) fn();
    this.log(wasStopping ? 'info' : 'error', `[helm] process exited (${signal ? `signal ${signal}` : `code ${code}`})${wasStopping ? '' : `: ${message}`}`);
    if (wasStopping) { this.setState('stopped', 'stopped'); return; }
    if (this.state === 'starting') return; // start() reports the failure
    this.recordFailure(err, false);
  }

  /** Persist the failure so every Helm process (and `helm plugin info`) can explain it. */
  private recordFailure(err: HelmError, duringStart: boolean) {
    let quarantined = false;
    try {
      this.host.state.patch(this.id, (r) => {
        const now = Date.now();
        r.health.crashes = [...r.health.crashes.filter((t) => now - t < CRASH_WINDOW_MS), now].slice(-10);
        r.health.lastError = { code: err.code, message: err.message, at: new Date().toISOString(), stderrTail: this.stderrTail.slice(-8) };
        if (r.health.crashes.length >= QUARANTINE_AFTER && !r.health.quarantinedAt) {
          r.health.quarantinedAt = new Date().toISOString();
          quarantined = true;
        }
      });
    } catch { /* plugin was uninstalled meanwhile */ }
    this.host.audit.write({ plugin: this.id, kind: 'lifecycle', action: duringStart ? 'activation failed' : 'crashed', decision: 'info', reason: `${err.code}: ${err.message}` });
    if (quarantined) {
      this.log('error', `[helm] quarantined after ${QUARANTINE_AFTER} failures in 5 minutes. Run \`helm plugin reset ${this.id}\` after fixing it.`);
      this.setState('quarantined', err.message, ErrorCode.PLUGIN_QUARANTINED);
    } else {
      this.setState('crashed', err.message, err.code);
    }
  }

  private startWatchdog(memoryMb: number) {
    clearInterval(this.watchdog);
    const limitKb = (this.manifest.runtime.type === 'node' ? memoryMb * 1.5 + 96 : memoryMb) * 1024;
    let failures = 0;
    this.watchdog = setInterval(() => {
      const pid = this.pid;
      if (!pid) return;
      const giveUp = () => {
        if (++failures === 3) {
          clearInterval(this.watchdog);
          this.log('warn', '[helm] memory watchdog disabled: cannot run /bin/ps here (V8 heap limit still applies to Node plugins)');
        }
      };
      try {
        execFile('/bin/ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 2000 }, (err, out) => {
          if (err) return giveUp();
          const rss = Number(out.trim());
          if (rss > limitKb) this.kill(ErrorCode.MEMORY_LIMIT, `${this.id} used ${Math.round(rss / 1024)} MB, over its ${memoryMb} MB limit`);
        });
      } catch {
        giveUp();
      }
    }, 1500);
    this.watchdog.unref();
  }

  private armIdle() {
    clearTimeout(this.idleTimer);
    const ms = this.limits().idleTimeoutMs;
    this.idleTimer = setTimeout(() => { if (this.running === 0 && this.state === 'active') void this.stop('idle'); }, ms);
    this.idleTimer.unref();
  }

  /** Kill immediately; the exit handler turns this into a crash record with the given reason. */
  kill(code: ErrorCode, message: string) {
    if (!this.child) return;
    this.killReason = { code, message };
    this.log('error', `[helm] killing process: ${message}`);
    try { this.child.kill('SIGKILL'); } catch { /* already gone */ }
  }

  async stop(reason = 'stopped') {
    if (!this.child || this.state === 'stopping') { if (this.state !== 'quarantined') this.setState('stopped', reason); return; }
    const child = this.child;
    this.setState('stopping', reason);
    try { await this.peer?.request('shutdown', {}, { timeoutMs: 2000 }); } catch { /* best effort */ }
    this.peer?.notify('exit', {});
    const t1 = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } }, 1500);
    const t2 = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
    await this.exited;
    clearTimeout(t1);
    clearTimeout(t2);
  }

  // ---------------- calls ----------------
  async call<T = unknown>(method: string, params: unknown, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    // Never route a new call to a process we are about to kill (or might kill): wait, then restart.
    if (this.suspect) await this.suspect;
    if (this.killReason && this.child) await this.exited;
    await this.ensureStarted();
    const limits = this.limits();
    if (this.running >= limits.maxConcurrency) await new Promise<void>((r) => this.queue.push(r));
    if (!this.peer) throw this.lastExitError ?? new HelmError(ErrorCode.PLUGIN_CRASHED, `${this.id} is not running`);
    this.running++;
    clearTimeout(this.idleTimer);
    const timeoutMs = opts.timeoutMs ?? limits.callTimeoutMs;
    try {
      return await this.peer.request<T>(method, params, { timeoutMs, signal: opts.signal });
    } catch (e) {
      if (e instanceof HelmError && e.code === ErrorCode.CALL_TIMEOUT) void this.checkResponsive();
      throw e;
    } finally {
      this.running--;
      this.queue.shift()?.();
      if (this.running === 0) this.armIdle();
    }
  }

  /** After a timeout, ping the plugin; if it is wedged (e.g. a busy loop), kill and restart it. */
  private async checkResponsive() {
    const peer = this.peer;
    if (!peer || this.suspect) return;
    this.suspect = (async () => {
      try {
        await peer.request('$/ping', {}, { timeoutMs: 2000 });
      } catch {
        if (this.peer !== peer) return; // already gone
        this.kill(ErrorCode.CALL_TIMEOUT, `${this.id} stopped responding (did not answer a ping after a timed-out call)`);
        await this.exited;
      }
    })().finally(() => { this.suspect = undefined; });
  }

  notify(method: string, params: unknown) {
    this.peer?.notify(method, params);
  }

  describe() {
    return {
      state: this.state, pid: this.pid, isolation: this.isolation, layers: this.layers, warnings: this.warnings,
      uptimeMs: this.startedAt && this.state === 'active' ? Date.now() - this.startedAt : undefined,
      lastError: this.lastExitError ? { code: this.lastExitError.code, message: this.lastExitError.message, hint: explain(this.lastExitError.code).hint } : undefined,
    };
  }
}

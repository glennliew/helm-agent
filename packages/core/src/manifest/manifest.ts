import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';
import AjvModule from 'ajv';
import type { ErrorObject } from 'ajv';
import type { Manifest } from '../types.ts';
import { PERMISSIONS } from '../permissions/catalog.ts';
import { HOST_VERSION, PROTOCOL_VERSION } from '../paths.ts';

const Ajv = (AjvModule as unknown as { default: typeof AjvModule }).default ?? AjvModule;
export const ajv = new (Ajv as unknown as new (o: object) => import('ajv').default)({ allErrors: true, strict: false, useDefaults: true });

export const MANIFEST_FILE = 'helm-plugin.json';
export const HOOK_EVENTS = ['session.start', 'session.end', 'message.user', 'model.response', 'tool.before', 'tool.after', 'tool.error', 'plugin.state'];
const NAME = '^[a-z][a-z0-9_]{0,40}$';

const schemaObj = { type: 'object' };

export const manifestSchema = {
  $id: 'https://helm.local/schemas/plugin-manifest-v1.json',
  type: 'object',
  required: ['manifestVersion', 'id', 'name', 'version', 'description', 'engines', 'runtime'],
  additionalProperties: false,
  properties: {
    $schema: { type: 'string' },
    manifestVersion: { const: 1 },
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*(\\.[a-z0-9][a-z0-9-]*)+$', maxLength: 64 },
    name: { type: 'string', minLength: 1, maxLength: 60 },
    version: { type: 'string', minLength: 1 },
    description: { type: 'string', minLength: 1, maxLength: 300 },
    publisher: { type: 'string' },
    license: { type: 'string' },
    homepage: { type: 'string' },
    engines: {
      type: 'object', required: ['helm', 'protocol'], additionalProperties: false,
      properties: { helm: { type: 'string' }, protocol: { type: 'string' } },
    },
    runtime: {
      type: 'object', required: ['type'], additionalProperties: false,
      properties: {
        type: { enum: ['node', 'python', 'exec'] },
        entry: { type: 'string' },
        command: { type: 'array', items: { type: 'string' }, minItems: 1 },
      },
    },
    activation: { type: 'array', items: { enum: ['onTool', 'onCommand', 'onSession', 'onStartup', 'onProvider'] } },
    permissions: {
      type: 'array',
      items: {
        type: 'object', required: ['id', 'reason'], additionalProperties: false,
        properties: {
          id: { type: 'string' },
          scope: { type: 'array', items: { type: 'string', minLength: 1 } },
          reason: { type: 'string', minLength: 3, maxLength: 200 },
          optional: { type: 'boolean' },
          userExtensible: { type: 'boolean' },
        },
      },
    },
    contributes: {
      type: 'object', additionalProperties: false,
      properties: {
        tools: {
          type: 'array',
          items: {
            type: 'object', required: ['name', 'description', 'effect', 'inputSchema'], additionalProperties: false,
            properties: {
              name: { type: 'string', pattern: NAME }, title: { type: 'string' },
              description: { type: 'string', minLength: 5, maxLength: 1024 },
              effect: { enum: ['read', 'write', 'external', 'exec'] },
              requires: { type: 'array', items: { type: 'string' } },
              approval: { enum: ['auto', 'ask'] },
              inputSchema: schemaObj,
              timeoutMs: { type: 'integer', minimum: 100, maximum: 600000 },
            },
          },
        },
        commands: {
          type: 'array',
          items: {
            type: 'object', required: ['name', 'title'], additionalProperties: false,
            properties: { name: { type: 'string', pattern: NAME }, title: { type: 'string' }, description: { type: 'string' }, args: schemaObj, requires: { type: 'array', items: { type: 'string' } } },
          },
        },
        hooks: {
          type: 'array',
          items: {
            type: 'object', required: ['event', 'mode'], additionalProperties: false,
            properties: {
              event: { type: 'string' }, mode: { enum: ['watch', 'intercept'] },
              priority: { type: 'integer' }, onError: { enum: ['continue', 'block'] },
              timeoutMs: { type: 'integer', minimum: 50, maximum: 30000 },
            },
          },
        },
        panels: {
          type: 'array',
          items: { type: 'object', required: ['id', 'title'], additionalProperties: false, properties: { id: { type: 'string', pattern: NAME }, title: { type: 'string' }, description: { type: 'string' } } },
        },
        providers: {
          type: 'array',
          items: {
            type: 'object', required: ['id', 'title'], additionalProperties: false,
            properties: { id: { type: 'string', pattern: NAME }, title: { type: 'string' }, description: { type: 'string' }, defaultModel: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 1000, maximum: 900000 } },
          },
        },
        configuration: schemaObj,
      },
    },
    limits: {
      type: 'object', additionalProperties: false,
      properties: {
        callTimeoutMs: { type: 'integer', minimum: 100, maximum: 900000 },
        activationTimeoutMs: { type: 'integer', minimum: 100, maximum: 120000 },
        maxConcurrency: { type: 'integer', minimum: 1, maximum: 64 },
        memoryMb: { type: 'integer', minimum: 32, maximum: 8192 },
        idleTimeoutMs: { type: 'integer', minimum: 1000 },
      },
    },
  },
} as const;

const validateSchema = ajv.compile(manifestSchema);

export interface ManifestProblem {
  path: string;
  message: string;
  hint?: string;
  severity: 'error' | 'warning';
}

function fromAjv(e: ErrorObject): ManifestProblem {
  const at = e.instancePath || '/';
  let message = e.message ?? 'is invalid';
  let hint: string | undefined;
  if (e.keyword === 'additionalProperties') {
    const prop = (e.params as { additionalProperty: string }).additionalProperty;
    message = `unknown field "${prop}"`;
    hint = 'Remove it or check the spelling against docs/manifest-reference.md.';
  } else if (e.keyword === 'required') {
    message = `missing required field "${(e.params as { missingProperty: string }).missingProperty}"`;
  } else if (e.keyword === 'enum') {
    message = `must be one of: ${(e.params as { allowedValues: unknown[] }).allowedValues.join(', ')}`;
  } else if (e.keyword === 'pattern' && at === '/id') {
    hint = 'Use publisher.name in lowercase, e.g. "acme.notes".';
  } else if (e.keyword === 'pattern') {
    hint = 'Names use lowercase letters, digits and underscores, starting with a letter.';
  }
  return { path: at, message, hint, severity: 'error' };
}

/** Structural (JSON Schema) and semantic validation of a manifest object. */
export function validateManifest(raw: unknown, pluginDir?: string): { manifest?: Manifest; problems: ManifestProblem[] } {
  const problems: ManifestProblem[] = [];
  const schemaOk = validateSchema(raw);
  if (!schemaOk) {
    for (const e of validateSchema.errors ?? []) problems.push(fromAjv(e));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { problems };
  }
  const m = raw as unknown as Manifest;
  const err = (p: string, message: string, hint?: string) => problems.push({ path: p, message, hint, severity: 'error' });
  const warn = (p: string, message: string, hint?: string) => problems.push({ path: p, message, hint, severity: 'warning' });
  // Semantic checks also run when the schema failed, so authors see every problem in one pass;
  // malformed shapes the schema already reported may make them throw, which we ignore.
  try {
  if (!semver.valid(m.version)) err('/version', `"${m.version}" is not a valid semver version`, 'Use MAJOR.MINOR.PATCH, e.g. "1.0.0".');
  if (!semver.validRange(m.engines.helm)) err('/engines/helm', `"${m.engines.helm}" is not a valid semver range`, 'e.g. ">=0.1.0 <1.0.0"');
  if (!semver.validRange(m.engines.protocol.replace(/^(\^|~)?(\d+)\.(\d+)$/, '$1$2.$3.0'))) err('/engines/protocol', `"${m.engines.protocol}" is not a valid range`, 'e.g. "^1.0"');

  if (m.runtime.type === 'exec') {
    if (!m.runtime.command) err('/runtime/command', 'runtime "exec" needs a "command" array', 'e.g. ["./bin/my-plugin"]');
  } else if (!m.runtime.entry) {
    err('/runtime/entry', `runtime "${m.runtime.type}" needs an "entry" file`, m.runtime.type === 'node' ? 'e.g. "src/index.ts"' : 'e.g. "main.py"');
  }
  if (pluginDir && m.runtime.entry) {
    const entry = path.resolve(pluginDir, m.runtime.entry);
    if (!entry.startsWith(path.resolve(pluginDir) + path.sep)) err('/runtime/entry', 'entry must stay inside the plugin folder');
    else if (!fs.existsSync(entry)) err('/runtime/entry', `entry file "${m.runtime.entry}" does not exist`);
  }

  const declared = new Map<string, number>();
  (m.permissions ?? []).forEach((p, i) => {
    const def = PERMISSIONS[p.id];
    if (!def) {
      err(`/permissions/${i}/id`, `unknown permission "${p.id}"`, `Known permissions: ${Object.keys(PERMISSIONS).join(', ')}`);
      return;
    }
    if (declared.has(p.id)) err(`/permissions/${i}`, `permission "${p.id}" is declared twice`);
    declared.set(p.id, i);
    if (def.scopeKind !== 'none' && (!p.scope || p.scope.length === 0)) err(`/permissions/${i}/scope`, `"${p.id}" needs a scope`, def.scopeKind === 'path' ? 'e.g. ["${workspace}"]' : def.scopeKind === 'host' ? 'e.g. ["api.example.com"]' : undefined);
    if (def.scopeKind === 'none' && p.scope) warn(`/permissions/${i}/scope`, `"${p.id}" does not take a scope; it will be ignored`);
    if (def.scopeKind === 'command') for (const c of p.scope ?? []) if (c.includes('/') || c.includes(' ')) err(`/permissions/${i}/scope`, `command "${c}" must be a bare program name`, 'Helm resolves it on PATH, e.g. "git".');
  });

  const c = m.contributes ?? {};
  const checkRequires = (where: string, req?: string[]) => {
    for (const r of req ?? []) if (!declared.has(r)) err(where, `requires "${r}" but the manifest does not declare that permission`, 'Add it to "permissions" with a reason.');
  };
  const unique = (kind: string, items: Array<{ name?: string; id?: string }> | undefined) => {
    const seen = new Set<string>();
    (items ?? []).forEach((t, i) => {
      const n = t.name ?? t.id ?? '';
      if (seen.has(n)) err(`/contributes/${kind}/${i}`, `duplicate ${kind.slice(0, -1)} "${n}"`);
      seen.add(n);
    });
  };
  unique('tools', c.tools); unique('commands', c.commands); unique('panels', c.panels); unique('providers', c.providers);
  (c.tools ?? []).forEach((t, i) => {
    checkRequires(`/contributes/tools/${i}/requires`, t.requires);
    if ((t.inputSchema as { type?: string }).type !== 'object') err(`/contributes/tools/${i}/inputSchema`, 'inputSchema must have type "object"');
    else {
      try { ajv.compile(t.inputSchema); } catch (e) { err(`/contributes/tools/${i}/inputSchema`, `invalid JSON Schema: ${(e as Error).message}`); }
    }
    if ((t.effect === 'write' || t.effect === 'exec') && !t.requires?.length) warn(`/contributes/tools/${i}`, `"${t.name}" has effect "${t.effect}" but requires no permission`);
  });
  (c.commands ?? []).forEach((cmd, i) => checkRequires(`/contributes/commands/${i}/requires`, cmd.requires));
  (c.hooks ?? []).forEach((h, i) => {
    if (!HOOK_EVENTS.includes(h.event) && !h.event.startsWith('plugin.')) err(`/contributes/hooks/${i}/event`, `unknown event "${h.event}"`, `Known events: ${HOOK_EVENTS.join(', ')}, or plugin.<id>.<name>`);
    if (h.mode === 'intercept' && !['tool.before', 'tool.after'].includes(h.event)) err(`/contributes/hooks/${i}/mode`, `"${h.event}" cannot be intercepted`, 'Only tool.before and tool.after support mode "intercept".');
    if (h.mode === 'intercept' && !declared.has('tool.intercept')) err(`/contributes/hooks/${i}`, 'intercept hooks need the "tool.intercept" permission');
    if (['message.user', 'model.response'].includes(h.event) && !declared.has('conversation.read')) err(`/contributes/hooks/${i}`, `"${h.event}" needs the "conversation.read" permission`);
  });
  if (c.configuration) {
    try { ajv.compile(c.configuration); } catch (e) { err('/contributes/configuration', `invalid JSON Schema: ${(e as Error).message}`); }
  }
  const hasAny = (c.tools?.length ?? 0) + (c.commands?.length ?? 0) + (c.hooks?.length ?? 0) + (c.panels?.length ?? 0) + (c.providers?.length ?? 0);
  if (!hasAny) warn('/contributes', 'the plugin contributes nothing (no tools, commands, hooks, panels or providers)');
  } catch (e) {
    if (schemaOk) throw e;
  }
  const seen = new Set<string>();
  const unique = problems.filter((p) => { const k = `${p.path}|${p.message}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return { manifest: !schemaOk || unique.some((p) => p.severity === 'error') ? undefined : m, problems: unique };
}

export function readManifest(pluginDir: string): { manifest?: Manifest; problems: ManifestProblem[] } {
  const file = path.join(pluginDir, MANIFEST_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { problems: [{ path: '/', severity: 'error', message: code === 'ENOENT' ? `no ${MANIFEST_FILE} found in ${pluginDir}` : `${MANIFEST_FILE} is not valid JSON: ${(e as Error).message}`, hint: code === 'ENOENT' ? 'Create one with `helm plugin new <name>`.' : undefined }] };
  }
  return validateManifest(raw, pluginDir);
}

/** Returns a human-readable reason if the plugin can't run on this host, else undefined. */
export function compatibilityProblem(m: Manifest, hostVersion = HOST_VERSION, protocolVersion = PROTOCOL_VERSION): string | undefined {
  if (!semver.satisfies(hostVersion, m.engines.helm, { includePrerelease: true })) {
    return `requires Helm ${m.engines.helm}, but this is Helm ${hostVersion}`;
  }
  const proto = semver.coerce(protocolVersion)!.version;
  const range = m.engines.protocol.replace(/^(\^|~)?(\d+)\.(\d+)$/, '$1$2.$3.0');
  if (!semver.satisfies(proto, range)) return `speaks plugin protocol ${m.engines.protocol}, but this host speaks ${protocolVersion}`;
  return undefined;
}

export function formatProblems(problems: ManifestProblem[]): string {
  return problems
    .map((p) => `  ${p.severity === 'error' ? '✖' : '⚠'} ${p.path}: ${p.message}${p.hint ? `\n      → ${p.hint}` : ''}`)
    .join('\n');
}

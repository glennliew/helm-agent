// Stable error codes shared by host, CLI, web console and plugins.
// Every code carries a plain-language explanation and a suggested next step,
// so users can understand what happened when a plugin fails.

export const ErrorCode = {
  PLUGIN_NOT_FOUND: 'PLUGIN_NOT_FOUND',
  MANIFEST_INVALID: 'MANIFEST_INVALID',
  INCOMPATIBLE_VERSION: 'INCOMPATIBLE_VERSION',
  ISOLATION_UNAVAILABLE: 'ISOLATION_UNAVAILABLE',
  ACTIVATION_TIMEOUT: 'ACTIVATION_TIMEOUT',
  ACTIVATION_FAILED: 'ACTIVATION_FAILED',
  CALL_TIMEOUT: 'CALL_TIMEOUT',
  PLUGIN_CRASHED: 'PLUGIN_CRASHED',
  PLUGIN_QUARANTINED: 'PLUGIN_QUARANTINED',
  PLUGIN_DISABLED: 'PLUGIN_DISABLED',
  MEMORY_LIMIT: 'MEMORY_LIMIT',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  PERMISSION_REVOKED: 'PERMISSION_REVOKED',
  INPUT_INVALID: 'INPUT_INVALID',
  RESULT_TOO_LARGE: 'RESULT_TOO_LARGE',
  PROTOCOL_ERROR: 'PROTOCOL_ERROR',
  CONFIG_INVALID: 'CONFIG_INVALID',
  RATE_LIMITED: 'RATE_LIMITED',
  CANCELLED: 'CANCELLED',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  NO_PROVIDER: 'NO_PROVIDER',
  TOOL_ERROR: 'TOOL_ERROR',
  INSTALL_FAILED: 'INSTALL_FAILED',
  CONSENT_REQUIRED: 'CONSENT_REQUIRED',
  INTERNAL: 'INTERNAL',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorInfo {
  title: string;
  hint: string;
}

const CATALOG: Record<ErrorCode, ErrorInfo> = {
  PLUGIN_NOT_FOUND: { title: 'Plugin not found', hint: 'Check the id with `helm plugin list --all` or `helm plugin search`.' },
  MANIFEST_INVALID: { title: 'The plugin manifest is invalid', hint: 'Run `helm plugin validate <path>` to see every problem with a suggested fix.' },
  INCOMPATIBLE_VERSION: { title: 'The plugin is not compatible with this version of Helm', hint: 'Update the plugin (`helm plugin update <id>`) or install a version whose `engines` range matches this host.' },
  ISOLATION_UNAVAILABLE: { title: 'The plugin cannot run with full sandbox isolation here', hint: 'Run Helm from a normal terminal (not inside another sandbox), or explicitly trust the plugin with `helm plugin trust <id>` to run it with reduced isolation.' },
  ACTIVATION_TIMEOUT: { title: 'The plugin did not finish starting in time', hint: 'Check `helm plugin logs <id>`. Slow start-up work should move out of activate(), or raise limits.activationTimeoutMs.' },
  ACTIVATION_FAILED: { title: 'The plugin failed while starting', hint: 'See the stderr lines below or `helm plugin logs <id>`; fix the plugin and run `helm plugin reset <id>`.' },
  CALL_TIMEOUT: { title: 'The plugin did not answer in time', hint: 'The call was cancelled. Retry, or raise the limit with `helm plugin limit <id> callTimeoutMs <ms>`.' },
  PLUGIN_CRASHED: { title: 'The plugin process crashed', hint: 'Helm restarts it automatically on next use. See `helm plugin logs <id>` for the cause.' },
  PLUGIN_QUARANTINED: { title: 'The plugin crashed repeatedly and was quarantined', hint: 'Its tools are hidden from the agent. Fix the cause shown in `helm plugin logs <id>`, then run `helm plugin reset <id>`.' },
  PLUGIN_DISABLED: { title: 'The plugin is disabled', hint: 'Enable it with `helm plugin enable <id>`.' },
  MEMORY_LIMIT: { title: 'The plugin exceeded its memory limit and was stopped', hint: 'Raise limits.memoryMb in the plugin config if this is expected, or report a leak to the plugin author.' },
  PERMISSION_DENIED: { title: 'The plugin tried to do something it was not granted', hint: 'Review with `helm plugin permissions <id>`; grant with `helm plugin grant <id> <permission>` if you agree.' },
  PERMISSION_REVOKED: { title: 'The permission was revoked', hint: 'Grant it again with `helm plugin grant <id> <permission>` if you want the feature back.' },
  INPUT_INVALID: { title: 'The input did not match the expected schema', hint: 'Check the arguments against the tool or command schema shown by `helm plugin info <id>`.' },
  RESULT_TOO_LARGE: { title: 'The plugin returned more data than allowed', hint: 'Ask for a narrower result (e.g. a smaller file range).' },
  PROTOCOL_ERROR: { title: 'The plugin broke the Helm protocol', hint: 'Usually stray output on stdout. Plugins must log to stderr; the SDKs do this automatically.' },
  CONFIG_INVALID: { title: 'The configuration value is invalid', hint: 'See the schema with `helm plugin config <id>`.' },
  RATE_LIMITED: { title: 'The plugin is calling the host too fast', hint: 'This protects the host; the plugin should batch its work.' },
  CANCELLED: { title: 'The operation was cancelled', hint: '' },
  NOT_IMPLEMENTED: { title: 'The plugin does not implement this', hint: 'The manifest declares something the code does not handle. Report it to the plugin author.' },
  PROVIDER_ERROR: { title: 'The model provider returned an error', hint: 'Check the provider plugin logs and your API key (`helm secrets list <id>`).' },
  NO_PROVIDER: { title: 'No model provider is available', hint: 'Install and enable a provider plugin (`helm plugin search provider`), then `helm provider use <plugin>/<provider>`.' },
  TOOL_ERROR: { title: 'The tool reported an error', hint: '' },
  INSTALL_FAILED: { title: 'Installation failed', hint: 'Nothing was changed. Fix the problem above and retry.' },
  CONSENT_REQUIRED: { title: 'Your consent is required', hint: 'Re-run interactively, or pass --yes / --grant to accept the requested permissions.' },
  INTERNAL: { title: 'Internal Helm error', hint: 'This is a bug in Helm itself, not the plugin.' },
};

export function explain(code: string): ErrorInfo {
  return (CATALOG as Record<string, ErrorInfo>)[code] ?? { title: code, hint: '' };
}

export class HelmError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly hint?: string;
  constructor(code: ErrorCode, message?: string, opts: { details?: unknown; hint?: string; cause?: unknown } = {}) {
    super(message ?? explain(code).title, { cause: opts.cause });
    this.name = 'HelmError';
    this.code = code;
    this.details = opts.details;
    this.hint = opts.hint;
  }
  toJSON() {
    return { code: this.code, message: this.message, hint: this.hint ?? explain(this.code).hint, details: this.details };
  }
}

export function toHelmError(err: unknown, fallback: ErrorCode = ErrorCode.INTERNAL): HelmError {
  if (err instanceof HelmError) return err;
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
    const e = err as { code: string; message?: string; data?: unknown; hint?: string };
    if (e.code in CATALOG) return new HelmError(e.code as ErrorCode, e.message, { details: e.data, hint: e.hint });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new HelmError(fallback, message, { cause: err });
}

/** Replace `<id>` placeholders in hints with the concrete plugin id. */
export function hintFor(code: string, pluginId?: string): string {
  const h = explain(code).hint;
  return pluginId ? h.replaceAll('<id>', pluginId) : h;
}

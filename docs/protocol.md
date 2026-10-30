# Host ↔ plugin protocol, version 1.0

The SDKs are conveniences. This document is the contract. A plugin is a child process that speaks **JSON-RPC 2.0 over stdio, one JSON message per line** (NDJSON, UTF-8). Any language works. [`tests/fixtures/plugins/sh-raw/plugin.sh`](../tests/fixtures/plugins/sh-raw/plugin.sh) is a complete plugin in 20 lines of POSIX shell, and it passes the same tests as the SDK plugins.

## Transport

| Rule | Detail |
| --- | --- |
| Framing | One JSON-RPC message per line on **stdout** (plugin → host) and **stdin** (host → plugin). No `Content-Length` headers, no batches. |
| stdout | Protocol only. Up to 20 non-JSON lines are tolerated and logged; after that the plugin is stopped with `PROTOCOL_ERROR`. SDKs redirect `console.log` and `print` to stderr. |
| stderr | Free-form logging. Captured into `helm plugin logs <id>`, and its tail appears in crash reports. |
| Size | A line longer than 8 MB is a protocol violation. The host also bounds tool results it passes to the model. |
| Ids | Host request ids are strings (`"h1"`, `"h2"`, …). Plugin request ids may be numbers or strings. Echo ids back verbatim. |
| Errors | Helm errors use JSON-RPC code `-32000` with `data: { code, hint?, details? }`, where `code` is a [Helm error code](#error-codes). `-32601` (method not found) maps to `NOT_IMPLEMENTED`. |

## Lifecycle

```
host                                   plugin
 │ spawn (sandbox-exec … / node --permission … / python3 -u …)
 │──── initialize {protocolVersion, host, plugin, workspace, config, grants, isolation} ──▶
 │◀─── result {protocolVersion, capabilities} ────────────────────────────────────────────│
 │──── tool/invoke | command/run | hook/dispatch | panel/render | provider/* ──────────▶ │  (≤ maxConcurrency at once)
 │◀─── host/fs.read | host/net.fetch | … (plugin → host requests, checked by the broker) ─│
 │──── $/cancelRequest {id} (user cancelled, or the deadline passed) ──────────────────▶ │
 │──── $/ping (only after a timed-out call, to detect a wedged process) ────────────────▶ │
 │──── config/didChange {config} (notification) ─────────────────────────────────────▶ │
 │──── shutdown (request, 2 s) ───────────────────────────────────────────────────────▶ │
 │──── exit (notification); SIGTERM, then SIGKILL if still running ───────────────────▶ │
```

### `initialize` (host → plugin, request)

Sent once, immediately after spawn. It must be answered within `limits.activationTimeoutMs` (default 10 s), or start-up fails with `ACTIVATION_TIMEOUT`.

```json
{"jsonrpc":"2.0","id":"h1","method":"initialize","params":{
  "protocolVersion":"1.0",
  "host":{"name":"helm","version":"0.1.0"},
  "plugin":{"id":"acme.word-tools","version":"0.1.0","dataDir":"/Users/me/.helm-agent/data/acme.word-tools/files"},
  "workspace":"/Users/me/project",
  "config":{"greeting":"Hello"},
  "grants":[{"id":"fs.read","scope":["/Users/me/project"]}],
  "isolation":"strict"}}
```

`config` already has defaults applied. `grants` has scope variables expanded. `isolation` is `strict` (OS sandbox), `runtime` (Node permission model and broker) or `basic` (broker only, trusted plugins).

Reply with the protocol version you speak and the handlers you implement:

```json
{"jsonrpc":"2.0","id":"h1","result":{"protocolVersion":"1.0","capabilities":{
  "tools":["count_lines"],"commands":["about"],"hooks":[],"panels":[],"providers":[]}}}
```

A different **major** version fails with `INCOMPATIBLE_VERSION`. The host compares `capabilities` with the manifest and logs a warning for anything declared but not implemented, or implemented but not declared. Calls to a declared but unimplemented handler fail with `NOT_IMPLEMENTED`.

### `shutdown` and `exit`

`shutdown` (request, empty params) asks the plugin to finish up: the SDKs run `deactivate()` here. `exit` (notification) means exit now. A process still running a moment later is terminated.

## Host → plugin requests

| Method | Params | Result |
| --- | --- | --- |
| `tool/invoke` | `{tool, input, callId, sessionId?}`. `input` has been validated against the tool's `inputSchema`. | `ToolResult` |
| `command/run` | `{command, args}`. `args` validated against the command's schema. | `{content?: ContentBlock[], ui?: UINode}` |
| `panel/render` | `{panel}` | `{ui: UINode}` |
| `hook/dispatch` | `{event, payload}`. Sent as a **request** for intercept hooks and a **notification** for watch hooks. | `HookResult` (intercept only) |
| `provider/complete` | `{provider, model, messages: ChatMessage[], tools: ProviderToolDef[], options}` | `ProviderResult` |
| `provider/models` | `{provider}` | `{models: [{id, name?, contextLength?, …}]}` |
| `$/ping` | `{}` | anything (`null`) |

Notifications from host to plugin: `$/cancelRequest {id}` (abort the request with that id; reply with an error, or not at all), `config/didChange {config}`, `exit`.

### Types

```ts
type ContentBlock = { type: 'text'; text: string } | { type: 'markdown'; text: string } | { type: 'json'; data: unknown };
interface ToolResult { content: ContentBlock[]; isError?: boolean }   // isError: tool ran but failed; the model sees it

type HookResult =
  | { action: 'continue' }
  | { action: 'block'; reason: string }
  | { action: 'ask'; reason: string }                                  // the user decides
  | { action: 'modify'; input?: object; output?: ToolResult; reason?: string };

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: { id: string; name: string; arguments: object }[]; providerData?: unknown }
  | { role: 'tool'; toolCallId: string; name: string; content: string };
interface ProviderToolDef { name: string; description: string; parameters: JSONSchema }
interface ProviderResult {
  message: { content: string | null; toolCalls?: ToolCall[]; providerData?: unknown };   // providerData is round-tripped untouched
  model?: string; finishReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}
```

`providerData` lets a provider carry opaque state between turns. The OpenRouter plugin uses it to preserve `reasoning_details` across tool calls. The host stores it in the transcript and passes it back on the next `provider/complete`.

UI trees (`UINode`) are plain JSON: `{type:'stack', children}`, `{type:'heading', text}`, `{type:'text', text, tone?}`, `{type:'markdown', text}`, `{type:'keyValue', items:[{key, value}]}`, `{type:'table', columns, rows}`, `{type:'list', items}`, `{type:'badge', text, tone?}`, `{type:'button', label, command, args?}`. They are rendered by the CLI and the console. They are never executed.

### Hook payloads

Every payload has `sessionId`. Tool events also carry `tool`, `plugin`, `exposedName` and `effect`.

| Event | Extra fields | Interceptable |
| --- | --- | --- |
| `session.start` | `workspace` | no |
| `session.end` | `messages` (count) | no |
| `message.user` | `text` | no. Needs `conversation.read`. |
| `model.response` | `text`, `toolCalls` (names) | no. Needs `conversation.read`. |
| `tool.before` | `input` | yes |
| `tool.after` | `input`, `output`, `ok`, `durationMs` | yes |
| `tool.error` | `input`, `error: {code, message}` | no |
| `plugin.state` | `plugin`, `from`, `to`, `reason?`, `code?`. Delivered only to watchers that are already running, and never about the watcher itself. | no |
| `plugin.<id>.<name>` | `source` (emitting plugin id), `payload`. Emitted by another plugin with `host/events.emit`, and never delivered back to the emitter. | no |

Watch hooks of a plugin **without** `conversation.read` receive tool events with `input`, `output` and `text` removed, and a `redacted: [...]` list naming what was removed.

## Plugin → host requests

Each request is checked by the permission broker against the plugin's grants **at the moment of the call** (revocation is immediate) and recorded in the audit log. A denial is a `-32000` error with `data.code: "PERMISSION_DENIED"` and a message naming the permission, the target and the granted scope.

| Method | Params | Result | Permission |
| --- | --- | --- | --- |
| `host/workspace.info` | `{}` | `{workspace, pluginData}` | none |
| `host/fs.read` | `{path, encoding?: 'utf8'\|'base64', maxBytes?}` | `{path, content, size, truncated}` | `fs.read` |
| `host/fs.list` | `{path}` | `{path, entries:[{name, type, size}], truncated}` | `fs.read` |
| `host/fs.stat` | `{path}` | `{path, exists, type?, size?, mtimeMs?}` | `fs.read` |
| `host/fs.write` | `{path, content, encoding?, createDirs?}` | `{path, bytes}` | `fs.write` |
| `host/fs.mkdir` | `{path}` | `{path}` | `fs.write` |
| `host/fs.remove` | `{path, recursive?}` | `{path}` | `fs.write` |
| `host/net.fetch` | `{url, method?, headers?, body?, timeoutMs?, maxBytes?}` | `{status, headers, body, encoding, url, truncated}` | `net.http` (+ `net.local`) |
| `host/process.exec` | `{command, args?, cwd?, timeoutMs?, input?, env?}` | `{code, signal, stdout, stderr, timedOut, sandboxed}` | `process.exec` |
| `host/secrets.get` | `{name}` | `{value}` | `secrets` |
| `host/storage.get` / `set` / `delete` / `list` | `{key}` / `{key, value}` / `{key}` / `{}` | `{value}` / `{ok}` / `{ok}` / `{keys}`. Up to 5 MB per plugin. | none |
| `host/llm.complete` | `{messages, maxTokens?}` | `{content, model}` | `llm.invoke` |
| `host/events.emit` | `{name, payload?}` | `{event}`: the full name, `plugin.<id>.<name>` | none |

Relative paths resolve against the workspace. Paths are canonicalized, with symlinks resolved, before the scope check. `process.exec` takes a bare program name, never a path. Requests are rate-limited per plugin (`RATE_LIMITED`).

Notifications from plugin to host (no reply): `host/log {level, message}`, `host/progress {callId, message}`, `host/ui.notify {level, message}`, `host/ui.refresh {panel?}`.

## Timeouts, cancellation and failure

- Each host request has a deadline: the tool's `timeoutMs`, else `limits.callTimeoutMs` (30 s). Panels get 10 s, providers 180 s, model listing 60 s, intercept hooks 2 s and watch hooks 5 s. When it expires the host sends `$/cancelRequest` and fails the call with `CALL_TIMEOUT`. It then sends `$/ping`, and a plugin that doesn't answer within 2 s is considered wedged, killed and restarted on next use.
- If the process exits or crashes, every in-flight call fails with `PLUGIN_CRASHED`, including the stderr tail. The next call starts a fresh process. Three crashes within five minutes **quarantine** the plugin until the user runs `helm plugin reset <id>`.
- Memory above `limits.memoryMb` (RSS watchdog; V8 heap cap for Node) stops the plugin with `MEMORY_LIMIT`.
- None of this affects the host or other plugins: each plugin is its own process with its own queue.

## Error codes

`PLUGIN_NOT_FOUND`, `MANIFEST_INVALID`, `INCOMPATIBLE_VERSION`, `ISOLATION_UNAVAILABLE`, `ACTIVATION_TIMEOUT`, `ACTIVATION_FAILED`, `CALL_TIMEOUT`, `PLUGIN_CRASHED`, `PLUGIN_QUARANTINED`, `PLUGIN_DISABLED`, `MEMORY_LIMIT`, `PERMISSION_DENIED`, `PERMISSION_REVOKED`, `INPUT_INVALID`, `RESULT_TOO_LARGE`, `PROTOCOL_ERROR`, `CONFIG_INVALID`, `RATE_LIMITED`, `CANCELLED`, `NOT_IMPLEMENTED`, `PROVIDER_ERROR`, `NO_PROVIDER`, `TOOL_ERROR`, `INSTALL_FAILED`, `CONSENT_REQUIRED`, `INTERNAL`.

`helm explain <CODE>` prints what each means and what to do. Plugins may return any of them, and `TOOL_ERROR`, `INPUT_INVALID` and `NOT_IMPLEMENTED` are the usual ones.

## A complete exchange

What `helm plugin dev` shows with `trace on`, for the shell plugin:

```
→ {"jsonrpc":"2.0","id":"h1","method":"initialize","params":{"protocolVersion":"1.0",…}}
← {"jsonrpc":"2.0","id":"h1","result":{"protocolVersion":"1.0","capabilities":{"tools":["shout"],"commands":[],"hooks":[],"panels":[],"providers":[]}}}
→ {"jsonrpc":"2.0","id":"h2","method":"tool/invoke","params":{"tool":"shout","input":{"text":"ahoy"},"callId":"dev-1"}}
← {"jsonrpc":"2.0","id":"h2","result":{"content":[{"type":"text","text":"ahoy! (from sh)"}]}}
→ {"jsonrpc":"2.0","id":"h3","method":"shutdown","params":{}}
← {"jsonrpc":"2.0","id":"h3","result":null}
→ {"jsonrpc":"2.0","method":"exit","params":{}}
```

## Versioning

The protocol version is `major.minor`. Minor versions only add things: new optional fields, methods and events. Plugins must ignore unknown fields and reply `-32601` to unknown methods. A major version change is breaking, and a plugin declares the range it supports with `engines.protocol`.

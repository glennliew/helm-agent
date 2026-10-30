# Helm: a local AI agent harness with plugins (implementation plan, v1)

> Status: **draft for your review.** I won't write any code until you approve this plan or ask for changes. Section 18 lists the decisions I need from you, with the defaults I'll use if you just say "go".

## 0. Summary

Helm is a local agent harness. It runs an LLM agent loop on your machine. By itself the agent can only talk; plugins add every other capability. Plugins are separate processes that speak a documented protocol (JSON-RPC 2.0 over stdio), so they can be written in any language. Each plugin ships a manifest that declares what it contributes and which permissions it needs. The host checks the manifest, asks the user for consent, then starts the plugin in a sandbox. It controls every privileged operation through a permission broker and supervises the plugin process for crashes, hangs and runaway memory. A failing plugin only takes itself down, never the host.

The product is a **CLI (`helm`) plus a local web console (`helm serve`)**. Both use the same core library. I'll ship **three sample plugins** that work in different ways: a TypeScript file-tools plugin (tools, file-scoped permissions), a Python web plugin (network broker, secrets, a second language), and a TypeScript guardrails plugin that adds no tools at all. Instead it changes how the host behaves, through hooks, commands and a UI panel. I'll also ship a set of deliberately broken "fixture" plugins to prove the failure handling works.

### What I checked on your Mac before writing this

| Check | Result | Effect on the design |
| --- | --- | --- |
| OS | macOS 26.5.1, arm64 | macOS is the main target; Linux/Windows run with reduced isolation |
| Node | v26.8.1 (npm 11.19) | Helm runs TypeScript directly; no build step |
| Node permission model | `--permission`, `--allow-fs-read/-write`, `--allow-net`, `--allow-child-process`, `--allow-worker` all present. Blocked file reads and child processes confirmed (`ERR_ACCESS_DENIED`) | Second enforcement layer for Node plugins |
| `sandbox-exec` | Present. Blocked a file read in `~/Documents` and an outbound Python socket (`EPERM`) | Main OS-level enforcement layer on macOS |
| Nested sandboxes | `sandbox-exec` fails with `sandbox_apply: Operation not permitted` inside an already-sandboxed terminal (such as the one I run commands in) | Helm must detect this and fall back loudly (§7.4). I'll run the OS-layer tests with elevated permission |
| Python | 3.10.11 (+ `uv` 0.9.3) | The Python SDK will need only the standard library and support Python 3.9+ |
| LLM access | No OpenAI/Anthropic keys in the environment; no Ollama/LM Studio running | A deterministic mock provider for tests; a live test needs your key or endpoint (§18) |
| Docker | 29.4 present | Not a dependency (too heavy for a plugin sandbox). Listed as a possible later option |

## 1. Goals, non-goals and success criteria

**Goals.** (1) Users can discover, install, inspect, configure, enable, disable, update, roll back and uninstall plugins. When a plugin fails, they get an explanation in plain language. (2) Plugin developers follow one documented protocol, can scaffold a working plugin in one command, and can debug it with hot reload and an RPC trace. (3) Plugins add real host capabilities: agent tools, user commands, lifecycle and interception hooks, UI panels and configuration. The core never mentions any specific plugin. (4) One plugin crashing, hanging, leaking memory or being the wrong version cannot bring down the host or the session. (5) Plugins have no ambient authority: file, network, process, secret and conversation access must be declared, granted by the user, enforced and audited, and can be revoked.

**Non-goals for v1.** A hosted marketplace server; cryptographic publisher signing (I'll leave room for it with checksums); Windows OS sandboxing; multi-user or remote deployment; plugins calling each other's tools directly; plugins that supply LLM providers (an optional stretch, see §18).

**Success criteria.** These are the acceptance checks you can run yourself; the full list is in §15.

## 2. Product shape

| Surface | Purpose |
| --- | --- |
| `helm` CLI | Main interface: `chat`, `run`, `plugin *`, `config`, `secrets`, `audit`, `doctor`. Every command has `--json` output for scripting |
| `helm serve` | Local web console on `127.0.0.1`: chat with live tool-call cards and approval dialogs, plugin manager (install, toggle, config forms, permissions, logs, health), plugin panels, audit log |
| `packages/core` | Shared engine used by both surfaces. Nothing about any specific plugin is hard-coded in it |

The product is called **Helm** (the plan was written under the working name "Hearth"). Its home is `~/.helm-agent` rather than `~/.helm`, so it doesn't collide with Kubernetes Helm's files; the CLI is `bin/helm`. All state lives under `HELM_AGENT_HOME` (default `~/.helm-agent`). During development and in the demo I'll point it at a folder inside the project, so nothing touches your home directory.

## 3. Architecture

```
                 ┌──────────────────────────── Helm host (Node) ────────────────────────────┐
  user ──► CLI ──┤                                                                            │
  user ──► Web ──┤  Agent loop ──► Model provider (openai-compatible | mock)                   │
   console       │     │  ▲                                                                   │
                 │     ▼  │ tool results                                                      │
                 │  Contribution registry (tools · commands · hooks · panels · config)        │
                 │     │            ▲                                                         │
                 │  Event bus ──────┘          Plugin store (install/update/rollback, state)  │
                 │     │                                                                      │
                 │  Supervisor ── one per plugin: spawn · handshake · timeouts · watchdog ·   │
                 │     │          crash/backoff · circuit breaker · log capture               │
                 │     │                                                                      │
                 │  Permission broker ── grants · fs scopes · net policy · secrets · audit    │
                 └─────┼───────────────────────────────▲──────────────────────────────────────┘
                       │ JSON-RPC 2.0 (NDJSON on stdio) │ host/* calls (permission-checked)
          ┌────────────▼───────────┐       ┌────────────┴──────────┐      ┌───────────────────┐
          │ sandbox-exec profile    │       │ sandbox-exec profile   │      │ ...               │
          │  node --permission ...  │       │  python3 main.py       │      │                   │
          │  helm.files (TS)      │       │  helm.web (Python)   │      │  helm.guard (TS)│
          └─────────────────────────┘       └────────────────────────┘      └───────────────────┘
```

Each plugin runs in **its own OS process**, sandboxed and with a scrubbed environment. Plugins can't import the host and the host never loads plugin code into its own process. The only channel between them is the protocol. That one decision is what provides crash isolation, enforceable permissions and freedom of language.

## 4. Plugin model

### 4.1 Package layout

```
my-plugin/
├── helm-plugin.json     # manifest (required)
├── src/index.ts           # entry: Node runs .ts directly (Node ≥ 22.18); or main.py; or any executable
├── README.md              # shown by `helm plugin info --readme` and in the web console
├── CHANGELOG.md           # shown during `helm plugin update`
└── test/                  # optional; the SDK ships a test harness
```

Installing a plugin **never runs plugin code**: there are no install scripts and no `postinstall`. Plugins must be self-contained. That means only the standard library, vendored files, or a bundled single file. This closes the most common supply-chain attack route.

### 4.2 Manifest (`helm-plugin.json`)

A complete example for the file plugin:

```json
{
  "manifestVersion": 1,
  "id": "helm.files",
  "name": "Workspace Files",
  "version": "1.0.0",
  "description": "Lets the agent list, read, search and (with approval) write files in the session workspace.",
  "publisher": "helm",
  "license": "MIT",
  "engines": { "helm": ">=0.1.0 <1.0.0", "protocol": "^1.0" },
  "runtime": { "type": "node", "entry": "src/index.ts" },
  "activation": ["onTool", "onCommand"],
  "permissions": [
    { "id": "fs.read",  "scope": ["${workspace}"], "reason": "Read files you ask the agent about" },
    { "id": "fs.write", "scope": ["${workspace}"], "reason": "Create or edit files when you approve", "optional": true }
  ],
  "contributes": {
    "tools": [
      {
        "name": "read_file",
        "description": "Read a UTF-8 text file inside the workspace.",
        "effect": "read",
        "requires": ["fs.read"],
        "inputSchema": {
          "type": "object",
          "properties": { "path": { "type": "string" }, "maxBytes": { "type": "integer", "minimum": 1 } },
          "required": ["path"],
          "additionalProperties": false
        }
      },
      { "name": "write_file", "description": "...", "effect": "write", "requires": ["fs.write"], "approval": "ask", "inputSchema": { "...": "..." } }
    ],
    "commands": [
      { "name": "tree", "title": "Show workspace tree", "args": { "type": "object", "properties": { "depth": { "type": "integer", "default": 2 } } } }
    ],
    "configuration": {
      "type": "object",
      "properties": {
        "maxFileBytes": { "type": "integer", "default": 200000, "minimum": 1000, "description": "Largest file the agent may read" },
        "ignore": { "type": "array", "items": { "type": "string" }, "default": [".git", "node_modules"] }
      },
      "additionalProperties": false
    }
  },
  "limits": { "callTimeoutMs": 15000, "maxConcurrency": 4, "memoryMb": 256 }
}
```

Field rules (they'll be enforced by a JSON Schema, with error messages that name the exact field and suggest a fix):

| Field | Rule |
| --- | --- |
| `id` | `publisher.name`: lowercase letters, digits, `-`, `.`; unique; never changes |
| `version` | semver. `engines.helm` is a semver range for the host version; `engines.protocol` is the protocol range |
| `runtime.type` | `node` (entry `.js`/`.mjs`/`.ts`), `python` (entry `.py`, interpreter ≥ 3.9 found or configured), or `exec` (`command: [...]`, a binary in any language that speaks the protocol) |
| `activation` | When to start the process: `onTool`, `onCommand`, `onSession` (needed by hook plugins), `onStartup`. The host reads tools and commands from the manifest without starting the plugin, so startup stays fast |
| `permissions[]` | `id` from the catalog in §7.2, `scope` (may use `${workspace}`, `${pluginData}`, `${home}`, `${config.<key>}`), a `reason` the user sees, and `optional` |
| `tools[].effect` | `read` · `write` · `external` (talks to the outside world) · `exec`. This sets the default approval policy |
| `tools[].requires` | Permissions the tool needs. **If one isn't granted, the tool is hidden from the model** instead of failing every time it's called |
| `configuration` | JSON Schema. Generates the CLI validator and the web settings form. `"x-secret": true` marks fields that are stored in the secret store |
| `limits` | Requested limits. The host enforces its own maximums and the user can override them |

The model sees each tool under a namespaced name (`files__read_file`, which fits OpenAI's function-name rules). Name clashes are therefore impossible, and the host always knows which plugin owns a call.

### 4.3 Contribution points (what plugins can add to the host)

| Point | What it adds | Where it appears | Sample plugin that proves it |
| --- | --- | --- | --- |
| `tools` | Functions the agent can call (JSON-Schema input, content-block output) | The model's tool list; tool-call cards in CLI and web | files, web |
| `commands` | User-invoked actions with typed args | `helm cmd files.tree --depth 3`, `/files.tree` in chat, command palette in web | files, guard |
| `hooks` | Subscriptions to host events: watch only, or intercept (block, modify or force approval of a tool call) | Agent loop behaviour, audit | guard |
| `panels` | Declarative UI (heading, markdown, table, key-value, list, button → command) | Tab in the web console; `helm plugin panel <id> <panel>` renders it as text | guard |
| `configuration` | Typed settings with defaults, validated, live-reloaded | `helm plugin config`, web settings form | all three |
| custom events | `plugin.<id>.<name>` events other plugins can subscribe to | Event bus | guard (emits `plugin.helm.guard.blocked`) |

### 4.4 Lifecycle

```
            install/validate            enable              first use (activation event)
 (source) ───────────────► installed ─────────► enabled ─────────────────► starting
                              │  ▲                 │                          │ initialize OK
            incompatible ◄────┘  │ disable         │                          ▼
           (engines/protocol)    └─────────────────┤      idle timeout    ┌─► active ──► stopping ──► enabled (stopped)
                                                   │   ◄──────────────────┘     │
                                                   │                            │ crash / kill
                                                   │        backoff restart     ▼
                                                   └──────────────────────── crashed ──(3 in 5 min)──► quarantined
                                                                                                        (reset/enable clears)
```

Plugin-side lifecycle: `initialize` (handshake) → `activate` → (`config/didChange`, calls) → `shutdown` (gets a short grace period, then SIGTERM, then SIGKILL). The SDKs hide all of this behind `activate(ctx)` / `deactivate()`.

## 5. Host ↔ plugin protocol (v1.0)

The transport is **JSON-RPC 2.0, one JSON object per line (NDJSON) on stdin/stdout**. stderr is captured as the plugin's log. I chose this format because a plugin can implement it in about 50 lines in any language, it's easy to read in a trace, and it matches what developers already know from LSP and MCP. The protocol version is negotiated during the handshake.

**Host → plugin**

| Method | Kind | Purpose |
| --- | --- | --- |
| `initialize` | request | `{protocolVersion, host:{name,version}, plugin:{id,version,dataDir}, config, grants, workspace}` → `{protocolVersion, capabilities}` |
| `tool/invoke` | request | `{tool, input, callId, sessionId}` → `{content:[{type:"text"|"json"|"resource", ...}], isError?}` |
| `command/run` | request | `{command, args}` → content blocks |
| `hook/dispatch` | request (intercept) or notification (watch-only) | `{event, payload}` → `{action:"continue"|"block"|"modify"|"ask", reason?, patch?}` |
| `panel/render` | request | `{panel, state?}` → UI tree |
| `config/didChange` | notification | new validated config |
| `$/cancelRequest` | notification | cancel an in-flight request (timeout, user pressed Ctrl-C) |
| `$/ping` | request | health check used by the watchdog |
| `shutdown` → `exit` | request → notification | graceful stop |

**Plugin → host (the host API; every call is permission-checked and audited)**

| Method | Permission | Notes |
| --- | --- | --- |
| `host/fs.read`, `fs.list`, `fs.stat`, `fs.search` | `fs.read` + scope | Paths are canonicalised with `realpath`; `..` and symlink escapes are rejected |
| `host/fs.write`, `fs.mkdir`, `fs.delete` | `fs.write` + scope | Atomic writes |
| `host/net.fetch` | `net.http` + host allowlist | **The only way to reach the network.** DNS is resolved by the host; private, loopback and link-local IPs are blocked unless `net.local` is granted; redirects are re-checked; response size is capped |
| `host/process.exec` | `process.exec` + command allowlist | The host spawns the command (never a shell), inside the plugin's sandbox, with a timeout and an output cap |
| `host/secrets.get` | `secrets` + declared name | Never placed in env vars; values are redacted from logs, transcripts and audit |
| `host/storage.get/set/delete/list` | always allowed | The plugin's own key-value store; no other plugin can read it |
| `host/llm.complete` | `llm.invoke` | Uses the session's model, with a token budget |
| `host/events.emit` | always allowed (own namespace) | `plugin.<id>.*` only |
| `host/ui.notify`, `host/ui.refresh` | always allowed | Toast or console line; ask a panel to re-render |
| `host/log`, `host/progress` | notifications | Structured logs; progress shown on the tool-call card |

**Error codes** are stable and documented, and each has a message for users: `MANIFEST_INVALID`, `INCOMPATIBLE_VERSION`, `ACTIVATION_TIMEOUT`, `CALL_TIMEOUT`, `PLUGIN_CRASHED`, `PLUGIN_QUARANTINED`, `PERMISSION_DENIED`, `PERMISSION_REVOKED`, `INPUT_INVALID`, `RESULT_TOO_LARGE`, `PROTOCOL_ERROR`, `CONFIG_INVALID`, `RATE_LIMITED`, `CANCELLED`.

**Limits:** a message may be up to 4 MB. Tool output sent to the model is capped at 64 KB by default; anything larger is saved as an artifact and replaced by a summary plus a pointer. Each plugin has a concurrency cap (default 4) and a host-API rate limit (default 50 calls/s).

An example session as shown by `helm plugin dev --trace` (abridged):

```
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"1.0","host":{"name":"helm","version":"0.1.0"},...}}
← {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"1.0","capabilities":{"tools":true,"commands":true}}}
→ {"jsonrpc":"2.0","id":2,"method":"tool/invoke","params":{"tool":"read_file","input":{"path":"README.md"},"callId":"c_7"}}
← {"jsonrpc":"2.0","id":"p1","method":"host/fs.read","params":{"path":"README.md"}}
→ {"jsonrpc":"2.0","id":"p1","result":{"text":"# Demo\n..."}}
← {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"# Demo\n..."}]}}
```

## 6. Host/plugin boundary: data, events, UI and commands

**What the host owns:** the agent loop and conversation state, model access, the tool and command registry, the event bus, configuration and its validation, the secret store, per-plugin storage and data folders, approvals, permission enforcement, auditing, supervision and all rendering (CLI and web).

**What a plugin can reach:** its own configuration, storage, data folder and log; host APIs it has been granted; event payloads for events it subscribed to, filtered by its permissions; and the input of calls addressed to it. It can't reach other plugins' data, the host's memory, the host's environment variables, or the raw conversation (that needs `conversation.read`).

**Event catalog (v1)**

| Event | Mode | Payload (beyond `sessionId`, `ts`) | Extra permission |
| --- | --- | --- | --- |
| `session.start` / `session.end` | watch | workspace, model, summary stats | none |
| `message.user` / `model.response` | watch | message text | `conversation.read` |
| `tool.before` | **intercept** | plugin, tool, effect, input | `tool.intercept` |
| `tool.after` | watch, or intercept for output redaction | tool, duration, output, isError | `tool.intercept` to modify |
| `tool.error` | watch | tool, error code | none |
| `plugin.state` | watch | plugin id, from → to, reason | none |
| `plugin.<id>.*` | watch | defined by the emitting plugin | none |

Intercept hooks run in priority order (then by id). The first `block` wins and `modify` patches are applied in sequence. Each hook has a short timeout (default 2 s) and declares `onError: "continue" | "block"`. Security hooks such as guard's are **fail-closed**: if the guard plugin crashes, risky tool calls are blocked rather than silently allowed. The user can override this choice.

**UI:** plugins never send HTML or JavaScript to the console. Panels are declarative JSON trees that the host renders (web and terminal) from a fixed set of components, with markdown sanitised. Buttons can only trigger the plugin's own commands. This rules out cross-site scripting through plugins entirely.

## 7. Permissions and security

### 7.1 Threat model

Defended against: a buggy or careless plugin (most likely); a plugin that has been poisoned with prompt injection by content it fetched; and a moderately malicious third-party plugin trying to read `~/.ssh`, exfiltrate data over the network, spawn shells, read API keys from the environment, or flood or crash the host. Not defended against: kernel or sandbox escapes, a malicious host binary, physical access. I'll document these limits openly (§7.9).

### 7.2 Permission catalog

| Permission | Scope | Default risk | Enforced by |
| --- | --- | --- | --- |
| `fs.read` | path list | medium (high if it includes `${home}`) | broker + OS sandbox read rules + Node `--allow-fs-read` |
| `fs.write` | path list | high | broker + OS sandbox write rules + Node `--allow-fs-write` |
| `net.http` | host patterns (`api.x.com`, `*.wikipedia.org`, `*`) | medium; `*` is high | broker only; the OS sandbox blocks all direct sockets |
| `net.local` | none (allows loopback/private ranges) | high | broker |
| `process.exec` | command allowlist | high | broker spawns; the OS sandbox blocks the plugin from running programs itself |
| `secrets` | declared secret names | high | broker |
| `conversation.read` | none | medium | event payload filtering |
| `tool.intercept` | none | high | hook dispatcher |
| `llm.invoke` | optional token budget | medium | broker |
| *(implicit)* storage, own data folder, logs, notify, own events | none | low | always granted, never prompted |

### 7.3 Declare → consent → enforce → revoke

1. **Declare:** permissions go in the manifest, each with a reason. Undeclared permissions can never be granted.
2. **Consent:** at install (and at update if permissions change), the user sees a risk-ranked list. Required permissions must be granted to enable the plugin; optional ones can be declined, and tools that need them are then hidden. Scopes can be **narrowed** at grant time (for example, `*` becomes `*.wikipedia.org,docs.python.org`). Each grant is `allow` (always) or `ask` (prompt each time; denied automatically when running non-interactively).
3. **Enforce:** the broker checks every host API call against the grants. The OS sandbox profile and the Node flags are **generated from the same grants** each time the process starts.
4. **Revoke:** `helm plugin revoke <id> <perm>` or a toggle in the web console. The broker denies the very next call (`PERMISSION_REVOKED`) and the plugin process is restarted, so its sandbox profile matches the new grants. Revoking a permission also hides the tools that required it from the model on the next turn.
5. **Grants are tied to a version.** An update that requests new or wider permissions stays at the old version until the user approves the difference.

### 7.4 Layered enforcement (defence in depth)

| Layer | Applies to | What it does |
| --- | --- | --- |
| 1. Permission broker | all plugins, all OSes | Authoritative, fine-grained (paths, hosts, secret names, commands), audited |
| 2. macOS `sandbox-exec` profile per plugin | all runtimes on macOS | Denies **all** network sockets (so network access must go through the broker), denies writes everywhere except the plugin's data and temp folders plus granted write scopes, denies reads under `$HOME` except the plugin folder, the runtime and granted read scopes, and denies running any program except the runtime itself |
| 3. Node permission model | Node plugins | `--permission` with read/write lists derived from grants; no `--allow-net`, child processes, workers, native addons, WASI or FFI. Works on Linux and Windows too |
| 4. Environment scrubbing | all | The child gets only a minimal env (`PATH`, `LANG`, `HOME` set to the plugin's sandbox home, `TMPDIR`). `OPENAI_API_KEY` and other secrets are never inherited; `PYTHONNOUSERSITE=1` |
| 5. Resource limits | all | Call and activation timeouts, an RSS memory watchdog (`--max-old-space-size` for Node as well), output and message caps, log rate limiting and rotation, broker rate limits, a concurrency cap |

Each plugin shows its **isolation level**: `strict` (layers 1–5 with the OS sandbox active), `runtime` (no OS sandbox but the Node permission model is on), or `basic` (broker + env + limits only). `helm doctor` checks what the machine supports. That includes the nested-sandbox case I hit on your Mac, where `sandbox_apply` is refused. By default, third-party plugins **won't start below `strict` on macOS** unless the user runs `helm plugin trust <id>`. The reason is always shown, never silently downgraded.

### 7.5 Secrets

The default store is the macOS Keychain (via `/usr/bin/security`), with a `0600` encrypted-file fallback on other systems. Values are entered with hidden input (`helm secrets set helm.web BRAVE_API_KEY`). Plugins only get a value by calling `secrets.get`, which requires a grant. The host keeps a set of live secret values and scrubs them from plugin logs, transcripts, tool output sent to the model, and the audit log.

### 7.6 Tool approvals and prompt-injection mitigations

The default approval policy depends on the tool's `effect`: `read` runs automatically; `write`, `exec` and `external` ask (y / n / always for this session). Users can change this in config (`approvals.write = "ask" | "allow" | "deny"`). Tool output is wrapped and labelled as untrusted data in the system prompt. Hooks (guard) can force approval or block based on content. The agent's step limit (default 12) and per-turn tool-call limit stop runaway loops.

### 7.7 Audit log

`~/.helm-agent/audit.jsonl` records every broker decision (plugin, permission, summarised arguments, allowed or denied, reason), every grant and revoke, every approval decision and every hook block. View it with `helm audit [--plugin id] [--denied]` and on the web console's Audit page.

### 7.8 Web console security

The console binds to `127.0.0.1` only. It uses a random per-launch token in the URL that becomes an HttpOnly cookie, checks the `Host` header (against DNS rebinding) and requires a CSRF header on write requests. No plugin-supplied scripts run in it.

### 7.9 Honest limitations

`sandbox-exec` is deprecated by Apple but still works on macOS 26.5 (I verified this). It sits behind an interface so it can be replaced. Node's own docs describe its permission model as a safety net rather than a hard security boundary, which is why it's layer 3, not layer 1. Outside macOS without `bubblewrap`, Python plugins only get `basic` isolation. None of this is equivalent to a VM. The docs will say exactly this.

## 8. Stability and compatibility

| Failure | What the host does | What the user sees |
| --- | --- | --- |
| Plugin crashes during a call | In-flight calls fail with `PLUGIN_CRASHED`; the model gets a structured tool error and continues; lazy restart with exponential backoff | ⚠ line in chat or toast: "helm.web crashed (exit 1) while running fetch_url, restarting. Details: `helm plugin logs helm.web`" |
| 3 crashes in 5 min | Circuit breaker opens → `quarantined`; its tools are removed from the model's list; hooks follow their `onError` policy | Red badge plus explanation and the fix command (`helm plugin reset`) |
| Call hangs | Timeout → `$/cancelRequest` → 2 s grace → if `$/ping` also fails, kill and restart | "fetch_url timed out after 15 s (limit can be raised: …)" |
| Activation hangs or fails | `ACTIVATION_TIMEOUT` / error; nothing gets registered | State `crashed` with last stderr lines |
| Memory over limit | Watchdog kills the process → crash path | "killed: memory 512 MB > limit 256 MB" |
| Garbage on stdout | Line logged as protocol noise; after N bad lines → kill with `PROTOCOL_ERROR`. The SDKs redirect `console.log` / `print` to stderr so this rarely happens | Explanation that names the cause |
| Oversized output | `RESULT_TOO_LARGE`, or truncated with an artifact pointer | Note on the tool card |
| Log flood | stderr rate-limited and rotated (5 MB) | Nothing; logs marked "rate-limited" |
| Hook fails or times out | Applies the hook's `onError` (continue or block) | Guard says "blocked because guard is unavailable (fail-closed)" |
| `engines.helm` or `engines.protocol` mismatch | Detected **before spawning**; installed but marked `incompatible`, never started | "Requires helm ^2.0, you have 0.1.0" |
| Handshake returns a different protocol major version | Process stopped, marked `incompatible` | Same, with both versions shown |
| Config no longer valid after update | Invalid keys reset to defaults; warning listing them | Shown in the update summary |
| Bad update | Previous version kept; `helm plugin rollback <id>` | Rollback in one command |

The host itself stays stable because every plugin message is handled in isolation (an error handling one message never escapes), the NDJSON reader caps line length before buffering, state is written atomically (temp file + rename) behind a lock file so the CLI and the web server can run at the same time, and nothing a plugin sends is ever evaluated as code.

Compatibility policy: host semver; protocol `MAJOR.MINOR`, where minor versions only add features (advertised through `capabilities`) and major versions break; `manifestVersion` lets the host migrate older manifests; deprecations warn through `doctor` and `validate` for one minor release before removal.

## 9. Plugin management for users

**Discovery.** `registry/index.json` is a local file-based catalog that ships with the repo. Users can add more with `helm registry add <path|url>`. `helm plugin search <q>` shows id, version, description, contributions and a **permission summary before installing**.

**Installing from:** a local folder (copied), `--link` (dev symlink), a `.tgz` (sha256 checked against the registry entry), a git URL (shallow clone), or a registry id. Versions are stored side by side (`plugins/<id>/<version>/`) so update and rollback are atomic switches of a pointer.

**Consent screen (CLI; the web console shows the same as a dialog):**

```
$ helm plugin install ./plugins/web
Installing helm.web 1.0.0 — Web Fetch & Search
  runtime python ≥3.9 · isolation strict (macOS sandbox) · source local folder (unsigned)

Requested permissions
  HIGH  net.http  any host (*)            "Fetch pages you or the agent ask for"
                  (loopback/private networks stay blocked: net.local not requested)
  HIGH  secrets   BRAVE_API_KEY  optional "Use Brave Search instead of Wikipedia"
Contributes  2 tools (fetch_url, web_search)

Grant net.http?  [y]es / [n]o / [s]cope… › s
  Allowed hosts › *.wikipedia.org, docs.python.org
Grant secrets:BRAVE_API_KEY? [y/N] › n
✔ helm.web 1.0.0 installed and enabled (1 optional permission declined)
```

**Explaining failures.** `helm plugin info <id>` always ends with a Health section in plain language:

```
helm.web 1.0.0 — Web Fetch & Search                                  ● quarantined
  Runtime     python 3.10.11 · isolation strict
  Tools       fetch_url, web_search   (hidden from the agent while quarantined)
  Permissions net.http granted (*.wikipedia.org, docs.python.org) · secrets BRAVE_API_KEY declined
  Health      3 crashes in 4m12s → circuit opened 23:51:07
    Last error  PLUGIN_CRASHED: exited with code 1 during tool fetch_url
    stderr      ModuleNotFoundError: No module named 'bs4'
    Next step   The plugin imports a package it doesn't ship. Check `helm plugin logs helm.web`,
                fix or update the plugin, then run `helm plugin reset helm.web`.
```

**CLI reference (user side):**

```
helm doctor                                   # runtimes, sandbox support, isolation level, config sanity
helm plugin list [--all] [--json]             # state badges: enabled/disabled/active/crashed/quarantined/incompatible
helm plugin search <query>
helm plugin info <id> [--readme] [--json]
helm plugin install <path|tgz|git|registry-id> [--link] [--yes] [--grant perm[=scope]]
helm plugin enable|disable <id>
helm plugin config <id> [get|set|unset|edit] [key] [value]
helm secrets set|delete|list <id> [NAME]
helm plugin permissions <id>                  # requested vs granted, with risk
helm plugin grant|revoke <id> <perm> [--scope ...]
helm plugin trust|untrust <id>                # allow running below `strict` isolation
helm plugin update <id>|--all                 # shows changelog and permission diff, asks consent
helm plugin rollback <id>
helm plugin reset <id>                        # clear crash counter / quarantine
helm plugin logs <id> [-f] [--lines N]
helm plugin panel <id> <panel>
helm plugin uninstall <id> [--purge-data]
helm cmd <id>.<command> [--arg value]         # run a plugin command
helm chat [--workspace DIR] [--provider p]    # interactive; /plugins, /tools, /<plugin>.<cmd>, /approve-all
helm run "task" [--workspace DIR] [--json]    # one-shot, non-interactive ("ask" means deny)
helm audit [--plugin id] [--denied]
helm serve [--port N]                         # web console
```

Changes made in the CLI or the web console reach a running session **at the next turn**: disable a plugin mid-chat and its tools are gone on the next model call, with no restart.

## 10. Plugin developer experience

The goal is a working first plugin in under 5 minutes, with debugging that doesn't require reading host source.

```
helm plugin new my-notes --lang ts      # or --lang python; creates manifest, entry, README, test
helm plugin dev ./my-notes --trace      # run from source (no install), hot reload on save, RPC trace, logs inline
helm plugin call my.notes add_note --input '{"text":"hi"}'   # call a tool directly, no LLM needed
helm plugin validate ./my-notes         # manifest + schema checks, with precise messages
helm plugin pack ./my-notes             # → my.notes-0.1.0.tgz + sha256
```

**TypeScript SDK** (`@helm/plugin-sdk`, runs without a build step):

```ts
import { definePlugin } from "@helm/plugin-sdk";

export default definePlugin({
  async activate(ctx) {
    ctx.log.info("notes ready", { config: ctx.config });
  },
  tools: {
    async add_note({ text }: { text: string }, ctx) {
      const notes = (await ctx.storage.get<string[]>("notes")) ?? [];
      await ctx.storage.set("notes", [...notes, text]);
      return { text: `Saved note #${notes.length + 1}` };
    },
  },
  commands: {
    async list(_args, ctx) { return { markdown: ((await ctx.storage.get<string[]>("notes")) ?? []).map(n => `- ${n}`).join("\n") }; },
  },
  hooks: {
    "tool.after": async (evt, ctx) => { ctx.log.debug("tool ran", evt.tool); },
  },
});
```

**Python SDK** (`helm_plugin.py`, a single stdlib-only file you can vendor):

```python
from helm_plugin import Plugin

plugin = Plugin()

@plugin.tool("fetch_url")
async def fetch_url(input, ctx):
    resp = await ctx.net.fetch(input["url"], timeout=10)        # goes through the broker
    return {"text": resp.text[: ctx.config["maxChars"]]}

if __name__ == "__main__":
    plugin.run()
```

What the SDKs handle for you: the handshake, method routing, input validation against the manifest schema, concurrency, cancellation (`ctx.signal` / `ctx.cancelled`), structured errors, redirecting stdout to stderr, a typed `ctx` (`config`, `storage`, `fs`, `net`, `secrets`, `exec`, `events`, `ui`, `log`, `progress`). There is also an **in-process test harness** (`createTestHost({ grants, config })` / `TestHost(...)`) with fake host APIs, so plugin unit tests need neither the host nor an LLM.

Docs (in `docs/`): Quickstart ("your first plugin in 5 minutes"), Manifest reference (generated from the JSON Schema), Protocol spec (enough to write a plugin with no SDK, in any language), Permissions guide, Troubleshooting (every error code: meaning, cause, fix), and Architecture.

## 11. Agent loop and model providers

Each turn: build the tool list from enabled, healthy plugins whose required permissions are granted → call the model → for each tool call: validate the input against its schema → `tool.before` hooks → approval policy → route to the plugin (with timeout and cancellation) → `tool.after` hooks → append the result → repeat until a final answer or the step limit. Each phase streams events to the CLI and the web console, so you see tool cards, approvals, plugin state changes and errors live. Transcripts are saved as JSONL under `sessions/`, with secrets redacted.

Providers are built into the core behind a small interface. **`openai-compatible`** covers OpenAI, OpenRouter, Ollama, LM Studio and vLLM: Chat Completions with tools and streaming; base URL, model and key (stored as a secret) are configurable. **`mock`** is a deterministic, scripted provider that replays a JSON script of tool calls and answers, used for tests, CI and an offline demo. The core treats providers as interchangeable, so adding Anthropic or others later is a contained change.

## 12. Sample plugins and how they prove the mechanism

| Plugin | Language / runtime | Contributes | Permissions | What it proves |
| --- | --- | --- | --- | --- |
| **helm.files** "Workspace Files" | TypeScript / node | Tools `list_dir`, `read_file`, `search_text`, `write_file` (approval); command `tree`; config | `fs.read ${workspace}` (required), `fs.write ${workspace}` (optional) | Tools, path-scoped file permissions, hidden tools when an optional permission is declined, approvals, config |
| **helm.web** "Web Fetch & Search" | Python (stdlib only) / python | Tools `fetch_url` (HTML → readable text), `web_search` (Wikipedia by default, Brave with a key); cached in plugin storage | `net.http` (narrowable), optional `secrets: BRAVE_API_KEY` | Language-agnostic protocol, network broker with private-IP blocking, secrets, timeouts and cancellation |
| **helm.guard** "Guardrails & Audit" | TypeScript / node | **No tools.** Hooks `tool.before` (block, ask or allow by rules; fail-closed), `tool.after` (redacts key-like strings), `session.end`; commands `report`, `rules`, `clear`; panel `activity`; custom event `blocked` | `tool.intercept` | Plugins can change host behaviour (not only add tools); hooks, commands, declarative UI, custom events, fail-closed policy |

**Fixture plugins** (`tests/fixtures/plugins/`, not for users): `crashy` (exits mid-call or on start), `sleepy` (never answers), `hog` (allocates until killed), `chatty` (garbage on stdout and a log flood), `escape` (tries to read `~/.ssh`, open a raw socket to 1.1.1.1, spawn `/bin/sh` and read `OPENAI_API_KEY` from env; every attempt must fail), `oldie` (wrong `engines` / protocol 2.0), `broken-manifest`.

**How I'll prove the host is really extended, not hard-coded:**

1. **Static test:** CI fails if `packages/core`, `packages/cli` or `packages/web` contains any sample-plugin id or tool name.
2. **Behaviour test** with the mock provider, run in one scripted session: with no plugins the model has 0 tools; installing files makes file tools work; adding guard blocks a write to `.env`; disabling files mid-session removes its tools on the next turn; adding web enables fetching from an allowed host while a disallowed host returns `PERMISSION_DENIED`.
3. **"Third-party" test:** scaffold a brand-new plugin with `helm plugin new` in a temp folder, install it and call its tool. No host code changes.
4. **Stability test:** a session keeps running and answering while `crashy`, `sleepy` and `hog` fail beside it.

## 13. Repository layout

```
./                                  (this workspace folder becomes the git repo)
├── package.json                    npm workspaces; scripts: test, typecheck, demo, helm
├── packages/
│   ├── core/src/
│   │   ├── manifest/               schema.json, validate.ts, variables.ts, migrate.ts
│   │   ├── store/                  paths.ts, state.ts (atomic + lock), install.ts, registry.ts, versions.ts
│   │   ├── runtime/                supervisor.ts, rpc.ts, ndjson.ts, launchers/{node,python,exec}.ts,
│   │   │                           sandbox/{macos.ts,detect.ts}, watchdog.ts, env.ts
│   │   ├── permissions/            catalog.ts, grants.ts, broker.ts, fs-scope.ts, net-policy.ts, secrets.ts, redact.ts
│   │   ├── host-api/               fs.ts, net.ts, process.ts, storage.ts, llm.ts, events.ts, ui.ts
│   │   ├── contributions/          registry.ts, tools.ts, commands.ts, hooks.ts, panels.ts
│   │   ├── agent/                  session.ts, loop.ts, approvals.ts, providers/{openai-compatible,mock}.ts
│   │   ├── events/bus.ts, audit/log.ts, errors.ts, index.ts
│   ├── cli/src/                    main.ts, commands/*.ts, render/*.ts (tables, panels, consent), prompts.ts
│   ├── web/                        server.ts (REST + SSE), public/ (no-build Preact + htm, CSS)
│   ├── sdk-node/                   definePlugin, ctx, testing harness, types
│   └── sdk-python/                 helm_plugin.py, testing.py
├── plugins/                        files/, web/, guard/
├── templates/                      ts/, python/   (used by `helm plugin new`)
├── registry/index.json
├── tests/                          unit/, integration/, e2e/, fixtures/plugins/*, fixtures/mock-scripts/*
├── docs/                           quickstart, manifest-reference, protocol, permissions, troubleshooting, architecture
└── scripts/demo.sh                 end-to-end demo against a throwaway HELM_AGENT_HOME
```

## 14. Tech stack

The stack is Node ≥ 22.18 (tested on your 26.8.1) running ESM TypeScript directly through Node's built-in type stripping (`erasableSyntaxOnly`, checked with `tsc --noEmit`). There is no bundler. Runtime dependencies are deliberately few: `ajv` (JSON Schema for manifests, configs and tool inputs), `semver` and `commander`; prompts and colours use small libraries or built-ins. Tests use the built-in `node:test`. The web console uses vendored Preact + htm with no build step. The Python SDK is a single stdlib-only file. Nothing needs native compilation.

## 15. Testing and acceptance

**Automated suite (`npm test`):** unit tests for manifest validation, semver/protocol checks, path scoping (`..`, symlinks, case and Unicode tricks), net policy (wildcards, private IPs, redirects, DNS results), redaction, the state store under concurrency, and NDJSON framing limits. Integration tests run each fixture plugin through the supervisor and the broker. End-to-end tests drive the CLI with the mock provider through the scenarios in §12. OS-sandbox tests are tagged and skip with a clear message when the sandbox can't be applied (as in my nested terminal); I'll run them with elevated permission and report the results.

**Your acceptance checklist** (I'll run all of this and report results; `scripts/demo.sh` reproduces it):

1. `helm doctor` reports runtimes and `strict` isolation.
2. `helm plugin search` → `install` shows the consent screen; `list` and `info` show states, contributions and grants.
3. `helm run` (mock provider) uses files and web tools; `helm audit` shows the broker decisions.
4. With guard enabled, a write to `.env` is blocked with a reason; `helm plugin panel helm.guard activity` shows it.
5. `helm plugin revoke helm.files fs.write` hides `write_file` on the next turn; `grant` brings it back.
6. `crashy` / `sleepy` / `hog` fail with clear explanations while the session continues; `crashy` ends up `quarantined`; `reset` recovers it.
7. `escape` fails all four breakout attempts, and the attempts appear as denials.
8. `oldie` installs as `incompatible` and is never spawned.
9. `helm plugin update` with a version that adds a permission asks for consent; `rollback` restores the old version.
10. `helm plugin new` → `dev --trace` → `call` works in under 5 minutes, following the quickstart only.
11. `helm serve`: chat, toggles, config form, permission revocation, logs and the guard panel all work in the browser.
12. The static "no hard-coded plugins" test passes.
13. (If you provide a key or endpoint) a live `helm chat` session with a real model uses all three plugins.

## 16. Milestones (build order)

Each milestone ends with tests passing and a short note on what I verified.

| # | Milestone | Deliverable you could check |
| --- | --- | --- |
| M1 | Foundations: manifest schema/validator, HELM_AGENT_HOME layout, atomic state store, `install / list / info / enable / disable / uninstall` (no runtime yet) | Consent screen, `info` output, validation errors |
| M2 | Runtime: NDJSON JSON-RPC, supervisor, handshake/versioning, lazy activation, timeouts, cancellation, crash backoff, quarantine, log capture, `plugin call` | Fixtures crashy/sleepy/chatty/oldie behave as in §8 |
| M3 | Security: permission catalog, grants/revoke, broker + host APIs, macOS profile generator, Node flags, env scrubbing, watchdog, secrets, redaction, audit, `doctor` | `escape` fixture fully contained; audit entries |
| M4 | Agent: session/loop, mock + openai-compatible providers, approvals, hooks dispatcher, commands, `chat` / `run` / `cmd` | Scripted sessions end to end |
| M5 | Developer experience: Node + Python SDKs with test harnesses, `plugin new / dev --trace / validate / pack`, templates, quickstart | A new plugin scaffolded and working in minutes |
| M6 | Sample plugins: files, web, guard; registry index; `update` with permission diff, `rollback` | §12 proof scenarios |
| M7 | Web console (`helm serve`) | Checklist item 11 |
| M8 | Hardening: full suite, static extensibility test, `demo.sh`, docs polish, final report | Full checklist in §15 |

## 17. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| `sandbox-exec` is deprecated and may change in a future macOS | Behind a `Sandbox` interface; `doctor` checks it at startup; Node and broker layers stay; clear fallback messages |
| Host launched inside another sandbox (some IDE terminals, agent terminals) | Detected; falls back to `runtime`/`basic` isolation with an explicit warning and the trust requirement |
| No live LLM credentials here | Mock provider plus recorded OpenAI-format tests; live check once you provide a key or endpoint |
| My command environment has no network by default and a nested sandbox | `npm install` and OS-sandbox tests run with permission requests; everything else runs offline |
| Third-party plugin needs dependencies (npm/pip) | v1: self-contained plugins only (vendored or bundled); later: uv-managed per-plugin venvs, still with no install-time code execution |
| Scope creep in the web console | Console uses only core APIs that the CLI already exercises; built after the core is stable (M7) |

## 18. Decisions I need from you (defaults in bold)

1. **Product surfaces:** **CLI + local web console** / CLI only.
2. **Stack:** **TypeScript on Node (no build step) + stdlib-only Python SDK** / something else.
3. **Isolation policy:** **third-party plugins refuse to run below `strict` on macOS unless explicitly trusted** / warn but allow.
4. **LLM for live testing:** do you have an OpenAI-compatible endpoint I can use (OpenAI or OpenRouter key, or a local Ollama/LM Studio)? **If not, I verify with the mock provider** and you add a key later with `helm provider add`.
5. **Sample plugins:** **files (TS) + web (Python) + guard (TS hooks/UI)** / swap one (for example git, shell runner or notes/memory).
6. **Model providers as a plugin contribution point:** **out of scope for v1** / include (more proof of extensibility, more work).
7. **Name and location:** **"Helm", built directly in this workspace folder as a new git repo** / other name or path.

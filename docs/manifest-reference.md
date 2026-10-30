# Manifest reference (`helm-plugin.json`, version 1)

Every plugin has a `helm-plugin.json` at its root. The host reads it **without running plugin code**, so it can validate the plugin, check compatibility, show a consent screen, list contributions and explain availability before the plugin ever starts. The machine-readable form is [schemas/plugin-manifest-v1.json](schemas/plugin-manifest-v1.json). Add `"$schema"` pointing at it for editor completion (scaffolded plugins already do). `helm plugin validate <dir>` reports every problem at once, each with a JSON pointer and a fix.

Fields marked **required** must be present. Unknown top-level fields are rejected, so typos surface early.

## Top level

| Field | Type | Description |
| --- | --- | --- |
| `$schema` | string | Optional. Path or URL of the JSON Schema, for editors. Ignored by the host. |
| `manifestVersion` | `1` | **Required.** Manifest format version. |
| `id` | string | **Required.** Globally unique, stable identifier: lowercase dot-separated segments, e.g. `acme.word-tools`. Pattern `^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$`. The part after the first dot is the **short name** used to namespace contributions (`word-tools` → tools `word_tools__<tool>`, commands `word-tools.<name>`). |
| `name` | string | **Required.** Human-readable name. |
| `version` | string | **Required.** Semantic version of this release (`1.4.0`). Updates compare versions. |
| `description` | string | **Required.** One or two sentences. Shown in search results and the consent screen. |
| `publisher` | string | Who publishes it. |
| `license` | string | SPDX identifier. |
| `homepage` | string | URL. |
| `engines` | object | **Required.** Compatibility, see [engines](#engines). |
| `runtime` | object | **Required.** How to start the plugin, see [runtime](#runtime). |
| `activation` | string[] | When to start the process, see [activation](#activation). |
| `permissions` | object[] | What it may access, see [permissions](#permissions). |
| `contributes` | object | What it adds to Helm, see [contributes](#contributes). |
| `limits` | object | Resource limits, see [limits](#limits). |

## engines

```json
"engines": { "helm": ">=0.1.0 <1.0.0", "protocol": "^1.0" }
```

| Field | Description |
| --- | --- |
| `helm` | **Required.** semver range of Helm versions the plugin works with. |
| `protocol` | **Required.** semver range of the host ↔ plugin [protocol](protocol.md). This host speaks `1.0`. |

A plugin outside either range is refused at install with `INCOMPATIBLE_VERSION`, and the message says which side is too old. If Helm is upgraded under an installed plugin that no longer matches, the plugin is marked incompatible and never started, and its tools are hidden with that reason. The handshake checks the protocol major version again at run time.

## runtime

| `type` | Fields | What runs |
| --- | --- | --- |
| `node` | `entry`: a `.ts`, `.mts`, `.js` or `.mjs` file | `node --permission … bootstrap.ts <entry>`. The default export must be `definePlugin({...})`. Folder needs `package.json` with `"type": "module"`. |
| `python` | `entry`: a `.py` file | `python3 -u -s -B <entry>` with the stdlib-only SDK on `PYTHONPATH`. The entry calls `plugin.run()`. Set `HELM_PYTHON` to choose an interpreter. |
| `exec` | `command`: `["./bin/my-plugin", "arg"]` | Any executable speaking the [protocol](protocol.md) on stdio. Relative paths resolve inside the plugin folder. A script's `#!` interpreter is allowed to execute. Nothing else is. |

## activation

When the host starts the process. Plugins are lazy by default. Starting late keeps Helm fast and keeps unused plugins out of memory.

| Value | Starts the plugin |
| --- | --- |
| `onTool` | when one of its tools is called |
| `onCommand` | when one of its commands or panels is used |
| `onProvider` | when the agent uses its provider |
| `onSession` | when a chat session starts (useful for hooks) |
| `onStartup` | when Helm starts |

Hook events also start the plugin when they need it, so most plugins can omit `activation`.

## permissions

```json
"permissions": [
  { "id": "fs.read",  "scope": ["${workspace}"], "reason": "Read the files you ask about." },
  { "id": "net.http", "scope": ["*.wikipedia.org"], "userExtensible": true, "reason": "Search Wikipedia." },
  { "id": "secrets",  "scope": ["BRAVE_API_KEY"], "optional": true, "reason": "Use Brave Search if you add a key." }
]
```

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | **Required.** A permission from the catalog below. |
| `scope` | string[] | What exactly. Its meaning depends on the permission. Omit for permissions without a scope. |
| `reason` | string | **Required.** Why, in words for the user. Shown verbatim on the consent screen. |
| `optional` | boolean | The user may decline it. Tools that `require` it are then hidden with a reason, not broken. |
| `userExtensible` | boolean | Invites the user to change the scope at install or later (`helm plugin grant <id> <perm> --scope …`). |

| Permission | Scope means | Notes |
| --- | --- | --- |
| `fs.read` | absolute paths or `${workspace}`, `${pluginData}` | Symlinks resolved before the check. Also widens the OS sandbox. |
| `fs.write` | paths, same as above | Write access does not include reads through the broker. Declare both if you need both. |
| `net.http` | host patterns: `api.example.com`, `*.example.com`, `*` | Via `ctx.net.fetch`. Every redirect hop is re-checked. |
| `net.local` | none | Needed to reach `localhost`, `*.local` and private/link-local IPs (checked after DNS resolution too). |
| `process.exec` | program names: `git`, `rg` | Via `ctx.process.exec`. Bare names only (no paths). The host resolves the program on its own `PATH`, scrubs the environment and runs it in a sandbox derived from the plugin's file grants. |
| `secrets` | secret names | Via `ctx.secrets.get`. Users set them with `helm secrets set <id> <name>`. |
| `conversation.read` | none | Needed for `message.user` and `model.response` hooks. Without it, tool watch hooks get metadata only: `input` and `output` are removed and listed in `redacted`. |
| `tool.intercept` | none | Required for `intercept` hooks. |
| `llm.invoke` | none | Via `ctx.llm.complete`, using the user's provider. |

The validator warns about tools whose `effect` is `write` or `exec` but that `require` nothing, and errors on a `requires` entry that the plugin doesn't declare in `permissions`.

## contributes

Every contribution needs a handler with the same name in the code. On start the SDK reports what it implements, and the host warns about mismatches in both directions. Names match `^[a-z][a-z0-9_]{0,40}$`.

### tools

```json
{
  "name": "read_file",
  "title": "Read file",
  "description": "Read a UTF-8 text file from the workspace. Use for source code, notes and configs.",
  "effect": "read",
  "requires": ["fs.read"],
  "approval": "auto",
  "inputSchema": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] },
  "timeoutMs": 20000
}
```

| Field | Description |
| --- | --- |
| `name` | **Required.** Exposed to the model as `<short>__<name>`. |
| `title` | Short label for UIs. |
| `description` | **Required.** What the model reads to decide when to call it. Be specific. |
| `effect` | **Required.** `read`, `write`, `external` (contacts the outside world) or `exec`. Shown to the user and used by policy plugins. |
| `requires` | Permissions the tool needs. If any is not granted, the tool is unavailable and the reason is shown. |
| `approval` | `auto` (default) or `ask`: the user confirms each call. Users can also require approval for a whole effect (e.g. every `write` tool) with the `approvals` setting. |
| `inputSchema` | **Required.** JSON Schema for the arguments. The host validates input before the call reaches you (`INPUT_INVALID`). |
| `timeoutMs` | Per-tool deadline, overriding `limits.callTimeoutMs`. |

### providers

```json
{ "id": "openrouter", "title": "OpenRouter", "description": "Models via openrouter.ai", "defaultModel": "anthropic/claude-opus-5.5", "timeoutMs": 180000 }
```

Selected as `<plugin id>/<provider id>` (`helm provider use helm.openrouter/openrouter`). The handler implements `complete` and optionally `models`. See the [Plugin Guide](plugin-guide.md#providers).

### hooks

```json
{ "event": "tool.before", "mode": "intercept", "priority": 10, "onError": "block", "timeoutMs": 2000 }
```

| Field | Description |
| --- | --- |
| `event` | **Required.** `session.start`, `session.end`, `message.user`, `model.response`, `tool.before`, `tool.after`, `tool.error` or `plugin.state`. |
| `mode` | **Required.** `watch` (notification, not awaited) or `intercept` (awaited, can block, ask or modify). Only `tool.before` and `tool.after` can be intercepted, and intercepting needs the `tool.intercept` permission. |
| `priority` | Higher runs first among intercept hooks. Default 0. |
| `onError` | `continue` (default) or `block`: if the hook crashes or times out, the call is blocked (fail closed). |
| `timeoutMs` | Deadline for this hook. Default 2000 for intercept hooks, 5000 for watch hooks. |

### commands

```json
{ "name": "report", "title": "Policy report", "description": "What Guard blocked this session", "args": { "type": "object", "properties": { "limit": { "type": "integer" } } }, "requires": [] }
```

Run with `helm cmd <short>.<name> key=value`, or from panels and the console. `args` is a JSON Schema and is validated.

### panels

```json
{ "id": "repo", "title": "Repository", "description": "Branch, changes and recent commits" }
```

Rendered by `helm panel <short>.<id>` and in the console. The handler returns a declarative UI tree, see the [Plugin Guide](plugin-guide.md#panels).

### configuration

A JSON Schema (draft-07) object describing the plugin's settings:

```json
"configuration": {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "searchBackend": { "type": "string", "enum": ["wikipedia", "brave"], "default": "wikipedia", "description": "Where web_search looks." },
    "maxResults": { "type": "integer", "minimum": 1, "maximum": 20, "default": 5 }
  }
}
```

Defaults are applied automatically. Changes are validated (`CONFIG_INVALID` names the field) and delivered to the running plugin. The console renders this as a form. Don't put secrets here: use the `secrets` permission.

## limits

| Field | Default | Range | Meaning |
| --- | --- | --- | --- |
| `callTimeoutMs` | 30000 | 100–900000 | Deadline per request. On expiry the call is cancelled (`$/cancelRequest`) and fails with `CALL_TIMEOUT`. A plugin that keeps ignoring cancellation is restarted. |
| `activationTimeoutMs` | 10000 | 100–120000 | Deadline for start-up and `activate()`. |
| `maxConcurrency` | 4 | 1–64 | Concurrent requests. Further calls queue. |
| `memoryMb` | 256 | 32–8192 | Memory ceiling (V8 heap cap for Node, plus an RSS watchdog for every runtime). Exceeding it stops the plugin with `MEMORY_LIMIT`. |
| `idleTimeoutMs` | 600000 | ≥ 1000 | Stop the process after this long without requests. |

Users can override any limit: `helm plugin limit <id> <key> [value]`.

## A complete example

[`plugins/web/helm-plugin.json`](../plugins/web/helm-plugin.json) (Python, network, optional secret, configuration) and [`plugins/guard/helm-plugin.json`](../plugins/guard/helm-plugin.json) (intercept hooks, commands, panel) are good references.

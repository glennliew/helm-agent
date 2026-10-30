# Plugin Guide

This guide takes you from nothing to a tested, packaged Helm plugin. It assumes Helm is installed (`npm install` in the repository, with `bin/` on your `PATH`).

- [1. Your first plugin in five minutes](#1-your-first-plugin-in-five-minutes)
- [2. Anatomy of a plugin](#2-anatomy-of-a-plugin)
- [3. Lifecycle](#3-lifecycle)
- [4. Contribution points](#4-contribution-points)
- [5. The context: what a plugin can do](#5-the-context-what-a-plugin-can-do)
- [6. Permissions](#6-permissions)
- [7. Testing](#7-testing)
- [8. Debugging](#8-debugging)
- [9. Packaging, publishing and updating](#9-packaging-publishing-and-updating)
- [10. Writing a plugin in another language](#10-writing-a-plugin-in-another-language)

## 1. Your first plugin in five minutes

```sh
helm plugin new word-tools            # TypeScript; add --lang python for Python
cd word-tools
helm plugin test .                    # the scaffold ships with passing unit tests
helm plugin dev .                     # link + hot reload + interactive console
```

`helm plugin dev` shows the consent screen for the permissions the plugin asks for, links the folder (your edits are live, nothing is copied) and starts it under the same sandbox, broker and limits a user would get. Then it gives you a prompt:

```
dev › call hello name=Ada
Hello, Ada!
dev › call count_lines path=README.md
README.md has 18 lines
dev › call count_lines path=/etc/hosts
✖ Permission denied [PERMISSION_DENIED]
  /etc/hosts is outside the granted fs.read scope (/Users/you/project)
```

Edit `src/index.ts` and save: the plugin restarts, and the console warns you if the manifest and the code disagree. For example, it flags a tool you declared but never implemented, or a handler the manifest doesn't declare. When you're happy, `helm chat` in any workspace can use your tool: the model sees it as `word_tools__count_lines`.

## 2. Anatomy of a plugin

```
word-tools/
├── helm-plugin.json        manifest: identity, compatibility, permissions, contributions
├── package.json            {"type": "module"} (TypeScript/JavaScript plugins)
├── src/index.ts            entry point (runtime.entry)
├── test/index.test.ts      unit tests against the fake host
└── README.md
```

The **manifest** is the contract. The host reads it without running your code, which is how it can show a consent screen, list your tools and explain availability before your plugin has ever started. The [Manifest reference](manifest-reference.md) documents every field, and the [JSON Schema](schemas/plugin-manifest-v1.json) gives you autocompletion (the scaffold's `$schema` line points at it).

```json
{
  "$schema": "file:///…/docs/schemas/plugin-manifest-v1.json",
  "manifestVersion": 1,
  "id": "local.word-tools",
  "name": "Word Tools",
  "version": "0.1.0",
  "description": "Word Tools: describe what this plugin adds to Helm.",
  "engines": { "helm": ">=0.1.0 <1.0.0", "protocol": "^1.0" },
  "runtime": { "type": "node", "entry": "src/index.ts" },
  "activation": ["onTool", "onCommand"],
  "permissions": [
    { "id": "fs.read", "scope": ["${workspace}"], "reason": "Count lines in workspace files." }
  ],
  "contributes": {
    "tools": [
      { "name": "count_lines", "description": "Count the lines in a workspace file.", "effect": "read",
        "inputSchema": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] } }
    ],
    "commands": [{ "name": "about", "title": "About this plugin" }],
    "configuration": {
      "type": "object",
      "properties": { "greeting": { "type": "string", "default": "Hello" } }
    }
  }
}
```

The **entry point** exports handlers whose names match the manifest:

```ts
import { definePlugin, ui, PluginError } from '@helm-agent/plugin-sdk';

export default definePlugin({
  async activate(ctx) { ctx.log.info(`started with isolation ${ctx.isolation}`); },
  tools: {
    async count_lines({ path }: { path: string }, ctx) {
      const text = await ctx.fs.readText(path);
      return `${path} has ${text.split('\n').length} lines`;   // strings become text results
    },
  },
  commands: {
    about(_args, ctx) {
      return ui.stack(ui.heading(ctx.plugin.id), ui.keyValue({ version: ctx.plugin.version }));
    },
  },
});
```

The same plugin in Python (stdlib only, no `pip install`):

```python
from helm_plugin import Plugin, ui

plugin = Plugin()

@plugin.tool("count_lines")
def count_lines(input, ctx):
    text = ctx.fs.read_text(input["path"])
    return f"{input['path']} has {len(text.splitlines())} lines"

@plugin.command("about")
def about(args, ctx):
    return ui.stack(ui.heading(ctx.plugin["id"]), ui.key_value({"version": ctx.plugin["version"]}))

if __name__ == "__main__":
    plugin.run()
```

`@helm-agent/plugin-sdk` and `helm_plugin` are provided by the host at run time. You don't install them. The scaffolds' `tsconfig.json` and the test runner resolve them from the Helm repository so your editor and tests work too.

### Identity and naming

`id` is reverse-DNS-ish (`acme.word-tools`) and never changes. The part after the first dot becomes your **short name**, and every contribution is namespaced with it. The model sees tools as `<short>__<tool>` (`word_tools__count_lines`), and commands and panels are `<short>.<name>` (`helm cmd word-tools.about`). Two plugins can both have a tool called `search` without clashing.

## 3. Lifecycle

```
installed ──enable──▶ stopped ──first use──▶ starting ──initialize ok──▶ active ──idle 10 min──▶ stopped
                         ▲                      │                          │
                         │                      ▼ timeout / exit           ▼ crash
                      disable              failed (explained)        restarted on next use
                                                                      3 crashes in 5 min ──▶ quarantined
```

1. **Install.** The host validates the manifest, checks `engines` against its own version and protocol, and shows the consent screen. Only then does it copy your files (or link the folder). Your code doesn't run during install.
2. **Activation.** Plugins start lazily, when one of their contributions is first used (`activation` can also ask for `onStartup` or `onSession`). The host spawns your process in the sandbox and sends `initialize`, which carries your config, grants, workspace and isolation level. The SDK runs your `activate(ctx)` and replies with the handlers you implement. The default deadline is 10 s.
3. **Calls.** Tool, command, hook, panel and provider requests arrive as JSON-RPC requests. Up to `maxConcurrency` (4) run at once, each with a deadline (`callTimeoutMs`, 30 s by default) and an `AbortSignal` (`ctx.signal`, or `ctx.cancelled` in Python) that fires when the user cancels or the deadline passes.
4. **Config changes.** When the user changes a setting, `ctx.config` is updated in place and your optional `onConfigChange(config, ctx)` runs. No restart is needed.
5. **Shutdown.** After 10 minutes idle, on `disable`, on `revoke` or when Helm exits, the host sends `shutdown` (your `deactivate(ctx)` runs) and then `exit`. A process that ignores this is killed after a grace period.

Anything you keep in memory is lost when the process stops. Persist state with `ctx.storage` (a small JSON key-value store) or files in `ctx.plugin.dataDir`.

## 4. Contribution points

### Tools

Functions the model can call. `effect` tells the user and the host what kind of thing the tool does: `read`, `write`, `external` (talks to the outside world) or `exec`. `requires` lists the permissions the tool needs, so the host can hide it, with a reason, when the user hasn't granted them. Set `approval: "ask"` to have the user confirm each call. A tool's description and input schema are what the model reads, so write them for the model.

Return a string (text), `{ content: [...] }` (a full `ToolResult`), or any JSON value (serialized). Throw `new PluginError('path must be relative', 'INPUT_INVALID')` to fail with a code and message the model and user can read. Unexpected exceptions become `TOOL_ERROR` with your message, and stack traces go to the plugin log.

### Providers

A model backend for the agent loop. Implement `complete(req, ctx)`: the request has `model`, `messages` (system/user/assistant/tool, with tool calls) and `tools` (JSON Schemas). Return `{ message: { role: 'assistant', content, toolCalls? }, model, usage? }`. Optionally implement `models(ctx)`. `plugins/openrouter` is a complete real-world example (tool calling, reasoning passthrough, fallbacks, model policy), and `plugins/mock-model` is a minimal deterministic one.

### Hooks

React to host events: `session.start`, `session.end`, `message.user`, `model.response`, `tool.before`, `tool.after`, `tool.error`, `plugin.state`.

- `mode: "watch"` hooks are notifications. They can't change anything and the host doesn't wait for them. Message events (`message.user`, `model.response`) need the `conversation.read` permission. Without it, tool watch hooks still fire, but `input` and `output` are removed (listed in `payload.redacted`).
- `mode: "intercept"` hooks (only `tool.before` and `tool.after`) are awaited in `priority` order (higher first) and may return `{ action: 'continue' }`, `{ action: 'block', reason }`, `{ action: 'ask', reason }` (the user decides) or `{ action: 'modify', input?, output?, reason? }`. They need the `tool.intercept` permission.
- Plugins can talk to each other through events. `ctx.events.emit('indexed', {...})` from `acme.search` reaches any plugin with a `{ "event": "plugin.acme.search.indexed", "mode": "watch" }` hook, as `{ source, payload }`. That's loose coupling: no plugin calls another's code.
- `onError: "block"` makes an intercept hook **fail closed**: if it crashes or times out, the call is blocked rather than allowed. Use this for policy plugins. `plugins/guard` is the reference.

### Commands

User-invoked actions: `helm cmd <short>.<name> key=value`, or a button in the console. Declare `args` as a JSON Schema to have them validated. Return text or a UI tree.

### Panels

Live views rendered by the CLI (`helm panel <short>.<id>`) and the console (next to the chat). `render(ctx)` returns a **declarative UI tree**, not HTML. Plugins never run code in the console page. Call `ctx.ui.refresh('<id>')` to have the console re-render the panel.

```ts
ui.stack(
  ui.heading('Repository'),
  ui.keyValue({ branch: 'main', ahead: 0 }),
  ui.table(['file', 'status'], [['a.txt', 'modified']]),
  ui.badge('clean', 'success'),
  ui.button('Refresh', 'refresh'),          // runs your `refresh` command
)
```

Node types: `stack`, `heading`, `text` (with an optional `tone`: `success`, `warning`, `danger`, `muted`), `markdown` (rendered safely), `keyValue`, `table`, `list`, `badge`, `button`.

### Configuration

`contributes.configuration` is a JSON Schema for your settings. The host fills in defaults, validates changes (`helm plugin config <id> set key value`, or the console's settings form) and passes the result as `ctx.config`. Secrets don't belong here: declare the `secrets` permission and read them with `ctx.secrets.get(name)`.

## 5. The context: what a plugin can do

Everything that touches the outside world goes through `ctx`, and the host checks it against the user's grants. TypeScript names are shown, and Python uses snake_case (`read_text`, `max_bytes`, `timeout_ms`).

| API | Needs | Notes |
| --- | --- | --- |
| `ctx.fs.read(path, {encoding, maxBytes})`, `readText`, `list`, `stat` | `fs.read` on that path | Relative paths resolve against the workspace. Symlinks are resolved before the check. |
| `ctx.fs.write(path, content, {createDirs})`, `mkdir`, `remove` | `fs.write` on that path | |
| `ctx.net.fetch(url, {method, headers, body, timeoutMs, maxBytes})` | `net.http` for that host | Every redirect is re-checked. Private and loopback addresses need `net.local`. 5 MB default, 20 MB maximum. |
| `ctx.process.exec(command, args, {cwd, timeoutMs, input})` | `process.exec` for that command | The host spawns it in a sandbox. Your process can't spawn directly. |
| `ctx.secrets.get(name)` | `secrets` for that name | Values are redacted from logs, transcripts and the audit log. |
| `ctx.storage.get/set/delete/list` | none | Per-plugin JSON key-value store. |
| `ctx.llm.complete({messages, maxTokens})` | `llm.invoke` | Uses the user's current provider. |
| `ctx.events.emit(name, payload)` | none | Shows up in the activity stream. |
| `ctx.ui.notify(message, level)`, `ctx.ui.refresh(panel?)` | none | |
| `ctx.log.debug/info/warn/error` | none | Goes to `helm plugin logs <id>`. |
| `ctx.progress(message)` | none | Live progress line for the current call. |
| `ctx.config`, `ctx.workspace`, `ctx.grants`, `ctx.isolation`, `ctx.plugin` | none | Read-only facts. |
| `ctx.signal` (`ctx.cancelled` in Python) | none | Fires on cancel or timeout. Stop work and return. |

**Don't use `fs`, `fetch` or `child_process` directly.** Under strict isolation the OS sandbox blocks them: reads outside your plugin folder, any network socket and spawning programs all fail with `EPERM`. Code that works in a unit test and fails at run time is the most common first-plugin mistake, and the dev console makes it obvious immediately.

**stdout belongs to the protocol.** The SDK redirects `console.log` and `print` to the log for you. A plugin that writes raw non-protocol bytes to stdout is stopped with `PROTOCOL_ERROR`. Use stderr or `ctx.log`.

## 6. Permissions

Declare every permission with a `reason` written for the user: it appears verbatim on the consent screen. Ask for as little as you can, and narrow scopes:

```json
"permissions": [
  { "id": "fs.read", "scope": ["${workspace}"], "reason": "Read the files you ask about." },
  { "id": "fs.write", "scope": ["${workspace}"], "optional": true, "reason": "Edit files when you ask. Without this, read-only." },
  { "id": "net.http", "scope": ["api.github.com"], "reason": "Look up issues." },
  { "id": "process.exec", "scope": ["git"], "reason": "Run git." },
  { "id": "secrets", "scope": ["GITHUB_TOKEN"], "optional": true, "reason": "Access private repositories." }
]
```

| Permission | Scope | Risk |
| --- | --- | --- |
| `fs.read` / `fs.write` | paths; `${workspace}` and `${pluginData}` expand at run time | medium / high |
| `net.http` | host patterns (`api.github.com`, `*.wikipedia.org`, `*` for any) | medium (one host) to high (any) |
| `net.local` | none | high: localhost and private networks |
| `process.exec` | command names | high |
| `secrets` | secret names | high |
| `conversation.read` | none | medium: receive message contents in hooks |
| `tool.intercept` | none | high: block or modify other plugins' calls |
| `llm.invoke` | none | medium: spend the user's model budget |

`optional: true` lets the user decline. Design for that: list the permission in your tools' `requires`, and those tools disappear, with a reason, instead of failing. `userExtensible: true` invites the user to widen or narrow a scope (the Web plugin uses it for hosts). Users can revoke anything at any time, so handle `PERMISSION_DENIED` gracefully. An update that adds or widens a permission makes the host ask again for just those.

## 7. Testing

Unit-test handlers in-process against a fake host, no sandbox or process needed:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, callTool, resultText } from '@helm-agent/plugin-sdk/testing';
import plugin from '../src/index.ts';

test('count_lines reads through ctx.fs', async () => {
  const ctx = createTestContext({ files: { 'notes.txt': 'a\nb\nc' }, config: { greeting: 'Ahoy' } });
  assert.equal(resultText(await callTool(plugin, 'count_lines', { path: 'notes.txt' }, ctx)), 'notes.txt has 3 lines');
});
```

`createTestContext` accepts `files`, `config`, `workspace`, `secrets`, `fetch` (a function returning fake responses), `exec` and `grants`. When you pass `grants`, the fake host enforces them like the broker does, so a test can assert that an out-of-scope call is refused. The context records `logs` and `events.emitted` for assertions. `runCommand`, `renderPanel` and `callHook` cover the other handler kinds.

Python has the same shape in `helm_plugin_testing`:

```python
import unittest
from helm_plugin_testing import make_context, call_tool, text_of
import main

class T(unittest.TestCase):
    def test_count(self):
        ctx = make_context(files={"notes.txt": "a\nb\nc"})
        self.assertEqual(text_of(call_tool(main.plugin, "count_lines", {"path": "notes.txt"}, ctx)), "notes.txt has 3 lines")
```

`helm plugin test .` runs `test/*.test.ts` with Node's test runner, or `test_*.py` with `unittest`, with the SDK on the path. Then use `helm plugin dev .` to exercise the real thing.

## 8. Debugging

| Symptom | Where to look |
| --- | --- |
| Tool missing from `helm tools` | `helm tools` shows the reason: not granted, disabled, quarantined or incompatible |
| Plugin won't start | `helm plugin info <id>` (last error and stderr tail), `helm plugin logs <id>` |
| `ACTIVATION_TIMEOUT` | `activate()` took more than 10 s. Do slow work lazily, or raise `limits.activationTimeoutMs`. |
| `PERMISSION_DENIED` | The message names the permission, the target and your granted scope. `helm plugin permissions <id>`. |
| `EPERM` / `ERR_ACCESS_DENIED` in your logs | You used `fs`, `fetch` or `child_process` directly. Use `ctx.*`. |
| `PROTOCOL_ERROR` | Something wrote raw text to stdout. |
| "declared but not implemented" warning | Manifest and code disagree. Fix the name in one of them. |
| Crashes, then `PLUGIN_QUARANTINED` | `helm plugin logs <id>`, fix it, `helm plugin reset <id>` |

In the dev console, `trace on` prints every protocol message in both directions, `logs` tails your log, `grants` shows what you were granted, `hook tool.before {...}` sends a synthetic hook event, and `reload` restarts. `helm plugin validate .` checks the manifest (schema and semantics, all problems at once), compatibility, and which isolation level you'll get here.

## 9. Packaging, publishing and updating

```sh
helm plugin validate .
helm plugin pack .                       # → acme.word-tools-0.1.0.hplugin.tgz (+ sha256)
helm plugin install ./acme.word-tools-0.1.0.hplugin.tgz
helm plugin install https://github.com/acme/word-tools.git   # or straight from git
```

A registry is a JSON index of plugins: id, name, description, versions with source (folder, `.tgz` URL with `sha256`, or git URL plus ref), and tags. Users add registries in `~/.helm-agent/config.json` (`registries`). The bundled one is `registry/index.json`.

Follow semver. Raise `version` for every release, and keep `engines.helm` honest: a user on a Helm outside your range gets a clear `INCOMPATIBLE_VERSION` message instead of a broken plugin. On `helm plugin update`, users see only new or wider permissions, trust is reset because the code changed, and `helm plugin rollback` restores your previous version with its grants and config.

## 10. Writing a plugin in another language

The SDKs are conveniences. The contract is the [protocol](protocol.md): newline-delimited JSON-RPC 2.0 over stdin and stdout. Set `"runtime": { "type": "exec", "command": ["./my-plugin"] }`, answer `initialize`, and implement the request methods for your contributions. Your process gets the same sandbox and the same rules. A good way to start is to run `trace on` in the dev console against an existing plugin and copy what you see.

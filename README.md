# Helm

Helm is a local AI agent harness where **every capability is a plugin**. The host knows how to run a conversation, supervise processes and enforce permissions. Everything else comes from plugins: which model it talks to, which tools the agent can use, which policies apply and which panels you see. Plugins run as separate sandboxed processes and talk to the host over a small JSON-RPC protocol.

You use it from a **CLI** (`helm`) and a **local web console** (`helm serve`). Both are thin layers over the same core.

```
                    ┌──────────────────────── Helm host (Node) ───────────────────────┐
  you ── CLI ───────┤  agent loop ── provider plugin (OpenRouter | mock | yours)       │
  you ── console ───┤  contribution registry: tools · commands · hooks · panels        │
                    │  supervisor: spawn · handshake · timeouts · crash → quarantine    │
                    │  permission broker: grants · fs/net/exec/secrets · audit log      │
                    └───────────┬────────────── JSON-RPC 2.0 over stdio ───────────────┘
              ┌─────────────────┴───┐   ┌────────────────────┐   ┌────────────────────┐
              │ macOS sandbox        │   │ macOS sandbox       │   │ macOS sandbox       │
              │ node --permission    │   │ python3 main.py     │   │ node --permission   │
              │ helm.files (TS)      │   │ helm.web (Python)   │   │ helm.guard (TS)     │
              └──────────────────────┘   └─────────────────────┘   └─────────────────────┘
```

## Quick start

Requirements: macOS, Node 22.18+ (runs the TypeScript sources directly, no build step), Python 3.9+ for Python plugins, git.

```sh
npm install
export PATH="$PWD/bin:$PATH"       # or: npm link

helm doctor                        # runtimes, sandbox, plugins
helm init                          # installs the starter plugins; shows a consent screen for each
helm secrets set helm.openrouter API_KEY        # paste your OpenRouter key (stored in the Keychain)
helm chat                          # talk to the agent
helm serve --open                  # the web console on 127.0.0.1
```

No key yet? `helm provider use helm.mock-model/mock` switches to an offline scripted model. Type `call files__read_file {"path":"README.md"}` to see a tool call go through the whole pipeline.

To see every feature at once in a throwaway home: `npm run demo`. Run it from a normal terminal, because IDE and agent terminals usually block the macOS sandbox.

## What is a plugin?

A folder with a `helm-plugin.json` manifest and an entry point:

```json
{
  "manifestVersion": 1,
  "id": "acme.word-tools",
  "name": "Word Tools",
  "version": "0.1.0",
  "description": "Counts words in workspace files.",
  "engines": { "helm": ">=0.1.0 <1.0.0", "protocol": "^1.0" },
  "runtime": { "type": "node", "entry": "src/index.ts" },
  "permissions": [{ "id": "fs.read", "scope": ["${workspace}"], "reason": "Read the files you ask about." }],
  "contributes": {
    "tools": [{ "name": "count_words", "description": "Count words in a file", "effect": "read",
                "inputSchema": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] } }]
  }
}
```

```ts
import { definePlugin } from '@helm-agent/plugin-sdk';
export default definePlugin({
  tools: {
    async count_words({ path }: { path: string }, ctx) {
      const text = await ctx.fs.readText(path);   // checked against the fs.read grant
      return `${path} has ${text.split(/\s+/).filter(Boolean).length} words`;
    },
  },
});
```

`helm plugin new word-tools` scaffolds this (TypeScript, or `--lang python`) with a passing test. `helm plugin dev .` links it, hot-reloads it on save and gives you a console to call it through the real sandbox. The [Plugin Guide](docs/plugin-guide.md) gets you from zero to a working plugin in about five minutes.

Plugins can contribute:

| Contribution | What it adds | Example |
| --- | --- | --- |
| `tools` | Functions the model can call | `files__read_file`, `git__git_commit`, `web__web_search` |
| `providers` | A model backend for the agent loop | `helm.openrouter/openrouter`, `helm.mock-model/mock` |
| `hooks` | Observe or intercept events (`tool.before`, `tool.after`, `session.end`, ...) | Guard blocks `.env` reads and redacts keys |
| `commands` | Actions for the user, from the CLI or the console | `helm cmd guard.report` |
| `panels` | Live UI rendered from declarative nodes | `git.repo`, `guard.activity` |
| `configuration` | A JSON Schema the host validates and renders as a form | `helm plugin config helm.web set searchBackend brave` |

## Bundled plugins

The host has no plugin-specific code. A test (`tests/unit/extensibility.test.ts`) fails if any host file names a bundled plugin, tool or provider. These six plugins ship in `plugins/` and install from the bundled registry like any third-party plugin would:

| Plugin | Language | Contributes | Permissions it asks for |
| --- | --- | --- | --- |
| `helm.files` | TypeScript | 5 tools, 1 command, config | `fs.read` workspace; `fs.write` workspace (optional) |
| `helm.git` | TypeScript | 5 tools, 1 command, 1 panel | `process.exec` git; `fs.read` workspace; `fs.write` `.git` only (optional) |
| `helm.web` | **Python** | 2 tools, 1 command, config | `net.http` (narrowable); `secrets` BRAVE_API_KEY (optional) |
| `helm.guard` | TypeScript | 3 hooks (intercept), 3 commands, 1 panel, config | `tool.intercept` |
| `helm.openrouter` | TypeScript | model provider, 2 commands, config | `net.http` openrouter.ai; `secrets` API_KEY |
| `helm.mock-model` | TypeScript | model provider (offline, deterministic) | none |

They exercise different contribution points and languages. Guard changes the behaviour of tools it doesn't own, OpenRouter replaces the brain of the agent loop, and Web is written in Python. Removing any of them removes the capability; nothing else changes.

### Model choice (OpenRouter)

The OpenRouter plugin defaults to **`anthropic/claude-opus-5.5`**, with **`anthropic/claude-sonnet-5.5`** as an automatic fallback and **`anthropic/claude-haiku-5.5`** for "fast" internal calls. Opus 5.5 led the agentic tool-use benchmarks I compared in October 2026 (Terminal-Bench, τ²-bench, MCP Atlas), and OpenRouter preserves its reasoning blocks across tool calls, which multi-step tool use needs. As you asked, the plugin refuses GPT-6 or newer and Claude Fable 5 or newer through a configurable `blockedModels` policy. It checks before sending a request and again against the model OpenRouter actually routed to. Change the model with `helm provider use helm.openrouter/openrouter -m <model>` or in the console. `helm cmd openrouter.models` lists the allowed tool-capable models.

## Using Helm

```sh
helm plugin search [query]            # browse registries
helm plugin install <id|folder|.tgz|git-url>   # consent screen for every permission
helm plugin list / info <id>          # state, contributions, grants, health, recent activity
helm plugin enable|disable <id>
helm plugin config <id> [set <key> <value>]    # validated against the plugin's schema
helm plugin permissions <id>          # requested vs granted, and what enforces each
helm plugin grant|revoke <id> <perm> [--scope a,b]   # effective from the next call
helm plugin update <id> [source]      # asks only about new or wider permissions
helm plugin rollback <id>             # previous version, grants and config
helm plugin logs <id> [-f]            # stderr, SDK logs, lifecycle events
helm plugin reset <id>                # clear crash history / quarantine
helm plugin trust|untrust <id>        # allow running without the OS sandbox (see Security)
helm audit [--denied] [--plugin id]   # every security-relevant decision
helm tools                            # what the agent can use right now, and why not
```

When something fails, Helm tells you **what** happened, **why** and **what to do**. Every error has a stable code, a cause, the relevant plugin output and a fix command. The [User Guide](docs/user-guide.md) covers management and troubleshooting.

## Safety model in one paragraph

Plugins are third-party code, so Helm doesn't trust them. Each one runs in its own process under a generated **macOS sandbox profile**. That profile has no network sockets, no reads of your home folder except granted paths, writes only to its data folder and granted paths, and no executing other programs. Node plugins also run under the **Node permission model**. All file, network, process and secret access goes through the host's **permission broker**, which checks the grant, scopes paths and hosts, blocks private addresses, caps sizes and records an **audit** entry. Permissions are declared in the manifest, granted at install (optional ones can be declined), and can be narrowed or revoked at any time. Secrets live in the Keychain and are redacted from logs and transcripts. If the sandbox can't be applied, for example inside another sandbox, untrusted plugins **refuse to start** unless you explicitly trust them. See [Security](docs/security.md).

## Stability

A crash, hang or memory blow-up stays inside the plugin's process. Calls have timeouts and are cancelled cleanly, and a memory watchdog and V8 heap caps stop runaway allocations. A plugin is **quarantined** after 3 crashes in 5 minutes: its tools are hidden from the agent with an explanation until you `reset` it. A plugin built for an incompatible Helm or protocol version is refused at install, or shown as incompatible and never started if the host changes underneath it. A failing `intercept` hook can be declared fail-closed, so a broken policy plugin blocks calls rather than letting them through.

## Repository layout

```
bin/helm                    CLI launcher
packages/core               host: manifest, store, installer, supervisor, broker, agent loop
packages/cli                the helm CLI (chat, run, plugin *, dev tools)
packages/web                local web console (server + Preact/htm UI, no build step)
packages/sdk-node           TypeScript plugin SDK (+ in-process test harness)
packages/sdk-python         Python plugin SDK, stdlib only (+ helm_plugin_testing)
plugins/                    the six bundled plugins
registry/index.json         bundled registry (starter set, preferred provider)
templates/                  scaffolds used by `helm plugin new`
docs/                       guides, protocol and manifest reference, JSON Schema
tests/                      unit, integration, sandbox and CLI end-to-end tests
scripts/demo.sh             the acceptance walkthrough
```

## Tests

```sh
npm test                    # everything; sandbox-only tests skip with a reason where the sandbox is unavailable
npm run test:sandbox        # strict-isolation tests (run from a normal terminal)
npm run typecheck
```

The suite covers manifest validation and compatibility, path, host and SSRF scoping, crash, timeout and quarantine behaviour, cancellation, consent, update permission diffs and rollback, secrets scoping and redaction, Guard hooks, approvals, and the OpenRouter tool-calling round trip (against a fake transport). It also covers web console token, Host and Origin checks, OS-level containment of Node and Python plugins, and the CLI end to end.

## Documentation

- [Plugin Guide](docs/plugin-guide.md): write, test, debug and ship a plugin
- [Manifest reference](docs/manifest-reference.md) and [JSON Schema](docs/schemas/plugin-manifest-v1.json)
- [Protocol](docs/protocol.md): the host ↔ plugin wire protocol, v1.0
- [Security](docs/security.md): threat model, permissions, isolation layers, limitations
- [User Guide](docs/user-guide.md): managing plugins, the console, troubleshooting
- [PLAN.md](PLAN.md): the original design plan

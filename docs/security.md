# Security model

Helm runs third-party code next to your files, your keys and a language model that can be talked into things. This document says what Helm protects, how, and where the protection ends.

## Threat model

| Actor | Trusted? | Why |
| --- | --- | --- |
| You, at the terminal or console | yes | You grant and revoke everything. |
| The Helm host (`packages/`) | yes | It enforces the rules. It has no plugin-specific code (a test checks this). |
| **Plugins** | **no**, unless you run `helm plugin trust` | Third-party code. It may be buggy, compromised or malicious. |
| **The model** | **no** | Its tool calls can be steered by prompt injection from web pages, files and repository content. |
| Web pages and other local processes | no | They may try to drive the local console. |

Goals, in order:

1. A plugin can reach only what you granted.
2. A misbehaving plugin can't take down Helm or other plugins.
3. Secrets don't leak into plugins that weren't granted them, or into logs and transcripts.
4. When something is blocked, you can see what, why, and how to allow it.

## Isolation levels

Every plugin runs in **its own process**, never inside the host, and gets one of three isolation levels:

| Level | Layers | When |
| --- | --- | --- |
| `strict` | macOS sandbox profile generated from the plugin's grants + permission broker + scrubbed environment + resource limits (+ Node permission model for Node plugins) | Default for every plugin on macOS when Helm runs from a normal terminal. |
| `runtime` | Node permission model + broker + scrubbed environment + limits | Node plugins where the OS sandbox is unavailable, **only if you trusted the plugin**. |
| `basic` | broker + scrubbed environment + limits | Python and `exec` plugins where the OS sandbox is unavailable, **only if you trusted the plugin**. |

**Policy: an untrusted plugin never runs without `strict`.** If the OS sandbox isn't available (another OS, or Helm itself inside another sandbox such as an IDE or agent terminal), untrusted plugins are refused with `ISOLATION_UNAVAILABLE`. The message names the cause and the two ways forward: run Helm from a normal terminal, or `helm plugin trust <id>` after reading the warning. `helm doctor` and `helm plugin validate` show which level a plugin would get before you rely on it. Trust is reset on every update and rollback, because the code changed.

### Layer 1: the OS sandbox (`strict`)

For each launch, Helm writes a Seatbelt profile (`~/.helm-agent/sandbox/<id>.sb`) and starts the plugin with `/usr/bin/sandbox-exec -f <profile>`. The profile is derived from the plugin's **current grants**. Revoking a grant restarts the plugin with a narrower profile.

| Resource | Rule |
| --- | --- |
| Network | `deny network*`: no sockets at all. HTTP goes through the broker (`host/net.fetch`). |
| File reads | Denied in your home folder, `/Users`, `/Volumes`, `/private/tmp` and `/private/var/folders`. Allowed: the plugin's own folder, its runtime (Node or Python install) and SDK, its data folder, and the paths in its `fs.read` and `fs.write` grants. System libraries stay readable so runtimes can start. |
| File writes | Denied everywhere except `/dev/null`, `/dev/zero`, `/dev/tty`, `/dev/fd/*`, the plugin's data folder and paths in its `fs.write` grants. |
| Processes | `deny process-exec*` except the plugin's runtime (and, for `exec` plugins, the plugin folder plus exactly the `#!` interpreter). Programs a plugin needs are started by the broker (`process.exec`). |

The test suite verifies all of this with a Node plugin and a Python plugin that try to read `~/.ssh`-style files, open a socket to 1.1.1.1, spawn `/bin/sh` and write outside their folder (`tests/integration/strict.sandbox.test.ts`, and step 7 of `scripts/demo.sh`). Every attempt fails with `EPERM`.

### Layer 2: the Node permission model (Node plugins)

Node plugins start with `node --permission`, `--allow-fs-read` and `--allow-fs-write` limited to the same paths as the sandbox profile, and `--max-old-space-size=<memoryMb>`. No `--allow-child-process`, `--allow-worker`, `--allow-addons`, `--allow-wasi` or `--allow-net`, so all of those are denied (`ERR_ACCESS_DENIED`). Network gating needs a Node version whose permission model covers it, such as Node 26, where Helm was tested. On older versions, only the OS sandbox stops a Node plugin's raw sockets. Node's own documentation describes the permission model as a seat belt for trusted code, not a boundary against malicious code. That's why Helm treats it as defence in depth under `strict`, and as sufficient on its own only for plugins you trust.

### Layer 3: the permission broker

Everything a plugin does to the outside world goes through host APIs (`host/fs.*`, `host/net.fetch`, `host/process.exec`, `host/secrets.get`, `host/llm.complete`). The broker checks each call **at the time of the call** against the plugin's grants, so revocation is immediate even for a running plugin. It rate-limits calls and records every decision in the audit log.

- **Files.** Paths are made absolute against the workspace and canonicalized (symlinks resolved) *before* the scope check, so `link-to-home/.ssh/id_rsa` doesn't pass as a workspace path.
- **Network.** The host must match the `net.http` scope at every redirect hop (5 at most). Loopback, private, link-local and `.local` targets are refused unless `net.local` is granted. The check runs on the resolved IP too, so a public name pointing at 127.0.0.1 is still refused. Responses are capped (5 MB default, 20 MB maximum), as are timeouts (30 s default, 300 s maximum).
- **Processes.** `process.exec` takes a bare program name that must be in the grant's scope (`git`, never `/tmp/git`). The program runs with a scrubbed environment (no `DYLD_*`, `LD_*`, `PATH` or `HOME` overrides) and, under `strict`, inside its own sandbox: the plugin's file grants and **no network**.
- **Secrets.** `secrets.get` returns only names in the grant's scope.

### Layer 4: environment and resources

- **Environment.** Plugins never inherit your shell environment, so `OPENROUTER_API_KEY`, `AWS_*` and `GITHUB_TOKEN` are simply absent. A plugin gets `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, a private `HOME` and `TMPDIR` under its data folder, `LANG`/`LC_ALL`, and `HELM_PLUGIN_ID`, `HELM_PLUGIN_DATA` and `HELM_PROTOCOL`.
- **Resources.** Per-call deadlines with cancellation, a liveness ping after a timeout (a wedged process is killed), an RSS memory watchdog (polled every 1.5 s) plus a V8 heap cap, bounded concurrency, a bounded stdout line size, and a cap on non-protocol output.
- **Crashes.** A crash fails only that plugin's in-flight calls. Three crashes within five minutes quarantine the plugin until `helm plugin reset <id>`.

## Permissions: declare, consent, grant, revoke

1. **Declare.** The manifest lists each permission with a scope and a human `reason`. A plugin can't use a permission it didn't declare.
2. **Consent.** Install shows every permission with its risk (low, medium or high), what it means in plain words, the scope with variables explained ("inside the current workspace"), and the plugin's reason. Optional permissions can be declined, and user-extensible scopes can be edited. Nothing is copied or run before consent.
3. **Grant.** Decisions are stored in `~/.helm-agent/state.json`. `helm plugin permissions <id>` shows them, along with what each one enables.
4. **Revoke.** `helm plugin revoke <id> <perm>` takes effect on the next call (the broker), and the process restarts with a narrower sandbox. Tools that require the revoked permission become unavailable and show the reason.
5. **Update.** `helm plugin update` diffs permissions and asks only about new scopes your current grant doesn't already cover. A release that asks for less gets less: grants are narrowed to the new declared scope, and permissions it no longer requests are removed, each with a note. Trust is reset, and `helm plugin rollback` restores the previous version with its exact previous grants.

Beyond plugin permissions, you control the **agent**: `approvals` in `config.json` sets per-effect policy (`read`, `write`, `external`, `exec` → `allow`, `ask` or `deny`; by default `write` and `exec` ask), tools can demand approval (`approval: "ask"`), and policy plugins such as Guard can block or ask through intercept hooks. Intercept hooks declared `onError: "block"` **fail closed**: if Guard crashes, times out or is quarantined, tool calls are blocked rather than silently allowed. Disabling Guard on purpose is respected.

## Secrets

- **Storage.** macOS Keychain by default. Helm drives `/usr/bin/security` interactively, so values never appear in `argv` or `ps`. Otherwise it uses an AES-256-GCM encrypted file with a random key stored in a `0600` file. `helm secrets set <id> <name>` prompts without echo.
- **Scope.** A plugin sees a secret only through `secrets.get`, and only for names it was granted. It never sees your environment.
- **Redaction.** Every secret value the host stores or hands out is registered with a redactor. That value is replaced in plugin logs, notifications, audit entries, transcripts and the console. Credentials the host *doesn't* know about, such as a key sitting in a file the model reads, are a policy question, so a plugin handles them: Guard's `tool.after` hook removes token-shaped strings (`sk-…`, `ghp_…`, `AKIA…`, private-key blocks; configurable `redactPatterns`) from tool output before the model sees it. The agent tests check both with planted keys.

## The web console

`helm serve` binds **127.0.0.1 only**.

- **Token.** A random 192-bit token is generated per run and passed in the URL fragment (`#token=…`, never sent in requests or logged). The page then sends it as `x-helm-token`, compared in constant time. Without it, every API returns 401.
- **DNS rebinding and CSRF.** Requests whose `Host` isn't `127.0.0.1:<port>` or `localhost:<port>` are refused. State-changing requests with a foreign `Origin` are refused.
- **CSP.** `default-src 'self'`, no inline script, no framing.
- **Plugin UI is data, not code.** Panels and command results are declarative UI trees rendered by the console's own components, and Markdown is rendered without raw HTML. A plugin can't run script in the console or read other plugins' data through it.

## The audit log

Every broker decision (allowed or denied, with permission, target and reason), every approval, every hook block and every lifecycle change (install, update, rollback, grant, revoke, trust, enable, disable, crash, quarantine) is appended to `~/.helm-agent/audit.jsonl` with secrets redacted. Browse it with `helm audit [--plugin <id>] [--denied]` or the console's Activity view.

## Limitations

- **Strict isolation is macOS-only.** It relies on `sandbox-exec` and Seatbelt, which Apple marks deprecated but which still ships and is used by major applications. On other systems, untrusted plugins are refused. A Linux backend (bubblewrap or Landlock plus seccomp) would slot into `runtime/launch.ts`.
- **Trusted means trusted.** A trusted Python or `exec` plugin outside the sandbox can do whatever your user account can, even though the broker still governs host APIs. A trusted Node plugin keeps the Node permission model, which is not a boundary against malicious code.
- **Grants compose.** A plugin with `fs.read` on your workspace and `net.http` on `*` can send your workspace anywhere. The consent screen rates both permissions, but read the combination. Prefer narrow host scopes.
- **The model is persuadable.** Permissions bound what a tool *can* do, not what the model *asks* it to do. Use `ask` approvals for `write` and `exec` tools, keep Guard enabled, and review tool calls on untrusted content.
- **CPU isn't capped.** Only time is (deadlines and the liveness ping). The memory watchdog polls, so short spikes above the limit are possible.
- **Same user.** Plugins run as your user. The sandbox restricts them, but Helm is not a multi-user security boundary.

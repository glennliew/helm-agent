# User guide

## Install and set up

Requirements: macOS, Node.js 22.18 or newer (Helm runs TypeScript directly, with no build step; tested with Node 26), and Python 3 for Python plugins (tested with 3.10).

```sh
git clone <this repo> helm && cd helm
npm install
export PATH="$PWD/bin:$PATH"     # or symlink bin/helm somewhere on your PATH
helm init
```

`helm init` creates `~/.helm-agent` (set `HELM_AGENT_HOME` to use another folder) and offers the starter plugins from the bundled registry. For each plugin you see a **consent screen**: what it is, what it contributes, and every permission it asks for, with a risk level and the publisher's reason. Optional permissions can be declined. `helm init --yes` accepts the defaults.

Then give the model provider its key and check everything:

```sh
helm secrets set helm.openrouter API_KEY                     # prompts without echo
# or import it:  helm secrets set helm.openrouter API_KEY --from-dotenv .env --var OPENROUTER_API_KEY
helm doctor
```

`helm doctor` checks the runtimes, whether the OS sandbox works from where you're running Helm, and every plugin: compatible, isolated, granted, configured and able to start. Each problem comes with the command that fixes it.

**Run Helm from a normal terminal.** If Helm runs inside another sandbox (some IDE terminals and agent tools), the macOS sandbox can't be applied, so untrusted plugins are refused rather than run with weaker isolation. `helm doctor` tells you when this is the case.

## Talk to the agent

```sh
helm chat                       # interactive
helm run "summarise README.md"  # one shot; --json for machine-readable events
helm -C ~/code/project chat     # pick the workspace (default: current directory)
```

The workspace is the folder plugins may access by default (`${workspace}` in their permissions). In chat:

| Command | Does |
| --- | --- |
| `/tools` | tools from all plugins, and why any are unavailable |
| `/plugins` | installed plugins and their status |
| `/model [id]` | show or switch the model |
| `/cmd <plugin.command> k=v` | run a plugin command |
| `/panel <plugin.panel>` | render a plugin panel |
| `/clear` | new conversation |
| `/exit` | quit (Ctrl-C cancels a running turn) |

Tool calls show as they happen, with the plugin that served them. When a tool needs approval (by default, anything that writes or executes), Helm shows what will run with which input, and you answer **y**es, **n**o or **a**lways (for this session).

### Models

Providers are plugins too. `helm provider list` shows them, `helm provider models` lists models, and `helm provider use helm.openrouter/openrouter --model anthropic/claude-sonnet-5.5` sets the default. The OpenRouter plugin defaults to `anthropic/claude-opus-5.5`, falls back to `anthropic/claude-sonnet-5.5`, and uses `anthropic/claude-haiku-5.5` for quick internal calls. Its `blockedModels` setting refuses GPT-6 and newer and Claude Fable 5 and newer, along with OpenRouter's auto-routers, which could otherwise pick one. `helm.mock-model` is a deterministic offline provider for demos and tests.

## The web console

```sh
helm serve --open        # http://127.0.0.1:4317, opened with a one-time access token
```

The console shows the same things as the CLI:

- **Chat**: live tool-call cards showing which plugin served each call, approvals as dialogs, and plugin panels (such as Git's repository view and Guard's activity) alongside.
- **Plugins**: one page per plugin, with tabs for Overview (runtime, isolation, health, contributions), Permissions (grant and revoke), Settings (a form generated from the plugin's schema), Secrets (names only, never values), Logs and Activity.
- **Marketplace**: registry search, and install through the same consent screen as the CLI.
- **Tools & commands**: everything plugins contribute, and why anything is unavailable.
- **Audit trail**: every grant, broker decision, hook block and approval.
- **Settings**: approvals, the default provider and model, and registries.

The console listens on 127.0.0.1 only and requires the token in the link it prints. Stopping `helm serve` invalidates the token.

## Manage plugins

| Task | Command |
| --- | --- |
| See what's installed | `helm plugin list` (`helm status` for an overview) |
| Find plugins | `helm plugin search [query]` |
| Install | `helm plugin install <registry id \| folder \| file.hplugin.tgz \| git URL>` (`--link` to use a folder in place) |
| Inspect | `helm plugin info <id>`: manifest, contributions, grants, config, isolation, health, last error |
| Enable / disable | `helm plugin enable <id>`, `helm plugin disable <id>` |
| Configure | `helm plugin config <id>` (show), `… set <key> <value>`, `… unset <key>` |
| Update | `helm plugin update <id>`: shows only the permission changes, keeps your grants and config |
| Roll back | `helm plugin rollback <id>`: previous version, grants and config |
| Uninstall | `helm plugin uninstall <id>` (`--purge` also deletes its data and secrets) |
| Call a tool directly | `helm plugin call <id> <tool> key=value` |
| Read its log | `helm plugin logs <id>` |

### Permissions

`helm plugin permissions <id>` lists what the plugin declares, what you granted, and what each grant lets it do.

```sh
helm plugin grant helm.web net.http --scope '*.wikipedia.org,api.search.brave.com'
helm plugin revoke helm.git process.exec
```

Revoking takes effect on the plugin's next request, even while it's running. Tools that need a revoked permission disappear from the agent, and `helm tools` says why. Every grant, revoke and broker decision is in `helm audit` (`--plugin <id>`, `--denied`).

### Trust

Untrusted plugins run only inside the macOS sandbox. `helm plugin trust <id>` lets a plugin you've reviewed run with reduced isolation when the sandbox isn't available. Helm prints exactly which protections remain before asking you to confirm. Trust applies to the reviewed code only, so it's reset on update and rollback. `helm plugin untrust <id>` revokes it.

### Secrets

`helm secrets set <plugin> <name>` stores a key in the macOS Keychain (or an encrypted file) for that plugin. The plugin must declare that secret name, and you must have granted it. `helm secrets list` shows names, never values. Plugins can't see your shell environment.

### Limits

`helm plugin limit <id> callTimeoutMs 120000` overrides a plugin's limit. The keys are `callTimeoutMs`, `activationTimeoutMs`, `maxConcurrency`, `memoryMb` and `idleTimeoutMs`. Omit the value to return to the plugin's default. `helm plugin info <id>` shows the limits in effect.

## When something goes wrong

Every error has a code, a plain explanation and a next step. `helm explain <CODE>` prints them, and `helm explain` lists every code.

| You see | Meaning | Do |
| --- | --- | --- |
| `ISOLATION_UNAVAILABLE` | The macOS sandbox can't be applied here, and the plugin isn't trusted | Run Helm from a normal terminal, or review the plugin and `helm plugin trust <id>` |
| `PERMISSION_DENIED` | The plugin tried something outside its grants. The message names the permission, the target and your granted scope. | Grant a wider scope if that's what you want, or ignore it |
| `CALL_TIMEOUT` | The plugin didn't answer in time and the call was cancelled | Retry, or raise `callTimeoutMs` |
| `PLUGIN_CRASHED` | The plugin process died. Only its in-flight calls failed. | `helm plugin logs <id>`. It restarts on next use. |
| `PLUGIN_QUARANTINED` | Three crashes within five minutes, so Helm stopped starting it | Check the logs, update it, then `helm plugin reset <id>` |
| `MEMORY_LIMIT` | The plugin exceeded `memoryMb` | Raise the limit, or report it to the publisher |
| `INCOMPATIBLE_VERSION` | The plugin needs a different Helm or protocol version | Update the plugin, or Helm |
| `NO_PROVIDER` | No model provider is installed, enabled and configured | `helm provider list`, `helm doctor` |

Helm keeps running whatever a plugin does: each plugin is its own process, and failures are reported, contained and recorded in `helm plugin info <id>` (last error and stderr) and `helm audit`.

## Files Helm keeps

```
~/.helm-agent/
├── config.json        host settings: approvals, default provider, registries (helm config)
├── state.json         installed plugins, versions, grants, config, trust, health
├── audit.jsonl        append-only audit log
├── plugins/<id>/<version>/   installed plugin code (previous version kept for rollback)
├── data/<id>/         each plugin's private files/, home/, tmp/ and storage.json
├── sandbox/<id>.sb    generated sandbox profiles (useful to read)
├── logs/<id>.log      plugin logs
└── sessions/          chat transcripts (secrets redacted)
```

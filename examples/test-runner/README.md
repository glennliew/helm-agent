# Test Runner (example plugin)

Runs a project's Python unit tests so the agent can check its own changes. This is the plugin written in Act 2 of the [walkthrough](../../docs/walkthrough.md). It's a small, complete example of a plugin that needs a high-risk permission and uses it safely.

| Contributes | |
|---|---|
| tool `run_tests` (`exec`) | Runs `python3 -m unittest discover -v` (optionally `-k <pattern>`) and returns a pass/fail list with failure details |
| command `run` | Runs the tests and renders the result |
| panel `tests` | Shows the last run, stored with `ctx.storage` |
| config | `startDir` (default `.`), `timeoutSeconds` (default 60, max 120) |

**Permissions.** The plugin asks for `process.exec` limited to `python3`, and `fs.read` for the workspace. It never spawns anything itself, and its sandbox wouldn't let it. It asks the host through `ctx.process.exec`. The host checks that call against your grant, runs `python3` in a child sandbox with no network access, and records every run in the audit trail. If you revoke `process.exec`, the tool disappears from the agent and the agent is told why.

```sh
helm plugin test examples/test-runner              # 4 unit tests against the fake host
helm -C <your-project> plugin dev examples/test-runner   # real host, hot reload
helm plugin install ./examples/test-runner         # or Marketplace → Install from elsewhere
```

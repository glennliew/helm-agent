# {{title}}

A Helm plugin (`{{id}}`).

```sh
helm plugin dev .        # link, start, hot-reload on save, interactive console (call/cmd/panel/logs)
helm plugin test .       # unit tests with the in-process fake host (no sandbox needed)
helm plugin validate .   # manifest + compatibility + isolation check
helm plugin pack .       # build {{id}}-0.1.0.hplugin.tgz to share
```

In the dev console:

```
call hello name=Ada
call count_lines {"path":"README.md"}
cmd about
logs
```

Files:

- `helm-plugin.json` — identity, permissions and everything the plugin contributes (tools, commands, hooks, panels, providers, configuration). Helm reads it **without running your code**, so users see what you ask for before installing.
- `src/index.ts` — `export default definePlugin({...})` with handlers whose names match the manifest.
- `test/index.test.ts` — fast unit tests via `@helm-agent/plugin-sdk/testing`.

The plugin runs in its own process inside a sandbox. Use `ctx.fs`, `ctx.net`, `ctx.process`, `ctx.secrets` and `ctx.storage`: the host checks each call against the permissions the user granted. See the Plugin Guide in the Helm repository (`docs/plugin-guide.md`).

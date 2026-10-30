# {{title}}

A Helm plugin (`{{id}}`) written in Python (3.9+, standard library only).

```sh
helm plugin dev .        # link, start, hot-reload on save, interactive console
helm plugin validate .   # manifest + compatibility + isolation check
helm plugin pack .       # build {{id}}-0.1.0.hplugin.tgz to share
```

In the dev console: `call hello name=Ada`, `call word_count path=README.md`, `cmd about`, `logs`.

`helm_plugin` is provided by the host (no pip install). Handlers are plain functions `(input, ctx)`; return a string, a dict/list (sent as JSON), or `ui.*` nodes from commands. `print()` goes to the plugin log, never into the protocol. Use `ctx.fs`, `ctx.net.fetch`, `ctx.secrets.get`, `ctx.storage` — each call is checked against the permissions the user granted.

"""In-process test harness for Helm Python plugins: call handlers with a fake host.

No sandbox and no processes, so tests run in milliseconds. ``helm plugin test`` puts this module on
``PYTHONPATH`` and runs ``python3 -m unittest discover -p 'test_*.py'`` in your plugin folder.

    import unittest
    from helm_plugin_testing import make_context, call_tool, text_of
    import main

    class T(unittest.TestCase):
        def test_greet(self):
            ctx = make_context(config={"greeting": "Hi"})
            self.assertEqual(text_of(call_tool(main.plugin, "greet", {"name": "Ada"}, ctx)), "Hi, Ada!")

The fake host mirrors the real one's rules where it matters for plugin code: fs access is limited to
the in-memory ``files``; network calls go to your ``fetch`` function (or fail with PERMISSION_DENIED
when you pass none); ``secrets.get`` only returns names you supplied. Every host call is recorded in
``ctx.host.calls`` so tests can assert on what the plugin asked for.
"""
import json
import os
from typing import Any, Callable, Dict, List, Optional, Tuple

from helm_plugin import Context, PluginError, _to_result

__all__ = ["make_context", "call_tool", "run_command", "render_panel", "run_hook", "text_of", "config_defaults", "FakeHost"]


class FakeHost:
    def __init__(self, files: Dict[str, str], fetch: Optional[Callable[[dict], Any]], secrets: Dict[str, str]):
        self.files = dict(files)
        self.fetch = fetch
        self.secrets = dict(secrets)
        self.storage: Dict[str, Any] = {}
        self.calls: List[Tuple[str, Any]] = []
        self.notifications: List[Tuple[str, Any]] = []
        self.events: List[Tuple[str, Any]] = []

    # The Context only needs these two methods from its runtime.
    def notify(self, method: str, params: Any) -> None:
        self.notifications.append((method, params))

    def request(self, method: str, params: Any, timeout: float = 0) -> Any:
        self.calls.append((method, params))
        p = params or {}
        if method == "host/fs.read":
            path = _norm(p["path"])
            if path not in self.files:
                raise PluginError(f"No such file: {path}", "NOT_FOUND")
            return {"content": self.files[path], "encoding": "utf8", "size": len(self.files[path])}
        if method == "host/fs.write":
            self.files[_norm(p["path"])] = p["content"]
            return {"bytes": len(p["content"])}
        if method == "host/fs.list":
            base = _norm(p.get("path", "."))
            prefix = "" if base == "." else base.rstrip("/") + "/"
            names = sorted({f[len(prefix):].split("/")[0] for f in self.files if f.startswith(prefix)})
            return {"entries": [{"name": n, "type": "file" if (prefix + n) in self.files else "dir"} for n in names]}
        if method == "host/fs.stat":
            path = _norm(p["path"])
            if path not in self.files:
                raise PluginError(f"No such file: {path}", "NOT_FOUND")
            return {"type": "file", "size": len(self.files[path])}
        if method == "host/net.fetch":
            if self.fetch is None:
                raise PluginError("net.http is not granted in this test context (pass fetch=...)", "PERMISSION_DENIED")
            res = self.fetch(p)
            if isinstance(res, (dict, list)) and "status" not in res:
                res = {"status": 200, "body": json.dumps(res)}
            elif isinstance(res, str):
                res = {"status": 200, "body": res}
            return {"status": 200, "headers": {}, "encoding": "utf8", "url": p["url"], "truncated": False, **res}
        if method == "host/secrets.get":
            if p["name"] not in self.secrets:
                raise PluginError(f'Secret "{p["name"]}" is not set', "PERMISSION_DENIED")
            return {"value": self.secrets[p["name"]]}
        if method == "host/storage.get":
            return {"value": self.storage.get(p["key"])}
        if method == "host/storage.set":
            self.storage[p["key"]] = p["value"]
            return {}
        if method == "host/storage.delete":
            self.storage.pop(p["key"], None)
            return {}
        if method == "host/storage.list":
            return {"keys": sorted(self.storage)}
        if method == "host/events.emit":
            self.events.append((p["name"], p.get("payload")))
            return {}
        raise PluginError(f"{method} is not available in the test harness", "NOT_IMPLEMENTED")


def _norm(path: str) -> str:
    p = os.path.normpath(path).lstrip("/")
    if p.startswith(".."):
        raise PluginError(f"{path} is outside the workspace", "PERMISSION_DENIED")
    return p


def config_defaults(manifest_path: str = "helm-plugin.json") -> Dict[str, Any]:
    """Defaults from the manifest's configuration schema, so tests see what users get out of the box."""
    try:
        with open(manifest_path, encoding="utf-8") as f:
            m = json.load(f)
    except OSError:
        return {}
    props = (m.get("contributes", {}).get("configuration") or {}).get("properties", {})
    return {k: v["default"] for k, v in props.items() if "default" in v}


def make_context(files: Optional[Dict[str, str]] = None, config: Optional[Dict[str, Any]] = None,
                 fetch: Optional[Callable[[dict], Any]] = None, secrets: Optional[Dict[str, str]] = None,
                 manifest: str = "helm-plugin.json", workspace: str = "/workspace") -> Context:
    host = FakeHost(files or {}, fetch, secrets or {})
    ctx = Context(host, {  # type: ignore[arg-type]
        "plugin": {"id": "test.plugin", "version": "0.0.0"},
        "workspace": workspace,
        "config": {**config_defaults(manifest), **(config or {})},
        "grants": [],
        "isolation": "test",
    })
    ctx.host = host  # type: ignore[attr-defined]
    return ctx


def call_tool(plugin, name: str, input: Optional[dict] = None, ctx: Optional[Context] = None) -> dict:
    if name not in plugin._tools:
        raise KeyError(f"plugin has no tool {name!r} (has: {', '.join(plugin._tools)})")
    return _to_result(plugin._tools[name](input or {}, ctx or make_context()))


def run_command(plugin, name: str, args: Optional[dict] = None, ctx: Optional[Context] = None) -> Any:
    return plugin._commands[name](args or {}, ctx or make_context())


def render_panel(plugin, panel_id: str, ctx: Optional[Context] = None) -> Any:
    return plugin._panels[panel_id](ctx or make_context())


def run_hook(plugin, event: str, payload: dict, ctx: Optional[Context] = None) -> Any:
    return plugin._hooks[event](payload, ctx or make_context())


def text_of(result: dict) -> str:
    return "\n".join(b.get("text") if b.get("type") != "json" else json.dumps(b.get("data")) for b in result.get("content", []))

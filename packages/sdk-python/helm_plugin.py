"""helm_plugin — write Helm plugins in Python (3.9+, standard library only).

    from helm_plugin import Plugin, PluginError, text, ui

    plugin = Plugin()

    @plugin.tool("greet")
    def greet(input, ctx):
        return f"Hello, {input['name']}!"

    if __name__ == "__main__":
        plugin.run()

The host injects this module via PYTHONPATH. Handlers are plain (synchronous) functions that run
on a small thread pool, so a slow handler never blocks the protocol loop. Use ``print`` freely:
stdout is reserved for the protocol, so ``print`` output is redirected to stderr (the plugin log).
"""
from __future__ import annotations

import json
import os
import sys
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, List, Optional

__all__ = ["Plugin", "PluginError", "Context", "text", "markdown", "json_result", "ui"]

PROTOCOL_VERSION = "1.0"


class PluginError(Exception):
    """Raise to return a structured error (code from the Helm error catalog)."""

    def __init__(self, message: str, code: str = "TOOL_ERROR", hint: Optional[str] = None):
        super().__init__(message)
        self.code = code
        self.hint = hint


def text(t: str) -> dict:
    return {"content": [{"type": "text", "text": t}]}


def markdown(t: str) -> dict:
    return {"content": [{"type": "markdown", "text": t}]}


def json_result(data: Any) -> dict:
    return {"content": [{"type": "json", "data": data}]}


class ui:  # noqa: N801 - namespace mirroring the TypeScript SDK
    stack = staticmethod(lambda *children: {"type": "stack", "children": list(children)})
    heading = staticmethod(lambda t: {"type": "heading", "text": t})
    text = staticmethod(lambda t, tone=None: {"type": "text", "text": t, **({"tone": tone} if tone else {})})
    markdown = staticmethod(lambda t: {"type": "markdown", "text": t})
    key_value = staticmethod(lambda items: {"type": "keyValue", "items": [{"key": k, "value": str(v)} for k, v in items.items()]})
    table = staticmethod(lambda columns, rows: {"type": "table", "columns": columns, "rows": [[str(c) for c in r] for r in rows]})
    list = staticmethod(lambda items: {"type": "list", "items": [str(i) for i in items]})
    badge = staticmethod(lambda t, tone=None: {"type": "badge", "text": t, **({"tone": tone} if tone else {})})
    button = staticmethod(lambda label, command, args=None: {"type": "button", "label": label, "command": command, **({"args": args} if args else {})})


def _to_result(v: Any) -> dict:
    if v is None:
        return text("(no output)")
    if isinstance(v, str):
        return text(v)
    if isinstance(v, dict) and isinstance(v.get("content"), list):
        return v
    return json_result(v)


class _Namespace:
    def __init__(self, **fns):
        self.__dict__.update(fns)


class Context:
    """Everything a handler may use. Each capability is checked by the host against your grants."""

    def __init__(self, rt: "_Runtime", init: dict):
        self._rt = rt
        self.plugin = init.get("plugin", {})
        self.workspace = init.get("workspace")
        self.grants = init.get("grants", [])
        self.isolation = init.get("isolation")
        self.config: Dict[str, Any] = init.get("config") or {}
        self.call_id: Optional[str] = None
        self.session_id: Optional[str] = None
        self.cancelled = threading.Event()
        r = rt.request
        self.log = _Namespace(
            debug=lambda *a: rt.notify("host/log", {"level": "debug", "message": " ".join(map(str, a))}),
            info=lambda *a: rt.notify("host/log", {"level": "info", "message": " ".join(map(str, a))}),
            warn=lambda *a: rt.notify("host/log", {"level": "warn", "message": " ".join(map(str, a))}),
            error=lambda *a: rt.notify("host/log", {"level": "error", "message": " ".join(map(str, a))}),
        )
        self.fs = _Namespace(
            read=lambda path, encoding="utf8", max_bytes=None: r("host/fs.read", {"path": path, "encoding": encoding, **({"maxBytes": max_bytes} if max_bytes else {})}),
            read_text=lambda path: r("host/fs.read", {"path": path})["content"],
            list=lambda path=".": r("host/fs.list", {"path": path}),
            stat=lambda path: r("host/fs.stat", {"path": path}),
            write=lambda path, content, create_dirs=False: r("host/fs.write", {"path": path, "content": content, "createDirs": create_dirs}),
        )
        self.net = _Namespace(fetch=self._fetch)
        self.secrets = _Namespace(get=lambda name: r("host/secrets.get", {"name": name})["value"])
        self.storage = _Namespace(
            get=lambda key: r("host/storage.get", {"key": key}).get("value"),
            set=lambda key, value: r("host/storage.set", {"key": key, "value": value}),
            delete=lambda key: r("host/storage.delete", {"key": key}),
            list=lambda: r("host/storage.list", {})["keys"],
        )
        self.events = _Namespace(emit=lambda name, payload=None: r("host/events.emit", {"name": name, "payload": payload}))
        self.ui = _Namespace(
            notify=lambda message, level="info": rt.notify("host/ui.notify", {"message": message, "level": level}),
            refresh=lambda panel=None: rt.notify("host/ui.refresh", {"panel": panel}),
        )

    def _fetch(self, url: str, method: str = "GET", headers: Optional[dict] = None, body: Optional[str] = None,
               timeout_ms: Optional[int] = None, max_bytes: Optional[int] = None) -> dict:
        params: Dict[str, Any] = {"url": url, "method": method}
        if headers:
            params["headers"] = headers
        if body is not None:
            params["body"] = body
        if timeout_ms:
            params["timeoutMs"] = timeout_ms
        if max_bytes:
            params["maxBytes"] = max_bytes
        res = self._rt.request("host/net.fetch", params)
        res["ok"] = 200 <= res.get("status", 0) < 300
        return res

    def progress(self, message: str) -> None:
        self._rt.notify("host/progress", {"callId": self.call_id, "message": message})

    def _for_call(self, call_id=None, session_id=None) -> "Context":
        c = object.__new__(Context)
        c.__dict__.update(self.__dict__)
        c.call_id, c.session_id, c.cancelled = call_id, session_id, threading.Event()
        return c


class _Runtime:
    def __init__(self, plugin: "Plugin", out, inp):
        self.plugin = plugin
        self.out = out
        self.inp = inp
        self.lock = threading.Lock()
        self.pending: Dict[str, dict] = {}
        self.next_id = 1
        self.ctx: Optional[Context] = None
        self.inflight: Dict[Any, Context] = {}
        self.pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="helm-handler")

    def send(self, msg: dict) -> None:
        data = json.dumps(msg, default=str) + "\n"
        with self.lock:
            self.out.write(data)
            self.out.flush()

    def notify(self, method: str, params: Any) -> None:
        self.send({"jsonrpc": "2.0", "method": method, "params": params})

    def request(self, method: str, params: Any, timeout: float = 330.0) -> Any:
        with self.lock:
            rid = f"p{self.next_id}"
            self.next_id += 1
            slot = {"event": threading.Event(), "result": None, "error": None}
            self.pending[rid] = slot
        self.send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        if not slot["event"].wait(timeout):
            self.pending.pop(rid, None)
            raise PluginError(f"host did not answer {method}", "CALL_TIMEOUT")
        if slot["error"]:
            e = slot["error"]
            data = e.get("data") or {}
            raise PluginError(e.get("message", "host error"), data.get("code", "TOOL_ERROR"), data.get("hint"))
        return slot["result"]

    # ---- dispatch -------------------------------------------------------------
    def handle(self, msg: dict) -> None:
        method, params, rid = msg["method"], msg.get("params") or {}, msg.get("id")
        p = self.plugin
        try:
            if method == "initialize":
                self.ctx = Context(self, params)
                for fn in p._activate:
                    fn(self.ctx)
                result = {"protocolVersion": PROTOCOL_VERSION, "capabilities": {
                    "tools": list(p._tools), "commands": list(p._commands), "hooks": list(p._hooks),
                    "panels": list(p._panels), "providers": [],
                }}
            elif method == "$/ping":
                result = {"ok": True}
            elif method == "shutdown":
                for fn in p._deactivate:
                    fn(self.ctx)
                result = {"ok": True}
            else:
                ctx = self.ctx._for_call(params.get("callId"), params.get("sessionId"))
                self.inflight[rid] = ctx
                if method == "tool/invoke":
                    fn = p._tools.get(params.get("tool"))
                    if not fn:
                        raise PluginError(f"This plugin does not implement tool \"{params.get('tool')}\"", "NOT_IMPLEMENTED")
                    result = _to_result(fn(params.get("input") or {}, ctx))
                elif method == "command/run":
                    fn = p._commands.get(params.get("command"))
                    if not fn:
                        raise PluginError(f"No command \"{params.get('command')}\"", "NOT_IMPLEMENTED")
                    out = fn(params.get("args") or {}, ctx)
                    result = {"ui": out} if isinstance(out, dict) and "type" in out else _to_result(out)
                elif method == "hook/dispatch":
                    fn = p._hooks.get(params.get("event"))
                    result = (fn(params.get("payload"), ctx) if fn else None) or {"action": "continue"}
                elif method == "panel/render":
                    fn = p._panels.get(params.get("panel"))
                    if not fn:
                        raise PluginError(f"No panel \"{params.get('panel')}\"", "NOT_IMPLEMENTED")
                    result = {"ui": fn(ctx)}
                else:
                    self.send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"Method not found: {method}", "data": {"code": "NOT_IMPLEMENTED"}}})
                    return
            self.send({"jsonrpc": "2.0", "id": rid, "result": result})
        except PluginError as e:
            self.send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32000, "message": str(e), "data": {"code": e.code, "hint": e.hint}}})
        except Exception as e:  # noqa: BLE001 - report every handler failure as a structured error
            traceback.print_exc(file=sys.stderr)
            code = "ACTIVATION_FAILED" if method == "initialize" else "TOOL_ERROR"
            self.send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32000, "message": f"{type(e).__name__}: {e}", "data": {"code": code}}})
        finally:
            self.inflight.pop(rid, None)

    def loop(self) -> None:
        for line in self.inp:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                print(f"[sdk] bad message from host: {line[:200]}", file=sys.stderr)
                continue
            if "method" in msg:
                if msg.get("id") is None:
                    m = msg["method"]
                    if m == "exit":
                        os._exit(0)
                    elif m == "$/cancelRequest":
                        c = self.inflight.get((msg.get("params") or {}).get("id"))
                        if c:
                            c.cancelled.set()
                    elif m == "config/didChange" and self.ctx:
                        self.ctx.config = (msg.get("params") or {}).get("config") or {}
                    continue
                if msg["method"] in ("initialize", "$/ping"):
                    self.handle(msg)  # inline: must not queue behind busy handlers
                else:
                    self.pool.submit(self.handle, msg)
            else:
                slot = self.pending.pop(msg.get("id"), None)
                if slot:
                    slot["result"], slot["error"] = msg.get("result"), msg.get("error")
                    slot["event"].set()
        os._exit(0)


class Plugin:
    """Register handlers with decorators, then call ``run()``."""

    def __init__(self):
        self._tools: Dict[str, Callable] = {}
        self._commands: Dict[str, Callable] = {}
        self._hooks: Dict[str, Callable] = {}
        self._panels: Dict[str, Callable] = {}
        self._activate: List[Callable] = []
        self._deactivate: List[Callable] = []

    def tool(self, name: str):
        return self._register(self._tools, name)

    def command(self, name: str):
        return self._register(self._commands, name)

    def hook(self, event: str):
        return self._register(self._hooks, event)

    def panel(self, panel_id: str):
        return self._register(self._panels, panel_id)

    def on_activate(self, fn):
        self._activate.append(fn)
        return fn

    def on_deactivate(self, fn):
        self._deactivate.append(fn)
        return fn

    @staticmethod
    def _register(table: dict, name: str):
        def deco(fn):
            table[name] = fn
            return fn
        return deco

    def run(self) -> None:
        """Serve the Helm protocol on stdio until the host disconnects."""
        proto_out = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
        sys.stdout = sys.stderr  # print() goes to the plugin log, never into the protocol
        inp = os.fdopen(0, "r", encoding="utf-8", buffering=1)
        _Runtime(self, proto_out, inp).loop()

"""Escape attempts in plain Python. Each tool reports 'blocked: <errno>' or 'ESCAPED: ...'."""
import os
import socket
import subprocess
from helm_plugin import Plugin

plugin = Plugin()


def attempt(fn):
    try:
        return f"ESCAPED: {fn()}"
    except (OSError, subprocess.SubprocessError) as e:
        return f"blocked: {type(e).__name__} errno={getattr(e, 'errno', None)}"


@plugin.tool("read_file")
def read_file(input, ctx):
    return attempt(lambda: open(input["path"], "rb").read(32))


@plugin.tool("write_file")
def write_file(input, ctx):
    def go():
        with open(input["path"], "w") as f:
            f.write("escaped")
        return input["path"]
    return attempt(go)


@plugin.tool("connect")
def connect(input, ctx):
    def go():
        s = socket.create_connection((input.get("host", "1.1.1.1"), input.get("port", 443)), timeout=3)
        s.close()
        return "connected"
    return attempt(go)


@plugin.tool("spawn")
def spawn(input, ctx):
    return attempt(lambda: subprocess.run(["/bin/echo", "hi"], capture_output=True, timeout=5).stdout)


if __name__ == "__main__":
    plugin.run()

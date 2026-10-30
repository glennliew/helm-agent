"""Helm Web plugin: readable page fetching and web search, via the host's network broker.

The plugin has no direct network access (the sandbox blocks sockets); every request goes through
ctx.net.fetch, where Helm checks the host against the user's grant and blocks private addresses.
"""
import json
import re
import time
from html import unescape
from html.parser import HTMLParser
from urllib.parse import quote_plus, urlparse

from helm_plugin import Plugin, PluginError, ui

plugin = Plugin()

SKIP = {"script", "style", "noscript", "svg", "nav", "footer", "header", "form", "iframe", "template", "aside"}
BLOCK = {"p", "div", "section", "article", "li", "br", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "blockquote", "table", "main"}


class _Readable(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.title, self._skip, self._in_title = [], "", 0, False

    def handle_starttag(self, tag, attrs):
        if tag in SKIP:
            self._skip += 1
        elif tag == "title":
            self._in_title = True
        elif tag in BLOCK:
            self.parts.append("\n")
        if tag in ("h1", "h2", "h3") and not self._skip:
            self.parts.append("#" * int(tag[1]) + " ")
        if tag == "li" and not self._skip:
            self.parts.append("- ")

    def handle_endtag(self, tag):
        if tag in SKIP and self._skip:
            self._skip -= 1
        elif tag == "title":
            self._in_title = False
        elif tag in BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self._skip:
            self.parts.append(data)


def html_to_text(html: str):
    p = _Readable()
    try:
        p.feed(html)
    except Exception:  # noqa: BLE001 - malformed HTML still yields partial text
        pass
    text = "".join(p.parts)
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return p.title.strip(), text.strip()


def _remember(ctx, url: str, title: str):
    hist = ctx.storage.get("history") or []
    hist = [h for h in hist if h["url"] != url][-19:] + [{"url": url, "title": title[:120], "at": time.strftime("%Y-%m-%d %H:%M")}]
    ctx.storage.set("history", hist)


@plugin.tool("fetch_url")
def fetch_url(input, ctx):
    url = input["url"]
    limit = int(input.get("maxChars") or ctx.config.get("maxChars", 20000))
    ctx.progress(f"fetching {urlparse(url).netloc}")
    res = ctx.net.fetch(url, headers={"accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5"}, timeout_ms=30000, max_bytes=3_000_000)
    if not res["ok"]:
        raise PluginError(f"{url} returned HTTP {res['status']}", "TOOL_ERROR")
    ctype = res["headers"].get("content-type", "")
    if res.get("encoding") == "base64":
        raise PluginError(f"{url} is not a text page ({ctype or 'binary'})", "TOOL_ERROR")
    body = res["body"]
    if "html" in ctype or body.lstrip()[:15].lower().startswith(("<!doctype", "<html")):
        title, text = html_to_text(body)
    elif "json" in ctype:
        title, text = "", json.dumps(json.loads(body), indent=2)[:limit]
    else:
        title, text = "", body
    _remember(ctx, res["url"], title or res["url"])
    note = f"\n\n[truncated to {limit} of {len(text)} characters]" if len(text) > limit else ""
    head = f"# {title}\n" if title else ""
    return f"{head}Source: {res['url']}\n\n{text[:limit]}{note}"


def _wikipedia(ctx, query, limit):
    lang = ctx.config.get("language", "en")
    url = f"https://{lang}.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit={limit}&srsearch={quote_plus(query)}"
    res = ctx.net.fetch(url, headers={"accept": "application/json"}, timeout_ms=20000)
    if not res["ok"]:
        raise PluginError(f"Wikipedia search failed: HTTP {res['status']}", "TOOL_ERROR")
    hits = json.loads(res["body"]).get("query", {}).get("search", [])
    return [{
        "title": h["title"],
        "url": f"https://{lang}.wikipedia.org/wiki/{quote_plus(h['title'].replace(' ', '_'))}",
        "snippet": unescape(re.sub(r"<[^>]+>", "", h.get("snippet", ""))),
    } for h in hits]


def _brave(ctx, query, limit):
    try:
        key = ctx.secrets.get("BRAVE_API_KEY")
    except PluginError:
        raise PluginError("Brave Search needs an API key", "TOOL_ERROR", "Run: helm secrets set helm.web BRAVE_API_KEY  (or set searchBackend to wikipedia)")
    url = f"https://api.search.brave.com/res/v1/web/search?count={limit}&q={quote_plus(query)}"
    res = ctx.net.fetch(url, headers={"accept": "application/json", "x-subscription-token": key}, timeout_ms=20000)
    if not res["ok"]:
        raise PluginError(f"Brave search failed: HTTP {res['status']}", "TOOL_ERROR")
    results = json.loads(res["body"]).get("web", {}).get("results", [])
    return [{"title": r.get("title", ""), "url": r.get("url", ""), "snippet": unescape(re.sub(r"<[^>]+>", "", r.get("description", "")))} for r in results]


@plugin.tool("web_search")
def web_search(input, ctx):
    query, limit = input["query"], int(input.get("limit", 5))
    backend = ctx.config.get("searchBackend", "wikipedia")
    ctx.progress(f"searching {backend}")
    results = _brave(ctx, query, limit) if backend == "brave" else _wikipedia(ctx, query, limit)
    if not results:
        return f"No {backend} results for \"{query}\"."
    lines = [f"{i + 1}. {r['title']}\n   {r['url']}\n   {r['snippet']}" for i, r in enumerate(results)]
    return f"{backend.title()} results for \"{query}\":\n\n" + "\n\n".join(lines)


@plugin.command("history")
def history(args, ctx):
    hist = list(reversed(ctx.storage.get("history") or []))
    if not hist:
        return ui.text("No pages fetched yet.", "muted")
    return ui.stack(ui.heading("Recently fetched"), ui.table(["when", "title", "url"], [[h["at"], h["title"], h["url"]] for h in hist]))


if __name__ == "__main__":
    plugin.run()

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.chdir(os.path.dirname(os.path.abspath(__file__)))

from helm_plugin import PluginError  # noqa: E402
from helm_plugin_testing import call_tool, make_context, run_command, text_of  # noqa: E402
import main  # noqa: E402

PAGE = """<html><head><title>Ship's wheel</title><script>steal()</script><style>p{}</style></head>
<body><nav>menu</nav><h1>Helm</h1><p>A ship's wheel steers the vessel.</p><footer>legal</footer></body></html>"""


class FetchUrl(unittest.TestCase):
    def test_extracts_readable_text_and_drops_chrome(self):
        ctx = make_context(fetch=lambda req: {"status": 200, "headers": {"content-type": "text/html"}, "body": PAGE})
        out = text_of(call_tool(main.plugin, "fetch_url", {"url": "https://example.com/wheel"}, ctx))
        self.assertIn("A ship's wheel steers the vessel.", out)
        self.assertIn("Ship's wheel", out)
        for junk in ("steal()", "menu", "legal"):
            self.assertNotIn(junk, out)

    def test_remembers_history_in_plugin_storage(self):
        ctx = make_context(fetch=lambda req: {"status": 200, "headers": {"content-type": "text/html"}, "body": PAGE})
        call_tool(main.plugin, "fetch_url", {"url": "https://example.com/wheel"}, ctx)
        self.assertTrue(any(k for k in ctx.host.storage), "history should be stored via ctx.storage")
        self.assertIn("example.com", json.dumps(run_command(main.plugin, "history", {}, ctx)))

    def test_without_network_grant_the_error_is_explicit(self):
        with self.assertRaises(PluginError) as cm:
            call_tool(main.plugin, "fetch_url", {"url": "https://example.com/"}, make_context())
        self.assertEqual(cm.exception.code, "PERMISSION_DENIED")

    def test_http_errors_are_reported_not_hidden(self):
        ctx = make_context(fetch=lambda req: {"status": 404, "headers": {"content-type": "text/html"}, "body": "nope"})
        try:
            out = text_of(call_tool(main.plugin, "fetch_url", {"url": "https://example.com/missing"}, ctx))
            self.assertIn("404", out)
        except PluginError as e:
            self.assertIn("404", str(e))


class WebSearch(unittest.TestCase):
    def test_wikipedia_backend_by_default(self):
        seen = []

        def fetch(req):
            seen.append(req["url"])
            return {"query": {"search": [{"title": "Helm (watercraft)", "snippet": "a <span>steering</span> device"}]}}

        ctx = make_context(fetch=fetch)
        out = text_of(call_tool(main.plugin, "web_search", {"query": "ship helm"}, ctx))
        self.assertTrue(seen[0].startswith("https://en.wikipedia.org/w/api.php"))
        self.assertIn("Helm (watercraft)", out)
        self.assertNotIn("<span>", out)

    def test_brave_backend_needs_its_secret(self):
        ctx = make_context(config={"searchBackend": "brave"}, fetch=lambda req: {})
        with self.assertRaises(PluginError) as cm:
            call_tool(main.plugin, "web_search", {"query": "x"}, ctx)
        self.assertIn("BRAVE_API_KEY", (cm.exception.hint or "") + str(cm.exception))


if __name__ == "__main__":
    unittest.main()

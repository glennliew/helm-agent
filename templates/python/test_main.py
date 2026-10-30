"""Unit tests for {{title}}: handlers run in-process against a fake host. Run with `helm plugin test .`"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.chdir(os.path.dirname(os.path.abspath(__file__)))

from helm_plugin import PluginError  # noqa: E402
from helm_plugin_testing import call_tool, make_context, text_of  # noqa: E402
import main  # noqa: E402


class HelloTest(unittest.TestCase):
    def test_uses_the_configured_greeting(self):
        ctx = make_context(config={"greeting": "Ahoy"})
        self.assertEqual(text_of(call_tool(main.plugin, "hello", {"name": "Ada"}, ctx)), "Ahoy, Ada!")

    def test_word_count_reads_through_the_host(self):
        ctx = make_context(files={"notes.txt": "one two three"})
        self.assertEqual(text_of(call_tool(main.plugin, "word_count", {"path": "notes.txt"}, ctx)), "notes.txt has 3 words")
        self.assertEqual(ctx.host.calls[0][0], "host/fs.read")

    def test_missing_files_are_clear_errors(self):
        with self.assertRaises(PluginError) as cm:
            call_tool(main.plugin, "word_count", {"path": "nope.txt"}, make_context())
        self.assertEqual(cm.exception.code, "NOT_FOUND")


if __name__ == "__main__":
    unittest.main()

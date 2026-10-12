from pathlib import Path
import re
import tempfile
import unittest
from assets import AssetCache
from script_packs import PREFIX, ScriptPacks


class ScriptPackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.web = Path(self.temp.name) / "web"
        self.web.mkdir()
        self.page = self.web / "index.html"
        self.packs = ScriptPacks(Path(self.temp.name) / "packs", AssetCache())
        for name in ("a", "b", "c", "d", "e", "f"):
            (self.web / (name + ".js")).write_text("window." + name + "=true;", encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def render(self, source):
        self.page.write_text(source)
        output = self.packs.navigation(source.encode(), self.page, self.web).decode()
        self.assertEqual(self.page.read_text(), source)
        return output

    def test_inline_boundaries_and_defer_order_remain_separate(self):
        source = '''<html><head></head><body>
<script src="a.js"></script><!-- keep order --><script src="b.js"></script>
<script>window.boundary=true;</script>
<script src="c.js" defer></script><script src="d.js" defer></script>
<script src="e.js"></script><script src="f.js"></script></body></html>'''
        output = self.render(source)
        self.assertEqual(self.packs.last_stats["packs"], 3)
        self.assertEqual(self.packs.last_stats["externalScripts"], 3)
        self.assertEqual(output.count('rel="preload"'), 2)
        self.assertEqual(len(re.findall(r'<script src="' + PREFIX + r'[^"]+" defer>', output)), 1)
        self.assertIn('<script>window.boundary=true;</script>', output)

    def test_source_dependent_and_async_scripts_stay_external(self):
        (self.web / "b.js").write_text("window.original=document.currentScript.src;")
        output = self.render('<html><head></head><body><script src="a.js"></script><script src="b.js"></script>'
                             '<script src="c.js" async></script><script src="d.js"></script><script src="e.js"></script></body></html>')
        self.assertIn('src="b.js"', output)
        self.assertIn('src="c.js" async', output)
        self.assertEqual(self.packs.last_stats["packedScripts"], 2)

    def test_strict_script_csp_never_becomes_inline_even_when_styles_allow_inline(self):
        source = '''<html><head><meta http-equiv="Content-Security-Policy"
content="script-src 'self'; style-src 'unsafe-inline'"></head><body>
<script src="a.js"></script><script src="b.js"></script></body></html>'''
        self.assertEqual(self.render(source), source)

    def test_content_change_creates_new_pack_but_preserves_previous_snapshot(self):
        source = '<html><head></head><body><script src="a.js"></script><script src="b.js"></script></body></html>'
        first = self.render(source)
        name = re.search(PREFIX + r'([a-f0-9]+\.js)', first).group(1)
        original = self.packs.resolve(name).read_bytes()
        (self.web / "b.js").write_text("window.b='updated';")
        second = self.render(source)
        self.assertNotEqual(first, second)
        self.assertEqual(self.packs.resolve(name).read_bytes(), original)
        self.assertIsNone(self.packs.resolve("../tianming.sqlite3"))
        self.assertIsNone(self.packs.resolve("0" * 64 + ".js"))


if __name__ == "__main__":
    unittest.main()

import gzip
import html
from pathlib import Path
import re
import tempfile
import unittest
from assets import AssetCache, accepts_gzip, resource_urls


class AssetTests(unittest.TestCase):
    def test_gzip_negotiation_and_exact_decoded_bytes(self):
        self.assertTrue(accepts_gzip("br, gzip;q=0.8"))
        self.assertFalse(accepts_gzip("gzip;q=0, *;q=1"))
        self.assertFalse(accepts_gzip(""))
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / "runtime.js"
            original = ("const 文案 = '原始字节保持不变';\r\n" * 300).encode()
            file.write_bytes(original)
            asset = AssetCache().get(file)
            zipped, encoding = asset.representation("gzip")
            self.assertEqual(encoding, "gzip")
            self.assertLess(len(zipped), len(original) / 4)
            self.assertEqual(gzip.decompress(zipped), original)
            self.assertEqual(asset.representation("gzip;q=0"), (original, None))

    def test_content_hash_invalidates_equal_size_source_change(self):
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / "runtime.js"
            cache = AssetCache()
            file.write_text("let x=1")
            old = cache.get(file)
            self.assertIs(cache.get(file), old)
            file.write_text("let x=2")
            self.assertNotEqual(cache.get(file).digest, old.digest)

    def test_navigation_urls_preserve_script_order_inline_code_and_source(self):
        with tempfile.TemporaryDirectory() as folder:
            web = Path(folder)
            (web / "a.js").write_text("var A=1")
            (web / "b.css").write_text("body{color:red}")
            page = web / "index.html"
            source = b'''<html><head><script src="a.js?v=1"></script>
<script>const literal = '<script src="a.js">';</script>
<link rel="stylesheet" href="b.css"></head><body>
<script src="https://example.test/a.js"></script></body></html>'''
            page.write_bytes(source)
            cache = AssetCache()
            served = resource_urls(source, page, web, cache).decode()
            self.assertIn('a.js?v=1&amp;tm-local=', served)
            self.assertIn('b.css?tm-local=', served)
            self.assertIn("const literal = '<script src=\"a.js\">';", served)
            self.assertIn('src="https://example.test/a.js"', served)
            self.assertEqual(page.read_bytes(), source)
            old = html.unescape(re.search(r'src="(.*?)"', served).group(1))
            (web / "a.js").write_text("var A=2")
            updated = resource_urls(source, page, web, cache).decode()
            self.assertNotEqual(old, html.unescape(re.search(r'src="(.*?)"', updated).group(1)))

    def test_bounded_cache_evicts_old_assets(self):
        with tempfile.TemporaryDirectory() as folder:
            cache = AssetCache(budget=5)
            a, b = Path(folder) / "a.js", Path(folder) / "b.js"
            a.write_bytes(b"1234")
            b.write_bytes(b"5678")
            cache.get(a)
            cache.get(b)
            self.assertEqual(list(cache.entries), [b.resolve()])
            self.assertEqual(cache.size, 4)


if __name__ == "__main__":
    unittest.main()

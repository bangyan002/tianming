"""HTTP acceptance for compressed, bounded and idempotent storage requests."""
import gzip
import http.client
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("local_web", Path(__file__).resolve().parent.parent / "local_web.py")
local_web = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local_web)


class QuietHandler(local_web.Handler):
    def log_message(self, *_args):
        pass


class TransferTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.storage = local_web.Storage(Path(self.temp.name) / "test.sqlite3")
        self.server = local_web.ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        self.server.storage = self.storage
        self.worker = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01})
        self.worker.start()

    def tearDown(self):
        self.server.shutdown()
        self.worker.join()
        self.server.server_close()
        self.storage.close()
        self.temp.cleanup()

    def request(self, route, data=None, encoding=None, raw=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        headers = {"X-TM-Storage-ID": self.storage.dataset_id, "Content-Type": "application/json"}
        if data is not None:
            raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
            if encoding == "gzip":
                raw = gzip.compress(raw)
        if encoding:
            headers["Content-Encoding"] = encoding
        connection.request("POST" if raw is not None else "GET", local_web.API + route, raw, headers)
        response = connection.getresponse()
        status, timing = response.status, response.getheader("Server-Timing")
        body = json.loads(response.read())
        connection.close()
        return status, body, timing

    def test_gzip_commit_round_trip_and_same_id_retry(self):
        status, boot, _ = self.request("bootstrap")
        self.assertEqual(status, 200)
        self.assertTrue(boot["gzipRequests"])
        text = "案卷与存档·" * 40000
        value = ["object", 0, [["text", text]]]
        commit = {"id": "save-one", "name": "fixture", "revision": 0, "version": 1,
                  "schema": {"rows": {"keyPath": None, "indexes": {}}},
                  "operations": [{"type": "put", "store": "rows", "key": "save", "value": value, "indexes": {}}]}
        status, result, timing = self.request("commit", commit, "gzip")
        self.assertEqual((status, result), (200, {"revision": 1}))
        self.assertIn("inflate;dur=", timing)
        self.assertIn("parse;dur=", timing)
        self.assertEqual(self.request("commit", commit, "gzip")[:2], (200, result))
        self.assertEqual(self.request("outcome", {"id": "save-one"})[:2],
                         (200, {"committed": True, "revision": 1}))
        status, body, _ = self.request("read", {"name": "fixture", "store": "rows", "revision": 1})
        self.assertEqual(status, 200)
        self.assertEqual(body["rows"][0]["value"], value)
        with self.storage.transaction() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM commits").fetchone()[0], 1)

    def test_uncompressed_old_clients_still_work(self):
        self.assertEqual(self.request("local", {"key": "theme", "value": "dark", "version": 0})[:2],
                         (200, {"version": 1, "revision": 1}))

    def test_bad_truncated_and_concatenated_gzip_rejected_without_writing(self):
        for raw in (b"not gzip", gzip.compress(b"{}")[:-1], gzip.compress(b"{}") + gzip.compress(b"{}")):
            status, body, _ = self.request("commit", encoding="gzip", raw=raw)
            self.assertEqual((status, body["name"]), (400, "DataError"))
        with self.storage.transaction() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM commits").fetchone()[0], 0)

    def test_compressed_and_plain_size_limits(self):
        with patch.object(local_web, "MAX_REQUEST_BYTES", 1024):
            for encoding in ("gzip", None):
                status, body, _ = self.request("commit", {"padding": "a" * 2048}, encoding)
                self.assertEqual((status, body["name"]), (413, "DataError"))

    def test_unsupported_encoding_and_stale_dataset_rejected(self):
        self.assertEqual(self.request("commit", encoding="br", raw=b"{}")[:2],
                         (415, {"error": "不支持的请求压缩格式", "name": "DataError"}))
        self.storage.dataset_id = "new-dataset"
        # Simulate the page's old identity, without changing the database contents.
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        connection.request("POST", local_web.API + "commit", gzip.compress(b"{}"),
                           {"X-TM-Storage-ID": "old-dataset", "Content-Encoding": "gzip"})
        response = connection.getresponse()
        self.assertEqual(response.status, 409)
        self.assertEqual(json.loads(response.read())["name"], "ServerResetError")
        connection.close()


if __name__ == "__main__":
    unittest.main()

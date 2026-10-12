import tempfile
import threading
import unittest
from unittest.mock import patch
import zlib
from pathlib import Path
from storage import Storage, StorageError


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "data.sqlite3"
        self.store = Storage(self.path)
        self.schema = {"saves": {"keyPath": "id", "indexes": {"turn": {"keyPath": "turn", "unique": True}}},
                       "metadata": {"keyPath": "id", "indexes": {}}}
        self.store.commit({"id": "schema", "name": "game", "revision": 0, "version": 1,
                           "schema": self.schema, "operations": []})

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def put(self, store, key, turn):
        return {"type": "put", "store": store, "key": key, "value": ["object", 0, [["id", key], ["turn", turn]]],
                "indexes": {"turn": [turn]} if store == "saves" else {}}

    def commit(self, operations, revision=1, token="save"):
        return self.store.commit({"id": token, "name": "game", "revision": revision, "operations": operations})

    def read(self, store="saves", **extra):
        body = {"name": "game", "store": store, "revision": self.store.open({"name": "game"})["revision"]}
        body.update(extra)
        return self.store.read(body)["rows"]

    def test_persists_multiple_stores_and_receipt(self):
        result = self.commit([self.put("saves", "autosave", 4), self.put("metadata", "autosave", 4)])
        self.assertEqual(result["revision"], 2)
        self.store.close()
        self.store = Storage(self.path)
        self.assertEqual(self.read()[0]["primaryKey"], "autosave")
        self.assertEqual(len(self.read("metadata")), 1)
        self.assertTrue(self.store.outcome({"id": "save"})["committed"])
        self.assertEqual(self.commit([], revision=1), result)  # Idempotent lost-response retry.

    def test_atomic_rollback_on_unique_constraint(self):
        self.commit([self.put("saves", "old", 1)])
        with self.assertRaises(StorageError):
            self.commit([self.put("metadata", "new", 2), self.put("saves", "new", 1)], 2, "bad")
        self.assertEqual(self.read("metadata"), [])
        self.assertEqual([r["primaryKey"] for r in self.read()], ["old"])
        self.assertFalse(self.store.outcome({"id": "bad"})["committed"])

    def test_stale_writer_cannot_overwrite(self):
        self.commit([self.put("saves", "slot_0", 1)])
        with self.assertRaises(StorageError) as caught:
            self.commit([self.put("saves", "slot_0", 2)], 1, "stale")
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(self.read()[0]["value"][2][1][1], 1)

    def test_ranges_and_index_keys_without_payload(self):
        self.commit([self.put("saves", "a", 1), self.put("saves", "b", 2)])
        self.assertEqual(self.read(index="turn", query={"lower": 1, "lowerOpen": True}, keysOnly=True),
                         [{"key": 2, "primaryKey": "b"}])
        self.assertEqual(len(self.read(query=None)), 2)

    def test_local_storage_conflict_and_tombstone(self):
        self.store.local_write({"key": "tm_api", "value": "settings", "version": 0})
        self.store.local_write({"key": "tm_api", "value": None, "version": 1})
        with self.assertRaises(StorageError):
            self.store.local_write({"key": "tm_api", "value": "stale", "version": 0})
        self.assertEqual(self.store.bootstrap()["values"], {})
        self.store.local_write({"key": "theme", "value": "dark", "version": 0})
        with self.assertRaises(StorageError):
            self.store.local_write({"clear": True, "revision": 2})
        self.assertEqual(self.store.bootstrap()["values"], {"theme": "dark"})

    def test_empty_bootstrap_and_stable_dataset_identity(self):
        boot = self.store.bootstrap()
        self.assertEqual(boot["values"], {})
        self.assertEqual(boot["versions"], {})
        self.assertEqual(boot["revision"], 0)
        self.assertFalse(boot["hasProject"])
        reopened = Storage(self.path)
        self.assertEqual(reopened.bootstrap()["datasetId"], boot["datasetId"])
        reopened.close()
        other = Storage(Path(self.temp.name) / "new.sqlite3")
        self.assertNotEqual(other.bootstrap()["datasetId"], boot["datasetId"])
        other.close()

    def test_project_compression_does_not_block_settings_writes(self):
        preparing, finish, saved = threading.Event(), threading.Event(), threading.Event()
        errors = []
        compress = zlib.compress
        def slow_compress(*args, **kwargs):
            preparing.set()
            if not finish.wait(5):
                raise TimeoutError("compression test was not released")
            return compress(*args, **kwargs)
        def snapshot():
            try:
                self.commit([self.put("saves", "large", 2)])
            except BaseException as error:
                errors.append(error)
        def settings():
            try:
                self.store.local_write({"key": "theme", "value": "dark", "version": 0})
                saved.set()
            except BaseException as error:
                errors.append(error)
        with patch("storage.zlib.compress", slow_compress):
            worker = threading.Thread(target=snapshot)
            worker.start()
            try:
                self.assertTrue(preparing.wait(2))
                writer = threading.Thread(target=settings)
                writer.start()
                self.assertTrue(saved.wait(2), "settings must commit while project compression is still paused")
            finally:
                finish.set()
                worker.join(6)
                if 'writer' in locals():
                    writer.join(6)
        self.assertEqual(errors, [])
        self.assertEqual(self.store.bootstrap()["values"], {"theme": "dark"})
        self.assertEqual(self.read()[0]["primaryKey"], "large")


if __name__ == "__main__":
    unittest.main()

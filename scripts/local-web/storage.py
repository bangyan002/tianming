"""SQLite owner for all browser persistent stores; no browser-specific namespaces."""
import base64
import json
import sqlite3
import threading
import time
import uuid
import zlib
from contextlib import contextmanager


class StorageError(Exception):
    def __init__(self, message, name="UnknownError", status=400):
        super().__init__(message)
        self.name, self.status = name, status


def dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def key_order(key):
    if isinstance(key, bool) or key is None:
        raise StorageError("无效的数据库键", "DataError")
    if isinstance(key, (int, float)):
        return (0, key)
    if isinstance(key, str):
        # IndexedDB compares UTF-16 code units, rather than Unicode code points.
        return (2, key.encode("utf-16-be", errors="surrogatepass"))
    if isinstance(key, list):
        return (4, tuple(key_order(k) for k in key))
    if isinstance(key, dict) and "date" in key:
        return (1, key["date"])
    if isinstance(key, dict) and "binary" in key:
        return (3, base64.b64decode(key["binary"], validate=True))
    raise StorageError("无效的数据库键", "DataError")


def in_range(key, query):
    if query is None:
        return True
    ordered = key_order(key)
    if "lower" in query:
        low = key_order(query["lower"])
        if ordered < low or (ordered == low and query.get("lowerOpen")):
            return False
    if "upper" in query:
        high = key_order(query["upper"])
        if ordered > high or (ordered == high and query.get("upperOpen")):
            return False
    return True


class Storage:
    def __init__(self, path):
        self.path = str(path)
        self._timings = threading.local()
        # Keep WAL open between requests instead of checkpointing/deleting it
        # whenever the last short-lived request connection closes.
        self._keeper = self.connect()
        with self._keeper as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                INSERT OR IGNORE INTO settings VALUES ('local_revision', '0');
                CREATE TABLE IF NOT EXISTS local_storage (
                    key TEXT PRIMARY KEY, value TEXT, revision INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS databases (
                    name TEXT PRIMARY KEY, version INTEGER NOT NULL, revision INTEGER NOT NULL,
                    schema_json TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS records (
                    db TEXT NOT NULL, store TEXT NOT NULL, key TEXT NOT NULL, value BLOB NOT NULL,
                    PRIMARY KEY(db, store, key));
                CREATE TABLE IF NOT EXISTS index_keys (
                    db TEXT NOT NULL, store TEXT NOT NULL, name TEXT NOT NULL,
                    key TEXT NOT NULL, primary_key TEXT NOT NULL,
                    PRIMARY KEY(db, store, name, key, primary_key));
                CREATE TABLE IF NOT EXISTS commits (
                    id TEXT PRIMARY KEY, db TEXT NOT NULL, revision INTEGER NOT NULL);
            """)
            db.execute("INSERT OR IGNORE INTO settings VALUES ('dataset_id', ?)", (uuid.uuid4().hex,))
            self.dataset_id = db.execute("SELECT value FROM settings WHERE key='dataset_id'").fetchone()[0]

    def close(self):
        self._keeper.close()

    def reset_timing(self):
        self._timings.values = {}

    def timing(self):
        return getattr(self._timings, "values", {})

    def measure(self, name, duration):
        values = self.timing()
        values[name] = values.get(name, 0) + duration * 1000

    def connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA synchronous=FULL")
        return db

    @contextmanager
    def transaction(self, write=False):
        db = self.connect()
        try:
            started = time.perf_counter()
            db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            self.measure("lock", time.perf_counter() - started)
            started = time.perf_counter()
            yield db
            db.commit()
            self.measure("sqlite", time.perf_counter() - started)
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def meta(db, name):
        row = db.execute("SELECT * FROM databases WHERE name=?", (name,)).fetchone()
        return {"name": name, "version": row["version"], "revision": row["revision"],
                "schema": json.loads(row["schema_json"])} if row else {
                    "name": name, "version": 0, "revision": 0, "schema": {}}

    @staticmethod
    def expect(actual, expected):
        if actual != expected:
            raise StorageError("服务端数据已被另一页面更新，请重新打开页面后继续", "ServerConflictError", 409)

    def bootstrap(self):
        with self.transaction() as db:
            rows = db.execute("SELECT * FROM local_storage").fetchall()
            return {"datasetId": self.dataset_id,
                    "hasProject": bool(db.execute("SELECT 1 FROM records WHERE db=? AND store=? AND key=?",
                                                  ("tianming_db", "projects", dumps("current_project"))).fetchone()),
                    "values": {r["key"]: r["value"] for r in rows if r["value"] is not None},
                    "versions": {r["key"]: r["revision"] for r in rows},
                    "revision": int(db.execute("SELECT value FROM settings WHERE key='local_revision'").fetchone()[0])}

    def local_write(self, data):
        with self.transaction(True) as db:
            revision = int(db.execute("SELECT value FROM settings WHERE key='local_revision'").fetchone()[0])
            if data.get("clear"):
                self.expect(revision, data["revision"])
                revision += 1
                db.execute("UPDATE local_storage SET value=NULL, revision=?", (revision,))
            else:
                key, value = str(data["key"]), data.get("value")
                if value is not None and not isinstance(value, str):
                    raise StorageError("存储值必须为文本", "DataError")
                row = db.execute("SELECT * FROM local_storage WHERE key=?", (key,)).fetchone()
                previous, expected = (row["value"], row["revision"]) if row else (None, 0)
                if previous == value:
                    return {"version": expected, "revision": revision}
                self.expect(expected, data["version"])
                revision += 1
                db.execute("INSERT OR REPLACE INTO local_storage VALUES (?, ?, ?)", (key, value, revision))
            db.execute("UPDATE settings SET value=? WHERE key='local_revision'", (str(revision),))
            return {"version": revision, "revision": revision}

    def open(self, data):
        with self.transaction() as db:
            return self.meta(db, data["name"])

    def begin(self, data):
        with self.transaction() as db:
            meta = self.meta(db, data["name"])
            if data["mode"] != "readonly":
                self.expect(meta["revision"], data["revision"])
            return meta

    def read(self, data):
        name, store, index = data["name"], data["store"], data.get("index")
        with self.transaction() as db:
            self.expect(self.meta(db, name)["revision"], data["revision"])
            if index:
                items = db.execute("SELECT key, primary_key FROM index_keys WHERE db=? AND store=? AND name=?",
                                   (name, store, index)).fetchall()
                pairs = [(json.loads(r["key"]), r["primary_key"]) for r in items]
            elif (data.get("query") or {}).get("lower") is not None and data["query"].get("lower") == data["query"].get("upper"):
                k = dumps(data["query"]["lower"])
                pairs = [(json.loads(k), k)] if db.execute(
                    "SELECT 1 FROM records WHERE db=? AND store=? AND key=?", (name, store, k)).fetchone() else []
            else:
                pairs = [(json.loads(r[0]), r[0]) for r in db.execute(
                    "SELECT key FROM records WHERE db=? AND store=?", (name, store))]
            pairs = [(k, p) for k, p in pairs if in_range(k, data.get("query"))]
            pairs.sort(key=lambda pair: (key_order(pair[0]), key_order(json.loads(pair[1]))))
            rows = []
            for key, primary in pairs:
                item = {"key": key, "primaryKey": json.loads(primary)}
                if not data.get("keysOnly"):
                    raw = db.execute("SELECT value FROM records WHERE db=? AND store=? AND key=?",
                                     (name, store, primary)).fetchone()
                    if raw:
                        item["value"] = json.loads(zlib.decompress(raw[0]))
                rows.append(item)
            return {"rows": rows}

    @staticmethod
    def put(db, name, store, operation, schema, payload):
        key = dumps(operation["key"])
        key_order(operation["key"])
        if operation.get("add") and db.execute(
                "SELECT 1 FROM records WHERE db=? AND store=? AND key=?", (name, store, key)).fetchone():
            raise StorageError("记录已存在", "ConstraintError")
        db.execute("DELETE FROM index_keys WHERE db=? AND store=? AND primary_key=?", (name, store, key))
        for index, keys in operation.get("indexes", {}).items():
            spec = schema[store].get("indexes", {}).get(index)
            if not spec:
                raise StorageError("索引不存在", "NotFoundError")
            for item in keys:
                encoded = dumps(item)
                key_order(item)
                if spec.get("unique") and db.execute(
                        "SELECT 1 FROM index_keys WHERE db=? AND store=? AND name=? AND key=? AND primary_key<>?",
                        (name, store, index, encoded, key)).fetchone():
                    raise StorageError("唯一索引冲突", "ConstraintError")
                db.execute("INSERT OR IGNORE INTO index_keys VALUES (?, ?, ?, ?, ?)", (name, store, index, encoded, key))
        db.execute("INSERT OR REPLACE INTO records VALUES (?, ?, ?, ?)",
                   (name, store, key, payload))

    def commit(self, data):
        name = data["name"]
        with self.transaction() as db:
            receipt = db.execute("SELECT db, revision FROM commits WHERE id=?", (data["id"],)).fetchone()
            if receipt:
                if receipt["db"] != name:
                    raise StorageError("事务标识冲突", "DataError")
                return {"revision": receipt["revision"]}
        # Large project snapshots must not hold SQLite's global writer lock
        # during JSON encoding and compression. Constraints/CAS stay atomic below.
        started = time.perf_counter()
        operations = [(op, zlib.compress(dumps(op["value"]).encode("utf-8"), level=1)
                       if op["type"] == "put" else None) for op in data["operations"]]
        self.measure("prepare", time.perf_counter() - started)
        with self.transaction(True) as db:
            receipt = db.execute("SELECT db, revision FROM commits WHERE id=?", (data["id"],)).fetchone()
            if receipt:
                if receipt["db"] != name:
                    raise StorageError("事务标识冲突", "DataError")
                return {"revision": receipt["revision"]}
            meta = self.meta(db, name)
            self.expect(meta["revision"], data["revision"])
            schema = data.get("schema", meta["schema"])
            version = data.get("version", meta["version"])
            for obsolete in set(meta["schema"]) - set(schema):
                db.execute("DELETE FROM records WHERE db=? AND store=?", (name, obsolete))
                db.execute("DELETE FROM index_keys WHERE db=? AND store=?", (name, obsolete))
            for op, payload in operations:
                store = op["store"]
                if store not in schema:
                    raise StorageError("存储表不存在", "NotFoundError")
                if op["type"] == "put":
                    self.put(db, name, store, op, schema, payload)
                elif op["type"] == "delete":
                    key = dumps(op["key"])
                    db.execute("DELETE FROM records WHERE db=? AND store=? AND key=?", (name, store, key))
                    db.execute("DELETE FROM index_keys WHERE db=? AND store=? AND primary_key=?", (name, store, key))
                elif op["type"] == "clear":
                    db.execute("DELETE FROM records WHERE db=? AND store=?", (name, store))
                    db.execute("DELETE FROM index_keys WHERE db=? AND store=?", (name, store))
                else:
                    raise StorageError("未知事务操作", "DataError")
            revision = meta["revision"] + 1
            db.execute("INSERT OR REPLACE INTO databases VALUES (?, ?, ?, ?)", (name, version, revision, dumps(schema)))
            db.execute("INSERT INTO commits VALUES (?, ?, ?)", (data["id"], name, revision))
            return {"revision": revision}

    def outcome(self, data):
        with self.transaction() as db:
            row = db.execute("SELECT revision FROM commits WHERE id=?", (data["id"],)).fetchone()
            return {"committed": bool(row), "revision": row[0] if row else None}

    def delete(self, data):
        with self.transaction(True) as db:
            meta = self.meta(db, data["name"])
            self.expect(meta["revision"], data["revision"])
            for table in ("records", "index_keys"):
                db.execute("DELETE FROM " + table + " WHERE db=?", (data["name"],))
            # Keep a tombstone revision so a stale connection cannot resurrect deleted data.
            revision = meta["revision"] + 1
            db.execute("INSERT OR REPLACE INTO databases VALUES (?, 0, ?, '{}')", (data["name"], revision))
            return {"revision": revision}

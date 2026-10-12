#!/usr/bin/env python3
"""Local web server and lifecycle controller. Requires only Python's standard library."""
import argparse
import fcntl
import gzip
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import uuid
import zlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent.parent
LIB = ROOT / "scripts" / "local-web"
sys.path.insert(0, str(LIB))
from storage import Storage, StorageError, dumps
from assets import AssetCache, HASH_PARAMETER, accepts_gzip, resource_urls, available_assets, without_missing_css
from script_packs import PREFIX as PACK_PREFIX, ScriptPacks

API = "/__tm_storage__/"
MAX_REQUEST_BYTES = 1024 * 1024 * 1024


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    timeout = 15
    disable_nagle_algorithm = True

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "web"), **kwargs)

    def reply(self, content, content_type="application/json; charset=utf-8", status=200):
        if not isinstance(content, bytes):
            content = (content if isinstance(content, str) else dumps(content)).encode("utf-8")
        compressed = len(content) >= 1024 and accepts_gzip(self.headers.get("Accept-Encoding", ""))
        if compressed:
            content = gzip.compress(content, compresslevel=6, mtime=0)
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Vary", "Accept-Encoding")
        if getattr(self, "storage_timing", None):
            self.send_header("Server-Timing", ", ".join(f"{key};dur={value:.2f}" for key, value in self.storage_timing.items()))
        if compressed:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(content)

    def asset(self, target):
        asset = self.server.assets.get(target)
        body, encoding = asset.representation(self.headers.get("Accept-Encoding", ""))
        etag = '"' + asset.digest + ("-gzip" if encoding else "-identity") + '"'
        query = parse_qs(urlsplit(self.path).query)
        pinned = query.get(HASH_PARAMETER) == [asset.digest] or self.path.startswith(PACK_PREFIX)
        matches = [value.strip().removeprefix("W/") for value in self.headers.get("If-None-Match", "").split(",")]
        fresh = etag in matches or "*" in matches
        self.send_response(304 if fresh else 200)
        self.send_header("ETag", etag)
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("Cache-Control", "public, max-age=31536000, immutable" if pinned else "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        if not fresh:
            self.send_header("Content-Type", asset.mime)
            self.send_header("Content-Length", str(len(body)))
            if encoding:
                self.send_header("Content-Encoding", encoding)
        self.end_headers()
        if not fresh and self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self):
        self.storage_timing = {}
        path = urlsplit(self.path).path
        if path == API + "health":
            self.reply({"service": "tianming-local-web", "instance": self.server.instance,
                        "pid": os.getpid(), "database": str(self.server.storage.path)})
            return
        if path == API + "bootstrap":
            self.reply(dict(self.server.storage.bootstrap(), gzipRequests=True))
            return
        if path == API + "loading":
            self.reply(self.server.packs.last_stats or {})
            return
        if path in (API + "bridge.js", API + "codec.js", API + "local-first.js", API + "save-worker.js", API + "optional-assets.js"):
            self.asset(LIB / path.removeprefix(API))
            return
        if path.startswith(PACK_PREFIX):
            target = self.server.packs.resolve(path.removeprefix(PACK_PREFIX))
            if target:
                self.asset(target)
            else:
                self.send_error(404)
            return
        if path.startswith(API):
            self.send_error(404)
            return
        target = Path(self.translate_path(path)).resolve()
        web = (ROOT / "web").resolve()
        # Never expose repo data or files reached through a symlink outside web/.
        if not target.is_relative_to(web) or any(p.startswith(".") for p in Path(unquote(path)).parts):
            self.send_error(403)
            return
        if target.is_dir():
            target = target / "index.html"
        destination = self.headers.get("Sec-Fetch-Dest", "")
        navigation = destination in ("document", "iframe", "frame") or (
            not destination and "text/html" in self.headers.get("Accept", ""))
        # Native start preparation fetches and hashes the original HTML bytes.
        # Inject only actual navigations; fetch/HEAD resource checks must stay byte-identical.
        if navigation and target.is_file() and target.suffix.lower() in (".html", ".htm"):
            inventory = available_assets(web)
            origin = "http://" + self.headers.get("Host", "")
            source = self.server.packs.navigation(target.read_bytes(), target, web)
            source = resource_urls(source, target, web, self.server.assets, asset_inventory=inventory, origin=origin)
            bridge_hash = self.server.assets.get(LIB / "local-first.js").digest
            codec_hash = self.server.assets.get(LIB / "codec.js").digest
            tag = ('<script src="/__tm_storage__/codec.js?' + HASH_PARAMETER + '=' + codec_hash + '"></script>'
                   '<script src="/__tm_storage__/local-first.js?' + HASH_PARAMETER + '=' + bridge_hash + '"></script>').encode()
            optional_hash = self.server.assets.get(LIB / "optional-assets.js").digest
            manifest = json.dumps(inventory, ensure_ascii=True).replace("<", "\\u003c")
            tag = ('<script>window.TM_LOCAL_ASSETS=' + manifest + ';</script>'
                   '<script src="/__tm_storage__/optional-assets.js?' + HASH_PARAMETER + '=' + optional_hash + '"></script>').encode() + tag
            # Inject before any application script, including inline preferences and editor pages.
            head = re.search(br"<head(?:\s[^>]*)?>", source, re.I)
            point = head.end() if head else 0
            self.reply(source[:point] + tag + source[point:], "text/html; charset=utf-8")
            return
        if target.is_dir() or not target.exists():
            self.send_error(404)
            return
        stylesheet = destination == "style" or (not destination and "text/css" in self.headers.get("Accept", ""))
        if stylesheet and target.suffix.lower() == ".css":
            self.reply(without_missing_css(target.read_bytes(), target, web, "http://" + self.headers.get("Host", "")), "text/css; charset=utf-8")
            return
        if target.suffix.lower() in (".js", ".mjs", ".css", ".html", ".htm", ".json", ".svg", ".txt", ".xml"):
            self.asset(target)
            return
        if self.command == "HEAD":
            super().do_HEAD()
        else:
            super().do_GET()

    def do_HEAD(self):
        self.do_GET()

    def request_data(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length < 1 or length > MAX_REQUEST_BYTES:
            self.close_connection = True
            raise StorageError("请求大小超出范围", "DataError", 413)
        started = time.perf_counter()
        raw = self.rfile.read(length)
        self.storage_timing["receive"] = (time.perf_counter() - started) * 1000
        if len(raw) != length:
            self.close_connection = True
            raise StorageError("请求上传不完整", "DataError")
        encoding = self.headers.get("Content-Encoding", "identity").strip().lower()
        if encoding == "gzip":
            started = time.perf_counter()
            try:
                decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
                raw = decoder.decompress(raw, MAX_REQUEST_BYTES + 1)
                if len(raw) > MAX_REQUEST_BYTES or decoder.unconsumed_tail:
                    raise StorageError("解压后请求大小超出范围", "DataError", 413)
                if not decoder.eof or decoder.unused_data:
                    raise StorageError("无效或不完整的 gzip 请求", "DataError")
            except zlib.error:
                raise StorageError("无效的 gzip 请求", "DataError") from None
            self.storage_timing["inflate"] = (time.perf_counter() - started) * 1000
        elif encoding != "identity":
            raise StorageError("不支持的请求压缩格式", "DataError", 415)
        self.storage_wire_bytes = length
        self.storage_json_bytes = len(raw)
        started = time.perf_counter()
        data = json.loads(raw)
        self.storage_timing["parse"] = (time.perf_counter() - started) * 1000
        return data

    def do_POST(self):
        self.storage_timing = {}
        path = urlsplit(self.path).path
        methods = {"local": "local_write", "open": "open", "begin": "begin", "read": "read",
                   "commit": "commit", "outcome": "outcome", "delete": "delete"}
        method = methods.get(path.removeprefix(API)) if path.startswith(API) else None
        if not method:
            self.send_error(404)
            return
        origin = self.headers.get("Origin")
        if origin and urlsplit(origin).netloc != self.headers.get("Host"):
            self.reply({"error": "跨站写入被拒绝", "name": "SecurityError"}, status=403)
            return
        try:
            data = self.request_data()
            # A reset creates a new identity: old tabs cannot repopulate the fresh database.
            if self.headers.get("X-TM-Storage-ID") != self.server.storage.dataset_id:
                raise StorageError("服务端数据已重置或页面版本已更新，请刷新页面后继续", "ServerResetError", 409)
            self.server.storage.reset_timing()
            started = time.perf_counter()
            try:
                result = getattr(self.server.storage, method)(data)
            finally:
                self.storage_timing["store"] = (time.perf_counter() - started) * 1000
                self.storage_timing.update(self.server.storage.timing())
                if self.storage_timing["store"] >= 500:
                    self.log_message("slow storage %s bytes=%d decoded=%d timing=%s", method,
                                     self.storage_wire_bytes, self.storage_json_bytes, dumps(self.storage_timing))
            self.reply(result)
        except StorageError as error:
            self.reply({"error": str(error), "name": error.name}, status=error.status)
        except (ValueError, TypeError, KeyError) as error:
            self.reply({"error": "无效的数据请求: " + str(error), "name": "DataError"}, status=400)
        except Exception as error:
            print("Storage request failed:", repr(error), file=sys.stderr, flush=True)
            self.reply({"error": "服务端存储失败，请查看服务日志", "name": "UnknownError"}, status=500)


def configuration(args):
    folder = Path(args.data_dir).expanduser().resolve()
    folder.mkdir(parents=True, exist_ok=True)
    folder.chmod(0o700)
    return folder, folder / "server.json"


def read_state(file):
    try:
        return json.loads(file.read_text())
    except (FileNotFoundError, ValueError):
        return None


def owns_process(state):
    if not state:
        return False
    try:
        # Identity includes an unpredictable instance argument, preventing PID reuse kills.
        proc = Path(f"/proc/{state['pid']}/cmdline")
        if proc.exists():
            parts = proc.read_bytes().split(b"\0")
            return str(Path(__file__).resolve()).encode() in parts and state["instance"].encode() in parts
        with urlopen(f"http://127.0.0.1:{state['port']}{API}health", timeout=1) as response:
            body = json.load(response)
        return body["instance"] == state["instance"] and body["pid"] == state["pid"]
    except (OSError, ValueError, KeyError):
        return False


def serve(args):
    folder, state_file = configuration(args)
    with (folder / "server.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit("天命服务已在运行")
        storage = Storage(folder / "tianming.sqlite3")
        with ThreadingHTTPServer((args.bind, args.port), Handler) as server:
            server.daemon_threads = True
            server.instance, server.storage = args.instance, storage
            server.assets = AssetCache()
            server.packs = ScriptPacks(folder / "script-packs", server.assets)
            state = {"pid": os.getpid(), "port": server.server_port, "bind": args.bind, "instance": args.instance}
            temporary = folder / "server.json.tmp"
            temporary.write_text(dumps(state))
            temporary.replace(state_file)
            (folder / "tianming.sqlite3").chmod(0o600)
            print(f"天命: http://127.0.0.1:{server.server_port} · SQLite: {storage.path}", flush=True)
            def terminate(_signal, _frame):
                raise KeyboardInterrupt
            signal.signal(signal.SIGTERM, terminate)
            try:
                server.serve_forever(poll_interval=0.2)
            except KeyboardInterrupt:
                pass
            finally:
                if read_state(state_file) == state:
                    state_file.unlink(missing_ok=True)
                storage.close()


def control(args):
    folder, state_file = configuration(args)
    # Serialize lifecycle operations, including restart and concurrent starts.
    with (folder / "control.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = read_state(state_file)
        running = owns_process(state)
        if args.action == "logs":
            log = folder / "server.log"
            print("".join(log.read_text(errors="replace").splitlines(keepends=True)[-80:]) if log.exists() else "暂无日志", end="")
            return 0
        if args.action == "status":
            print(f"运行中: PID {state['pid']} · http://127.0.0.1:{state['port']}" if running else "已停止")
            print(f"数据库: {folder / 'tianming.sqlite3'}")
            return 0 if running else 1
        # A plain restart preserves the listener configuration recorded at start.
        args.port = args.port if args.port is not None else (state["port"] if args.action in ("restart", "reset") and state else 9123)
        args.bind = args.bind if args.bind is not None else (state["bind"] if args.action in ("restart", "reset") and state else "0.0.0.0")
        if args.action in ("stop", "restart", "reset"):
            if running:
                os.kill(state["pid"], signal.SIGTERM)
                for _ in range(100):
                    if not owns_process(state):
                        break
                    time.sleep(0.1)
                else:
                    raise SystemExit("服务未能停止；未强行终止，请查看日志")
                print("天命服务已停止（存档保留）")
            elif args.action == "stop":
                print("天命服务已停止")
            state_file.unlink(missing_ok=True)
            if args.action == "stop":
                return 0
        elif running:
            print(f"天命服务已在运行: http://127.0.0.1:{state['port']}")
            return 0
        if args.action == "reset":
            reset_data(folder)
        instance = str(uuid.uuid4())
        command = [sys.executable, str(Path(__file__).resolve()), "serve", "--port", str(args.port),
                   "--bind", args.bind, "--data-dir", str(folder), "--instance", instance]
        with (folder / "server.log").open("ab") as log:
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        for _ in range(100):
            state = read_state(state_file)
            if state and state["instance"] == instance and owns_process(state):
                print(f"天命服务已启动: http://127.0.0.1:{state['port']}")
                if state["bind"] not in ("127.0.0.1", "localhost"):
                    print(f"其他设备: http://服务器IP:{state['port']} （监听 {state['bind']}）")
                print(f"数据库: {folder / 'tianming.sqlite3'}")
                return 0
            if process.poll() is not None:
                raise SystemExit(f"启动失败，请查看 {folder / 'server.log'}")
            time.sleep(0.1)
        # The process belongs to this invocation; do not leave a half-started server behind.
        process.terminate()
        process.wait(timeout=5)
        raise SystemExit(f"启动等待超时，请查看 {folder / 'server.log'}")


def reset_data(folder):
    # Keep lifecycle locks in place while replacing only the persistent dataset.
    with (folder / "server.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit("服务仍在占用数据库，未清空数据")
        files = [folder / name for name in ("tianming.sqlite3", "tianming.sqlite3-wal", "tianming.sqlite3-shm")]
        if any(file.exists() for file in files):
            stamp = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8]
            backup = folder.with_name(folder.name + ".backup-" + stamp)
            backup.mkdir(mode=0o700)
            for file in files:
                if file.exists():
                    file.replace(backup / file.name)
            print(f"旧数据库已备份: {backup}")
        Storage(folder / "tianming.sqlite3").close()
        (folder / "tianming.sqlite3").chmod(0o600)
        print("服务端存档、剧本和设置已清空；启动后请刷新所有已打开的页面")


def main():
    parser = argparse.ArgumentParser(prog="local_start.sh", description="天命网页版 · 共享 SQLite 存储",
                                     formatter_class=argparse.RawDescriptionHelpFormatter,
                                     epilog="""例子:
  ./local_start.sh start
  ./local_start.sh restart
  ./local_start.sh reset           # 备份旧数据库，清空全部存档/配置并重启
  ./local_start.sh status
  ./local_start.sh logs
  ./local_start.sh start --port 9124 --data-dir /path/to/data

默认监听 0.0.0.0:9123；数据库位于仓库 .local-data/tianming.sqlite3。
新数据库从空存档开始，不导入浏览器的 localStorage 或 IndexedDB 旧数据。
reset 的备份位于数据目录旁边的 <目录名>.backup-<时间>-<随机标识>/。
环境变量: TIANMING_PORT / TIANMING_BIND / TIANMING_DATA_DIR。""")
    parser.add_argument("action", choices=("start", "stop", "restart", "reset", "status", "logs", "serve"), nargs="?", default="start")
    parser.add_argument("--port", type=int, default=int(os.environ["TIANMING_PORT"]) if "TIANMING_PORT" in os.environ else None)
    parser.add_argument("--bind", default=os.environ.get("TIANMING_BIND"))
    parser.add_argument("--data-dir", default=os.environ.get("TIANMING_DATA_DIR", str(ROOT / ".local-data")))
    parser.add_argument("--instance", default=str(uuid.uuid4()), help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.action == "serve":
        args.port = args.port if args.port is not None else 9123
        args.bind = args.bind if args.bind is not None else "0.0.0.0"
        serve(args)
        return 0
    return control(args)


if __name__ == "__main__":
    sys.exit(main())

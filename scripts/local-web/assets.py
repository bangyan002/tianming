"""HTTP asset representations and navigation-only content-hashed resource URLs."""
import gzip
import hashlib
import html
from html.parser import HTMLParser
import mimetypes
from pathlib import Path
import re
import threading
from collections import OrderedDict
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit, urlunsplit

HASH_PARAMETER = "tm-local"
TEXT_EXTENSIONS = {".js", ".mjs", ".css", ".html", ".htm", ".json", ".svg", ".txt", ".xml"}
# Preserve image failure semantics without sending a request for the absent file.
MISSING_IMAGE = "data:image/png;base64,"


def missing_asset_url(value, document, web, origin):
    """Only suppress same-origin assets whose public file is absent."""
    try:
        url = urlsplit(value)
        if url.scheme not in ("", "http", "https") or (url.netloc and url.netloc.lower() != urlsplit(origin).netloc.lower()):
            return False
        path = unquote(url.path)
        if not re.search(r"(?:^|/)assets/", path, re.I):
            return False
        target = (web / path.lstrip("/") if path.startswith("/") else document.parent / path).resolve()
        if not target.is_relative_to(web):
            return False
        if target.is_dir():
            target = target / "index.html"
        return not target.is_file()
    except (ValueError, OSError):
        return False


def available_assets(web):
    paths = set()
    for folder in web.rglob("assets"):
        if not folder.is_dir():
            continue
        for file in folder.rglob("*"):
            relative = file.relative_to(web)
            if file.is_file() and file.resolve().is_relative_to(web) and not any(part.startswith(".") for part in relative.parts):
                paths.add("/" + relative.as_posix())
    paths = sorted(paths)
    revision = hashlib.sha256("\n".join(paths).encode()).hexdigest()[:16]
    return {"paths": paths, "revision": revision}


def without_missing_css(source, document, web, origin):
    """Keep available artwork and fonts; remove only URLs that would return 404."""
    def replace(match):
        return "none" if missing_asset_url(match.group(2), document, web, origin) else match.group(0)
    return re.sub(r"url\(\s*(['\"]?)(.*?)\1\s*\)", replace, source.decode("utf-8-sig"), flags=re.I).encode("utf-8")


def accepts_gzip(header):
    qualities = {}
    for token in header.split(","):
        fields = token.strip().split(";")
        quality = 1.0
        for field in fields[1:]:
            if field.strip().startswith("q="):
                try:
                    quality = float(field.strip()[2:])
                except ValueError:
                    quality = 0.0
        qualities[fields[0].lower()] = quality
    return qualities.get("gzip", qualities.get("*", 0)) > 0


class Asset:
    def __init__(self, path, signature, raw):
        self.path, self.signature, self.raw = path, signature, raw
        self.digest = hashlib.sha256(raw).hexdigest()
        self.mime = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        if path.suffix.lower() in TEXT_EXTENSIONS:
            self.mime += "; charset=utf-8"
        self.compressible = path.suffix.lower() in TEXT_EXTENSIONS and len(raw) >= 1024
        self._gzip = None
        self._lock = threading.Lock()

    def representation(self, accept_encoding):
        if self.compressible and accepts_gzip(accept_encoding):
            with self._lock:
                if self._gzip is None:
                    self._gzip = gzip.compress(self.raw, compresslevel=6, mtime=0)
            if len(self._gzip) < len(self.raw):
                return self._gzip, "gzip"
        return self.raw, None


class AssetCache:
    def __init__(self, budget=64 * 1024 * 1024):
        self.budget, self.size = budget, 0
        self.entries = OrderedDict()
        self.lock = threading.Lock()

    def get(self, path):
        path = Path(path).resolve()
        stat = path.stat()
        signature = (stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size)
        # Some filesystems give rapid equal-size writes the same mtime/ctime.
        # Validate actual bytes so an unchanged version query can never hide an edit.
        raw = path.read_bytes()
        with self.lock:
            existing = self.entries.get(path)
            if existing and existing.raw == raw:
                self.entries.move_to_end(path)
                return existing
        # File I/O and compression must not serialize unrelated HTTP worker threads.
        asset = Asset(path, signature, raw)
        with self.lock:
            old = self.entries.pop(path, None)
            if old:
                self.size -= len(old.raw)
            if len(asset.raw) <= self.budget:
                self.entries[path] = asset
                self.size += len(asset.raw)
                while self.size > self.budget:
                    _, expired = self.entries.popitem(last=False)
                    self.size -= len(expired.raw)
        return asset


class ResourceURLs(HTMLParser):
    """Rewrite only real script/link tags, leaving inline JS, globals and load order intact."""
    def __init__(self, source, document, web, cache, asset_inventory=None, origin=""):
        super().__init__(convert_charrefs=False)
        self.source, self.document, self.web, self.cache = source, document, web, cache
        self.offsets = [0]
        for match in re.finditer("\n", source):
            self.offsets.append(match.end())
        self.replacements = []
        self.asset_inventory, self.origin, self.in_style = asset_inventory, origin, False

    def missing(self, value):
        return missing_asset_url(value, self.document, self.web, self.origin)

    def handle_starttag(self, tag, attrs):
        if tag == "style":
            self.in_style = True
        if self.asset_inventory is not None:
            raw_tag = self.get_starttag_text()
            line, column = self.getpos()
            start = self.offsets[line - 1] + column
            for match in re.finditer(r"\b(src|poster|srcset|style|href)\s*=\s*([\"'])(.*?)\2", raw_tag, re.I | re.S):
                name, value = match.group(1).lower(), html.unescape(match.group(3))
                rewritten = value
                if name == "style":
                    rewritten = without_missing_css(value.encode(), self.document, self.web, self.origin).decode()
                elif name == "srcset":
                    candidates = value.split(",")
                    kept = [item for item in candidates if not item.strip() or not self.missing(item.strip().split()[0])]
                    if kept != candidates:
                        rewritten = ",".join(kept) if kept else MISSING_IMAGE
                elif self.missing(value) and (name != "href" or tag == "link"):
                    rewritten = MISSING_IMAGE if tag in ("img", "image") or name == "poster" else ""
                if rewritten != value:
                    self.replacements.append((start + match.start(3), start + match.end(3), html.escape(rewritten, quote=True)))
        if tag not in ("script", "link"):
            return
        attributes = dict(attrs)
        if tag == "link" and attributes.get("rel", "").lower() not in ("stylesheet", "preload", "modulepreload"):
            return
        name = "src" if tag == "script" else "href"
        value = attributes.get(name)
        if not value:
            return
        if self.asset_inventory is not None and self.missing(value):
            return
        url = urlsplit(value)
        if url.scheme or url.netloc or not url.path:
            return
        target = (self.web / unquote(url.path).lstrip("/") if url.path.startswith("/") else
                  self.document.parent / unquote(url.path)).resolve()
        if not target.is_relative_to(self.web) or not target.is_file() or target.suffix.lower() not in (".js", ".mjs", ".css"):
            return
        query = [(k, v) for k, v in parse_qsl(url.query, keep_blank_values=True) if k != HASH_PARAMETER]
        query.append((HASH_PARAMETER, self.cache.get(target).digest))
        # Refresh served styles when assets are added, and bypass the old all-off cache.
        if self.asset_inventory is not None and target.suffix.lower() == ".css":
            query = [(k, v) for k, v in query if k != "tm-assets"]
            query.append(("tm-assets", self.asset_inventory["revision"]))
        rewritten = urlunsplit((url.scheme, url.netloc, url.path, urlencode(query), url.fragment))
        raw_tag = self.get_starttag_text()
        match = re.search(r"\b" + name + r"\s*=\s*([\"'])(.*?)\1", raw_tag, re.I | re.S)
        if not match:
            return
        line, column = self.getpos()
        start = self.offsets[line - 1] + column
        self.replacements.append((start + match.start(2), start + match.end(2), html.escape(rewritten, quote=True)))

    handle_startendtag = handle_starttag

    def handle_endtag(self, tag):
        if tag == "style":
            self.in_style = False

    def handle_data(self, data):
        if self.asset_inventory is not None and self.in_style:
            rewritten = without_missing_css(data.encode(), self.document, self.web, self.origin).decode()
            if rewritten != data:
                line, column = self.getpos()
                start = self.offsets[line - 1] + column
                self.replacements.append((start, start + len(data), rewritten))


def resource_urls(source, document, web, cache, asset_inventory=None, origin=""):
    # This changes only served navigations, never repository files or byte-pinned fetches.
    text = source.decode("utf-8-sig")
    parser = ResourceURLs(text, document.resolve(), web.resolve(), cache, asset_inventory, origin)
    parser.feed(text)
    for start, end, value in sorted(parser.replacements, reverse=True):
        text = text[:start] + value + text[end:]
    return text.encode("utf-8")

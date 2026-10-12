"""Transport classic scripts in fewer requests, preserving each script's global evaluation."""
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import threading
from urllib.parse import unquote, urlsplit

PREFIX = "/__tm_storage__/packs/"
MAX_PACK_BYTES = 1024 * 1024
SENSITIVE = re.compile(r"currentScript|document\s*\.\s*(?:write\s*\(|scripts)|"
                       r"querySelector(?:All)?\([^\n]*script|getElementsByTagName\([\"']script")


class ScriptTags(HTMLParser):
    def __init__(self, text):
        super().__init__(convert_charrefs=False)
        self.offsets = [0] + [m.end() for m in re.finditer("\n", text)]
        self.tags, self.active, self.text, self.policies = [], None, text, []

    def position(self):
        line, column = self.getpos()
        return self.offsets[line - 1] + column

    def handle_starttag(self, tag, attrs):
        if tag == "meta":
            meta = dict(attrs)
            if meta.get("http-equiv", "").lower() == "content-security-policy":
                directives = {part.strip().split()[0]: part.strip().split()[1:] for part in meta.get("content", "").split(";") if part.strip()}
                policy = directives.get("script-src-elem", directives.get("script-src", directives.get("default-src", [])))
                self.policies.append(policy)
        if tag == "script":
            self.active = {"start": self.position(), "attrs": dict(attrs), "body": ""}

    def handle_data(self, text):
        if self.active:
            self.active["body"] += text

    def handle_endtag(self, tag):
        if tag == "script" and self.active:
            closing = re.match(r"</script\s*>", self.text[self.position():], re.I)
            self.active["end"] = self.position() + len(closing.group(0))
            self.tags.append(self.active)
            self.active = None


class ScriptPacks:
    def __init__(self, folder, assets):
        self.folder = Path(folder)
        self.folder.mkdir(parents=True, exist_ok=True)
        self.assets = assets
        self.lock = threading.Lock()
        self.last_stats = None

    def register(self, members):
        # Concatenating classic files changes function hoisting and patch-wrapper capture.
        # Each member is therefore evaluated as its own trusted inline classic script,
        # at the original parser/defer boundary, without eval or new CSP permissions.
        entries = [[item["src"], item["code"]] for item in members]
        raw = ("/* Generated local transport pack; source files remain canonical. */\n"
               "(function(){var entries=" + json.dumps(entries, ensure_ascii=False, separators=(",", ":")) + ";\n"
               "var anchor=document.currentScript;for(var i=0;i<entries.length;i++){"
               "var node=document.createElement('script');"
               "if(anchor&&anchor.nonce)node.nonce=anchor.nonce;"
               "node.setAttribute('data-tm-source',entries[i][0]);"
               "node.text=entries[i][1]+'\\n//# sourceURL='+new URL(entries[i][0],location.href).href+'\\n';"
               "(anchor&&anchor.parentNode?anchor.parentNode:document.head).appendChild(node);"
               "node.remove();}})();\n").encode("utf-8")
        name = hashlib.sha256(raw).hexdigest() + ".js"
        target = self.folder / name
        with self.lock:
            if not target.exists():
                temp = self.folder / (name + ".tmp")
                temp.write_bytes(raw)
                temp.replace(target)
        return PREFIX + name

    def resolve(self, name):
        if not re.fullmatch(r"[a-f0-9]{64}\.js", name):
            return None
        target = self.folder / name
        return target if target.is_file() else None

    def navigation(self, source, document, web):
        text = source.decode("utf-8-sig")
        # Only the main application opts in; editor and native preparation policies stay independent.
        if document.resolve() != (web / "index.html").resolve():
            return source
        parser = ScriptTags(text)
        parser.feed(text)
        if any("'unsafe-inline'" not in p or any(token.startswith(("'nonce-", "'sha256-", "'sha384-", "'sha512-")) for token in p) for p in parser.policies):
            return source
        replacements, urls, pending = [], [], []
        total = sum(bool(t["attrs"].get("src")) for t in parser.tags)
        grouped = 0

        def flush():
            nonlocal pending, grouped
            if len(pending) > 1:
                url = self.register(pending)
                defer = " defer" if pending[0]["defer"] else ""
                replacement = '<script src="' + url + '"' + defer + '></script>'
                replacements.append((pending[0]["start"], pending[-1]["end"], replacement))
                urls.append((url, pending[0]["defer"]))
                grouped += len(pending)
            pending = []

        for tag in parser.tags:
            attrs, src = tag["attrs"], tag["attrs"].get("src")
            uri = urlsplit(src or "")
            eligible = (bool(src) and not tag["body"].strip() and set(attrs) <= {"src", "defer"}
                        and not uri.scheme and not uri.netloc and uri.path.endswith(".js"))
            if not eligible:
                flush()
                continue
            target = (web / unquote(uri.path).lstrip("/") if uri.path.startswith("/") else document.parent / unquote(uri.path)).resolve()
            if not target.is_relative_to(web.resolve()) or not target.is_file():
                flush()
                continue
            code = self.assets.get(target).raw.decode("utf-8-sig")
            if SENSITIVE.search(code):
                flush()
                continue
            member = dict(tag, src=src, code=code, defer="defer" in attrs)
            if pending:
                gap = text[pending[-1]["end"]:tag["start"]]
                adjacent = re.fullmatch(r"(?:\s|<!--[\s\S]*?-->)*", gap) is not None
                size = sum(len(m["code"].encode("utf-8")) for m in pending) + len(code.encode("utf-8"))
                if not adjacent or pending[0]["defer"] != member["defer"] or size > MAX_PACK_BYTES:
                    flush()
            pending.append(member)
        flush()
        for start, end, replacement in reversed(replacements):
            text = text[:start] + replacement + text[end:]
        # Download all parser-blocking packs concurrently; execution remains document ordered.
        preloads = "".join('<link rel="preload" as="script" href="' + url + '">' for url, deferred in urls if not deferred)
        head = re.search(r"<head(?:\s[^>]*)?>", text, re.I)
        if head:
            text = text[:head.end()] + preloads + text[head.end():]
        self.last_stats = {"originalScripts": total, "packedScripts": grouped, "packs": len(urls),
                           "externalScripts": total - grouped + len(urls)}
        return text.encode("utf-8")

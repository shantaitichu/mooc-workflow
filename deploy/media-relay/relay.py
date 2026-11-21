"""Temporary media store for the MOOC workbench. Serve behind an HTTPS reverse proxy."""

import hashlib
import hmac
import os
import re
import shutil
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


DAY = 86400
BLOCK = 256 * 1024
UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
EXTENSIONS = {
    "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
    "video/mp4": "mp4", "audio/wav": "wav",
}


def matches_media(prefix, mime):
    if mime == "image/png":
        return prefix.startswith(b"\x89PNG\r\n\x1a\n")
    if mime == "image/jpeg":
        return prefix.startswith(b"\xff\xd8\xff")
    if mime in ("image/webp", "audio/wav"):
        kind = b"WEBP" if mime == "image/webp" else b"WAVE"
        return prefix.startswith(b"RIFF") and prefix[8:12] == kind
    return mime == "video/mp4" and prefix[4:8] == b"ftyp"


def file_digest(path):
    result = hashlib.sha256()
    with path.open("rb") as f:
        for piece in iter(lambda: f.read(BLOCK), b""):
            result.update(piece)
    return result.digest()


def byte_range(value, size):
    if value is None:
        return 0, size - 1
    match = re.fullmatch(r"bytes=(\d{0,19})-(\d{0,19})", value)
    if not match or not any(match.groups()):
        raise ValueError
    start, end = match.groups()
    if not start:
        if int(end) == 0:
            raise ValueError
        return max(0, size - int(end)), size - 1
    start = int(start)
    end = min(int(end), size - 1) if end else size - 1
    if start > end:
        raise ValueError
    return start, end


class Relay(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, root, token, max_file=128 << 20, quota=2 << 30, reserve=128 << 20):
        if len(token) < 32 or not re.fullmatch(r"[!-~]+", token):
            raise ValueError("MEDIA_RELAY_TOKEN must contain at least 32 printable ASCII characters")
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.key = token.encode("ascii")
        self.max_file, self.quota, self.reserve = max_file, quota, reserve
        self.writer = threading.Lock()
        self.slots = threading.BoundedSemaphore(32)
        self.next_cleanup = 0
        super().__init__(address, Handler)

    def process_request(self, sock, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(sock)
            return
        try:
            super().process_request(sock, address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, sock, address):
        try:
            super().process_request_thread(sock, address)
        finally:
            self.slots.release()

    def lookup(self, asset):
        for mime, ext in EXTENSIONS.items():
            path = self.root / (asset + "." + ext)
            if path.is_file():
                return path, mime
        return None, None

    def cleanup(self):
        cutoff = time.time() - DAY
        for file in self.root.iterdir():
            if (file.name.startswith(".part-") or re.fullmatch(UUID + r"\.(mp4|png|jpg|webp|wav)", file.name)):
                if file.is_file() and file.stat().st_mtime <= cutoff:
                    file.unlink()

    def service_actions(self):
        if time.monotonic() >= self.next_cleanup and self.writer.acquire(blocking=False):
            try:
                self.cleanup()
                self.next_cleanup = time.monotonic() + 60
            finally:
                self.writer.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "MediaRelay"
    sys_version = ""
    timeout = 45

    def log_message(self, *args):
        # The request URI contains a short-lived download signature.
        pass

    def reply(self, code, **headers):
        self.send_response(code)
        self.send_header("Cache-Control", "private, no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for name, value in headers.items():
            self.send_header(name.replace("_", "-"), str(value))
        if "Content_Length" not in headers:
            self.send_header("Content-Length", "0")
        self.end_headers()

    def do_PUT(self):
        route = re.fullmatch(r"/v1/assets/(" + UUID + ")", self.path)
        if not route:
            return self.reply(404)
        auth = self.headers.get("Authorization", "").encode("utf-8")
        if not hmac.compare_digest(auth, b"Bearer " + self.server.key):
            return self.reply(401)
        mime = self.headers.get_content_type()
        if mime not in EXTENSIONS:
            return self.reply(415)
        sizes = self.headers.get_all("Content-Length", [])
        if self.headers.get("Transfer-Encoding") or len(sizes) != 1 or not re.fullmatch(r"[0-9]{1,12}", sizes[0]):
            return self.reply(411)
        size = int(sizes[0])
        if not 0 < size <= self.server.max_file:
            return self.reply(413)
        try:
            with self.server.writer:
                status = self.save(route.group(1), mime, size)
        except TimeoutError:
            status = 408
        except OSError:
            status = 507
        self.reply(status)

    def save(self, asset, mime, size):
        srv = self.server
        srv.cleanup()
        old, old_mime = srv.lookup(asset)
        if old and (old_mime != mime or old.stat().st_size != size):
            return 409
        used = sum(f.stat().st_size for f in srv.root.iterdir() if f.is_file())
        if used + (0 if old else size) > srv.quota or shutil.disk_usage(srv.root).free - size < srv.reserve:
            return 507
        temp = None
        try:
            with tempfile.NamedTemporaryFile(dir=srv.root, prefix=".part-", delete=False) as f:
                temp = Path(f.name)
                remaining = size
                digest = hashlib.sha256()
                deadline = time.monotonic() + 600
                while remaining:
                    if time.monotonic() > deadline:
                        return 408
                    chunk = self.rfile.read(min(BLOCK, remaining))
                    if not chunk:
                        return 400
                    if remaining == size and not matches_media(chunk, mime):
                        return 415
                    f.write(chunk)
                    digest.update(chunk)
                    remaining -= len(chunk)
            if old:
                if not hmac.compare_digest(file_digest(old), digest.digest()):
                    return 409
                os.utime(old, None)
                return 204
            temp.replace(srv.root / (asset + "." + EXTENSIONS[mime]))
            return 201
        finally:
            if temp and temp.exists():
                temp.unlink()

    def do_GET(self):
        self.download(True)

    def do_HEAD(self):
        self.download(False)

    def download(self, send_body):
        if self.path == "/healthz":
            return self.reply(200)
        url = urlsplit(self.path)
        route = re.fullmatch(r"/media/(" + UUID + ")", url.path)
        if not route:
            return self.reply(404)
        asset = route.group(1)
        try:
            query = parse_qs(url.query, strict_parsing=True, keep_blank_values=True, max_num_fields=2)
            exp, = query["expires"]
            sig, = query["signature"]
        except (ValueError, KeyError):
            return self.reply(403)
        now = int(time.time())
        if not re.fullmatch(r"\d{1,12}", exp, re.ASCII) or not now < int(exp) <= now + DAY:
            return self.reply(403)
        mac = hmac.new(self.server.key, (asset + ":" + exp).encode("ascii"), hashlib.sha256).hexdigest()
        if not re.fullmatch(r"[0-9a-f]{64}", sig) or not hmac.compare_digest(mac, sig):
            return self.reply(403)
        path, mime = self.server.lookup(asset)
        if not path:
            return self.reply(404)
        try:
            f = path.open("rb")
        except FileNotFoundError:
            return self.reply(404)
        with f:
            info = os.fstat(f.fileno())
            if info.st_mtime <= time.time() - DAY:
                return self.reply(404)
            size = info.st_size
            wanted = self.headers.get("Range")
            try:
                start, end = byte_range(wanted, size)
            except ValueError:
                return self.reply(416, Content_Range="bytes */%d" % size)
            length = end - start + 1
            extra = {"Content_Range": "bytes %d-%d/%d" % (start, end, size)} if wanted else {}
            self.reply(206 if wanted else 200, Content_Type=mime, Content_Length=length,
                       Accept_Ranges="bytes", **extra)
            if send_body:
                f.seek(start)
                try:
                    while length:
                        chunk = f.read(min(length, BLOCK))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        length -= len(chunk)
                except (BrokenPipeError, ConnectionResetError, TimeoutError):
                    pass


if __name__ == "__main__":
    os.umask(0o077)
    with Relay(("127.0.0.1", int(os.environ.get("MEDIA_RELAY_PORT", "18789"))),
               os.environ.get("MEDIA_RELAY_DATA", "/var/lib/mooc-media-relay"),
               os.environ["MEDIA_RELAY_TOKEN"]) as server:
        server.serve_forever()

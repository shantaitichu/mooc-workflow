#!/usr/bin/env python3
"""Install the temporary media relay into one existing Nginx HTTPS virtual host."""

import argparse
import base64
import glob
import hashlib
import hmac
import http.client
import os
import re
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path


APP = Path("/opt/mooc-media-relay")
SNIPPET = APP / "mooc-media-relay.nginx.conf"
UNIT = "mooc-media-relay.service"
ENV = Path("/etc/mooc-media-relay.env")
UNIT_PATH = Path("/etc/systemd/system") / UNIT
PREFIX = "/mooc-media/"
HERE = Path(__file__).resolve().parent
BACKUPS = Path("/var/backups/mooc-media-relay")


def run(*cmd, check=True):
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and p.returncode:
        # Configuration dumps can contain secrets. Keep them out of console transcripts.
        raise RuntimeError("%s failed (exit %d)" % (" ".join(cmd), p.returncode))
    return p


def tokens(text):
    """Tokenize Nginx punctuation, skipping comments, quoted braces and escaped characters."""
    pos = 0
    while pos < len(text):
        c = text[pos]
        if c.isspace():
            pos += 1
        elif c == "#":
            end = text.find("\n", pos)
            pos = end if end >= 0 else len(text)
        elif c in "{};":
            yield c, pos, True
            pos += 1
        else:
            start = pos
            quote = None
            word = []
            while pos < len(text):
                c = text[pos]
                if c == "\\" and pos + 1 < len(text):
                    word.append(text[pos + 1])
                    pos += 2
                    continue
                if quote:
                    if c == quote:
                        quote = None
                    else:
                        word.append(c)
                elif c in "\"'":
                    quote = c
                elif c == "$" and text.startswith("${", pos):
                    end = text.find("}", pos + 2)
                    if end < 0:
                        raise ValueError("unsupported Nginx variable")
                    word.append(text[pos:end + 1])
                    pos = end + 1
                    continue
                elif c.isspace() or c in "{};":
                    break
                else:
                    word.append(c)
                pos += 1
            if quote:
                raise ValueError("unterminated Nginx value")
            yield "".join(word), start, False


def parse(text):
    # Each node stores its directive, any child directives, and the byte-independent closing brace offset.
    root = []
    stack = [(root, None)]
    words = []
    for word, pos, punctuation in tokens(text):
        if not punctuation:
            words.append(word)
        elif word == "{":
            node = [words, [], None]
            stack[-1][0].append(node)
            stack.append((node[1], node))
            words = []
        elif word == ";":
            stack[-1][0].append([words, None, None])
            words = []
        else:
            if words or len(stack) <= 1:
                raise ValueError("unsupported or unbalanced Nginx configuration")
            stack.pop()[1][2] = pos
    if words or len(stack) != 1:
        raise ValueError("incomplete Nginx configuration")
    return root


def unique_site(dump, host):
    paths = re.findall(r"^# configuration file ([^\r\n]+):\r?$", dump, re.M)
    if not paths or not all(Path(name).is_absolute() for name in paths):
        raise ValueError("nginx -T did not identify its active configuration")
    files = {Path(p).resolve(): Path(p).read_bytes().decode("utf-8") for p in paths}
    trees = {p: parse(text) for p, text in files.items()}
    base = Path(paths[0]).parent
    candidates = []

    def expand(nodes, file, chain):
        for n in nodes:
            if n[0][:1] == ["include"]:
                if len(n[0]) != 2:
                    raise ValueError("unsupported include")
                pattern = str(base / n[0][1])
                for match in sorted(glob.glob(pattern)):
                    path = Path(match).resolve()
                    if path in chain or path not in trees:
                        raise ValueError("unexpected active include: " + str(path))
                    # Keep the ownership boundary: inserting into the site belongs at the server closing brace.
                    yield from expand(trees[path], path, chain + [path])
            else:
                yield n, file, chain

    first = Path(paths[0]).resolve()
    for http, f, chain in expand(trees[first], first, [first]):
        if http[0] != ["http"] or http[1] is None:
            continue
        for server, owner, history in expand(http[1], f, chain):
            if server[0] != ["server"] or server[1] is None:
                continue
            directives = list(expand(server[1], owner, history))
            names = [x.casefold() for n, _, _ in directives if n[0][:1] == ["server_name"] for x in n[0][1:]]
            if host.casefold() not in names:
                if any(location_owner == SNIPPET.resolve() for _, location_owner, _ in directives):
                    raise ValueError("relay snippet is included by another host")
                continue
            listens = [n[0][1:] for n, _, _ in directives if n[0][:1] == ["listen"]]
            if not any(v and (v[0] == "443" or v[0].endswith(":443")) and "ssl" in v for v in listens):
                continue
            if set(names) != {host.casefold()}:
                raise ValueError("target HTTPS host shares its server block with other names")
            if any(v and not (v[0] == "443" or v[0].endswith(":443")) for v in listens):
                raise ValueError("target HTTPS server block also listens on other ports")
            installed = False
            for n, location_owner, _ in directives:
                if n[0][:1] != ["location"] or len(n[0]) < 2:
                    continue
                target = n[0][-1]
                if location_owner == SNIPPET.resolve() and n[0] == ["location", "^~", PREFIX]:
                    installed = True
                elif (target == PREFIX.rstrip("/") or target.startswith(PREFIX) or
                      (target.startswith("/") and target != "/" and PREFIX.startswith(target))):
                    raise ValueError("site already has an overlapping relay location")
            candidates.append((owner, files[owner], server[2], installed))
    if len(candidates) != 1:
        raise ValueError("expected one dedicated HTTPS server_name for %s, found %d" % (host, len(candidates)))
    return candidates[0]


def insert_site(text, end):
    line = text[text.rfind("\n", 0, end) + 1:end]
    indent = line if not line.strip() else ""
    newline = "\r\n" if "\r\n" in text else "\n"
    return text[:end] + newline + indent + "    include " + SNIPPET.as_posix() + ";" + newline + indent + text[end:]


def atomic_write(dest, data, mode, original=None):
    dest.parent.mkdir(parents=True, exist_ok=True)
    temp = None
    try:
        with tempfile.NamedTemporaryFile(dir=dest.parent, prefix=".mooc-write-", delete=False) as f:
            temp = Path(f.name)
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        if original and hasattr(os, "chown"):
            os.chown(temp, original.st_uid, original.st_gid)
        temp.chmod(mode)
        os.replace(temp, dest)
    finally:
        if temp and temp.exists():
            temp.unlink()


class Changes:
    def __init__(self):
        self.files = []

    def write(self, dest, data, mode=None):
        if dest.is_symlink():
            raise ValueError("unexpected symbolic link: " + str(dest))
        old = dest.read_bytes() if dest.exists() else None
        if old == data:
            return
        info = dest.stat() if old is not None else None
        atomic_write(dest, data, mode if mode is not None else info.st_mode & 0o7777, info)
        self.files.append((dest, old, info))

    def rollback(self):
        for dest, old, info in reversed(self.files):
            if old is None:
                if dest.exists():
                    dest.unlink()
            else:
                atomic_write(dest, old, info.st_mode & 0o7777, info)


def env_token(changes):
    if not ENV.exists():
        changes.write(ENV, ("MEDIA_RELAY_TOKEN=" + secrets.token_urlsafe(48) + "\n").encode(), 0o600)
    if ENV.is_symlink() or (os.name == "posix" and ENV.stat().st_mode & 0o077):
        raise ValueError("existing relay environment must be private (chmod 600)")
    values = re.findall(r"^MEDIA_RELAY_TOKEN=([!-~]{32,})[ \t]*$", ENV.read_text(), re.M)
    if len(values) != 1:
        raise ValueError("existing relay token is missing, invalid or duplicated")
    value = values[0]
    if value[:1] in ("\"", "'") and value.strip(value[0]) and value[-1] == value[0]:
        value = value[1:-1]
    if len(value) < 32:
        raise ValueError("existing relay token is too short")
    return value


def probe(host, token):
    # Validates certificate identity, prefix routing and file retrieval. Nginx may be bound to loopback by NAT.
    asset = str(uuid.uuid4())
    data = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/w8AAgMBAp0NC0kAAAAASUVORK5CYII=")
    exp = str(int(time.time()) + 120)
    signature = hmac.new(token.encode(), (asset + ":" + exp).encode(), hashlib.sha256).hexdigest()
    route = "media/" + asset + "?expires=" + exp + "&signature=" + signature
    upload_headers = {"Authorization": "Bearer " + token, "Content-Type": "image/png"}
    # Prove the HTTPS route serves this specific relay's signed bytes before sending its write credential.
    c = http.client.HTTPConnection("127.0.0.1", 18789, timeout=3)
    try:
        c.request("PUT", "/v1/assets/" + asset, body=data, headers=upload_headers)
        if c.getresponse().status != 201:
            raise RuntimeError("local relay rejected the self-check")
    finally:
        c.close()

    def request(method, suffix, body, headers, loopback):
        c = http.client.HTTPSConnection(host, 443, timeout=6)
        if loopback:
            c._create_connection = lambda addr, timeout, source: socket.create_connection(("127.0.0.1", 443), timeout, source)
        try:
            c.request(method, PREFIX + suffix, body=body, headers=headers)
            r = c.getresponse()
            return r.status, r.read(len(data) + 1)
        finally:
            c.close()

    for local in (True, False):
        try:
            if request("GET", route, None, {}, local) != (200, data):
                continue
            if request("PUT", "v1/assets/" + asset, data, upload_headers, local)[0] != 204:
                continue
            return
        except (OSError, http.client.HTTPException):
            pass
    raise RuntimeError("HTTPS self-check failed: verify certificate, SNI, routing and local relay status")


def check_local_relay():
    for _ in range(30):
        try:
            c = http.client.HTTPConnection("127.0.0.1", 18789, timeout=1)
            try:
                c.request("GET", "/healthz")
                if c.getresponse().status == 200:
                    return
            finally:
                c.close()
        except OSError:
            pass
        time.sleep(0.2)
    raise RuntimeError("local relay did not become healthy")


def install(host):
    run("nginx", "-t")
    site, text, end, installed = unique_site(run("nginx", "-T").stdout.decode("utf-8"), host)
    current_unit = run("systemctl", "show", "-p", "FragmentPath", "--value", UNIT, check=False).stdout.decode().strip()
    if current_unit and Path(current_unit) != UNIT_PATH:
        raise ValueError("a different systemd service already uses the unit name")
    if UNIT_PATH.exists() and b"/opt/mooc-media-relay/relay.py" not in UNIT_PATH.read_bytes():
        raise ValueError("existing service has a different executable")
    if APP.is_symlink() or (APP.exists() and any(APP.iterdir()) and not UNIT_PATH.exists()):
        raise ValueError("application directory already exists without the matching service")
    active = run("systemctl", "is-active", "--quiet", UNIT, check=False).returncode == 0
    enabled = run("systemctl", "is-enabled", "--quiet", UNIT, check=False).returncode == 0
    changes = Changes()
    restarted = reload_attempted = enable_attempted = False
    backup = None
    try:
        if not installed:
            folder = BACKUPS
            folder.mkdir(mode=0o700, exist_ok=True, parents=True)
            with tempfile.NamedTemporaryFile(prefix=site.name + ".", dir=folder, delete=False) as f:
                backup = Path(f.name)
                f.write(text.encode())
        token = env_token(changes)
        if not APP.exists():
            APP.mkdir(parents=True, mode=0o755)
            APP.chmod(0o755)
        changes.write(APP / "relay.py", (HERE / "relay.py").read_bytes(), 0o644)
        changes.write(SNIPPET, (HERE / SNIPPET.name).read_bytes(), 0o644)
        changes.write(UNIT_PATH, (HERE / UNIT).read_bytes(), 0o644)
        if not installed:
            if site.read_bytes() != text.encode():
                raise RuntimeError("site changed during installation")
            changes.write(site, insert_site(text, end).encode())
        run("nginx", "-t")
        _, _, _, now_installed = unique_site(run("nginx", "-T").stdout.decode("utf-8"), host)
        if not now_installed:
            raise RuntimeError("nginx did not load the dedicated relay snippet")
        run("systemctl", "daemon-reload")
        restarted = True
        run("systemctl", "restart", UNIT)
        check_local_relay()
        reload_attempted = True
        run("systemctl", "reload", "nginx")
        for attempt in range(3):
            try:
                probe(host, token)
                break
            except RuntimeError:
                if attempt == 2:
                    raise
                time.sleep(0.5)
        if not enabled:
            enable_attempted = True
            run("systemctl", "enable", UNIT)
    except BaseException:
        if enable_attempted:
            run("systemctl", "disable", UNIT, check=False)
        if restarted:
            run("systemctl", "stop", UNIT, check=False)
        changes.rollback()
        if restarted:
            run("systemctl", "daemon-reload")
            if active:
                run("systemctl", "start", UNIT)
        if reload_attempted:
            run("nginx", "-t")
            run("systemctl", "reload", "nginx")
        raise
    if backup:
        print("Site backup:", backup)
    print("HTTPS upload and signed download verified:", "https://" + host + PREFIX)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True, help="Existing dedicated HTTPS server_name (port 443)")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]{0,251}[A-Za-z0-9]", args.host):
        parser.error("use a bare hostname or IPv4 address")
    if not hasattr(os, "geteuid") or os.geteuid() != 0:
        parser.error("run on the target Linux server as root")
    try:
        import fcntl
        with open("/run/mooc-media-relay-install.lock", "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            install(args.host)
    except (OSError, ValueError, RuntimeError) as e:
        sys.exit("Installation failed: " + str(e))

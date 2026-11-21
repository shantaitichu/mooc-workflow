import io
import subprocess
import tempfile
import unittest
from contextlib import ExitStack, redirect_stdout
from pathlib import Path
from unittest.mock import patch

import install


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.dir = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.host = "198.51.100.9"
        self.main = self.dir / "nginx.conf"
        self.site = self.dir / "sites" / "ip.conf"
        self.site.parent.mkdir()
        self.main.write_text("events {} http { include sites/*.conf; }")
        self.site.write_text("""server { listen 443 ssl; server_name example.test; location / { return 404; } }
# Existing braces, comments and quoted directives must survive insertion.
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name 198.51.100.9;
    location / { add_header X-Test "} a; b"; return 200; }
}
""")
        self.old_site = self.site.read_bytes()
        app = self.dir / "opt" / "mooc-media-relay"
        self.stack.enter_context(patch.multiple(
            install, APP=app, SNIPPET=app / "mooc-media-relay.nginx.conf",
            UNIT_PATH=self.dir / "system" / install.UNIT, ENV=self.dir / "env",
            BACKUPS=self.dir / "backup",
        ))
        self.calls = []
        self.failure = None
        self.stack.enter_context(patch.object(install, "run", side_effect=self.run_cmd))
        self.stack.enter_context(patch.object(install, "check_local_relay"))
        self.stack.enter_context(patch.object(install.time, "sleep"))
        self.check = self.stack.enter_context(patch.object(install, "probe"))

    def dump(self):
        files = [self.main, self.site]
        if install.SNIPPET.exists():
            files.append(install.SNIPPET)
        return "".join("# configuration file %s:\n%s\n" % (f.as_posix(), f.read_text()) for f in files)

    def run_cmd(self, *args, check=True):
        self.calls.append(args)
        if args == self.failure and (args != ("nginx", "-t") or len(self.calls) > 1):
            self.failure = None
            raise RuntimeError("test failure")
        out = self.dump().encode() if args == ("nginx", "-T") else b""
        return subprocess.CompletedProcess(args, int("is-enabled" in args or "is-active" in args), out, b"")

    def test_unique_target_and_idempotent_install(self):
        with redirect_stdout(io.StringIO()) as report:
            install.install(self.host)
            saved = self.site.read_bytes()
            saved_env = install.ENV.read_bytes()
            install.install(self.host)
        self.assertNotIn(saved_env.decode().split("=")[1].strip(), report.getvalue())
        self.assertEqual(self.site.read_bytes(), saved)
        self.assertEqual(install.ENV.read_bytes(), saved_env)
        self.assertEqual(saved.count(install.SNIPPET.as_posix().encode()), 1)
        self.assertTrue(saved.startswith(self.old_site.split(b"server_name 198.51.100.9")[0]))
        self.assertEqual(next(install.BACKUPS.iterdir()).read_bytes(), self.old_site)
        self.assertEqual(self.check.call_count, 2)

    def test_reject_aliases_duplicates_and_existing_route(self):
        for original, replacement in (
                ("server_name 198.51.100.9;", "server_name 198.51.100.9 alias.test;"),
                ("server_name example.test;", "server_name 198.51.100.9;"),
                ("server_name 198.51.100.9;", "server_name 198.51.100.9; location /mooc-media/x {return 404;}")):
            with self.subTest(replacement=replacement):
                content = self.old_site.decode().replace(original, replacement)
                self.site.write_bytes(content.encode())
                with self.assertRaises(ValueError):
                    install.install(self.host)
                self.assertEqual(self.site.read_bytes(), content.encode())
                self.assertFalse(install.ENV.exists())

    def test_validation_failure_restores_original_files(self):
        self.failure = ("nginx", "-t")
        with self.assertRaises(RuntimeError):
            install.install(self.host)
        self.assertEqual(self.site.read_bytes(), self.old_site)
        self.assertFalse(install.ENV.exists())
        self.assertFalse(install.SNIPPET.exists())
        self.assertNotIn(("systemctl", "reload", "nginx"), self.calls)

    def test_reload_or_self_check_failure_restores_and_reloads_old_site(self):
        for failed in ("reload", "probe"):
            with self.subTest(failed=failed):
                self.calls.clear()
                self.failure = ("systemctl", "reload", "nginx") if failed == "reload" else None
                self.check.side_effect = RuntimeError("bad response") if failed == "probe" else None
                with self.assertRaises(RuntimeError):
                    install.install(self.host)
                self.assertEqual(self.site.read_bytes(), self.old_site)
                self.assertEqual(self.calls[-1], ("systemctl", "reload", "nginx"))
                self.assertFalse(install.UNIT_PATH.exists())
                self.assertFalse(install.ENV.exists())


if __name__ == "__main__":
    unittest.main()

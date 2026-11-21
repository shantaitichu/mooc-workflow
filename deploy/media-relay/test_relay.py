import hashlib
import hmac
import http.client
import os
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path

from relay import DAY, Relay


class RelayTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.token = "x" * 40
        self.srv = Relay(("127.0.0.1", 0), self.root, self.token, max_file=1024, quota=1024, reserve=0)
        self.thread = threading.Thread(target=self.srv.serve_forever, kwargs={"poll_interval": 0.01})
        self.thread.start()
        self.asset = str(uuid.uuid4())
        self.input = b"\x89PNG\r\n\x1a\n" + bytes(range(60))
        self.upload = "/v1/assets/" + self.asset
        self.headers = {"Authorization": "Bearer " + self.token, "Content-Type": "image/png"}

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def request(self, method, route, body=None, headers=None):
        conn = http.client.HTTPConnection(*self.srv.server_address, timeout=2)
        try:
            conn.request(method, route, body=body, headers=headers or {})
            response = conn.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            conn.close()

    def url(self, offset=300):
        exp = str(int(time.time()) + offset)
        mac = hmac.new(self.token.encode(), (self.asset + ":" + exp).encode(), hashlib.sha256).hexdigest()
        return "/media/" + self.asset + "?expires=" + exp + "&signature=" + mac

    def test_upload_fetch_and_resume(self):
        self.assertEqual(self.request("PUT", self.upload, self.input, self.headers)[0], 201)
        self.assertEqual(self.request("PUT", self.upload, self.input, self.headers)[0], 204)
        self.assertEqual(self.request("PUT", self.upload, self.input[:-1] + b"x", self.headers)[0], 409)
        url = self.url()
        status, headers, body = self.request("HEAD", url)
        self.assertEqual((status, headers["Content-Type"], headers["Content-Length"], body),
                         (200, "image/png", str(len(self.input)), b""))
        self.assertEqual(self.request("GET", url)[2], self.input)
        status, headers, body = self.request("GET", url, headers={"Range": "bytes=13-19"})
        self.assertEqual((status, headers["Content-Range"], body), (206, "bytes 13-19/68", self.input[13:20]))
        self.assertEqual(self.request("GET", url, headers={"Range": "bytes=-5"})[2], self.input[-5:])
        self.assertEqual(self.request("GET", url, headers={"Range": "bytes=0-"})[2], self.input)
        self.assertEqual(self.request("GET", url, headers={"Range": "bytes=80-"})[0], 416)

    def test_access_checks_and_expiry(self):
        self.assertEqual(self.request("PUT", self.upload, self.input)[0], 401)
        self.assertEqual(self.request("PUT", self.upload, b"<html>test</html>", self.headers)[0], 415)
        self.assertEqual(self.request("PUT", self.upload, self.input * 20, self.headers)[0], 413)
        self.assertEqual(self.request("PUT", self.upload, self.input, self.headers)[0], 201)
        self.assertEqual(self.request("GET", "/media/" + self.asset)[0], 403)
        self.assertEqual(self.request("GET", self.url(-5))[0], 403)
        self.assertEqual(self.request("GET", self.url(DAY + 60))[0], 403)
        self.assertEqual(self.request("GET", self.url().replace(self.asset, str(uuid.uuid4())))[0], 403)
        self.assertEqual(self.request("GET", self.url() + "&expires=9999999999")[0], 403)
        self.assertEqual(self.request("GET", "/media/../relay.py")[0], 404)
        self.assertEqual(self.request("GET", "/healthz")[0], 200)
        stored = next(self.root.iterdir())
        stale = time.time() - DAY - 1
        os.utime(stored, (stale, stale))
        self.assertEqual(self.request("GET", self.url())[0], 404)
        with self.srv.writer:
            self.srv.cleanup()
        self.assertFalse(stored.exists())

    def test_interrupted_put_and_quota(self):
        conn = http.client.HTTPConnection(*self.srv.server_address, timeout=2)
        try:
            conn.request("PUT", self.upload, body=self.input[:20], headers={**self.headers, "Content-Length": "512"})
            conn.sock.shutdown(1)
            self.assertEqual(conn.getresponse().status, 400)
        finally:
            conn.close()
        self.assertEqual(list(self.root.iterdir()), [])
        self.srv.quota = len(self.input)
        self.assertEqual(self.request("PUT", self.upload, self.input, self.headers)[0], 201)
        self.assertEqual(self.request("PUT", "/v1/assets/" + str(uuid.uuid4()), self.input, self.headers)[0], 507)
        self.assertEqual(self.request("GET", self.url())[2], self.input)


if __name__ == "__main__":
    unittest.main()

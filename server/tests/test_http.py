"""The real HTTP server: CORS, static data/, --static site, persistence, --reset."""

from __future__ import annotations

import gzip
import http.client
import json
import os
import shutil
import tempfile
import unittest
from urllib.parse import urlsplit

from server import local_server
from server.core.app import set_app
from server.core.config import Config
from server.seed import SEED_VERSION
from server.tests.contract import make_app


class HttpServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.data_root = os.path.join(cls.tmp, "data")
        cls.site = os.path.join(cls.tmp, "site")
        os.makedirs(os.path.join(cls.data_root, "translations"))
        os.makedirs(cls.site)
        with open(os.path.join(cls.data_root, "catalog.json"), "w") as fh:
            json.dump({"format": "html-bible/catalog"}, fh)
        cls.gz = gzip.compress(b'{"id":"en-kjv"}')
        with open(os.path.join(cls.data_root, "translations", "en-kjv.json.gz"), "wb") as fh:
            fh.write(cls.gz)
        with open(os.path.join(cls.site, "index.html"), "w") as fh:
            fh.write("<!doctype html><title>site</title>")
        cls.app = make_app()
        cls.server = local_server.make_server(cls.app, "127.0.0.1", 0, cls.data_root, cls.site, quiet=True)
        _, cls.base = local_server.start_in_thread(cls.server)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.app.shutdown()
        set_app(None)
        shutil.rmtree(cls.tmp)

    def request(self, method, path, headers=None, body=None):
        parts = urlsplit(self.base)
        conn = http.client.HTTPConnection(parts.hostname, parts.port, timeout=5)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            response = conn.getresponse()
            return response.status, {k.lower(): v for k, v in response.getheaders()}, response.read()
        finally:
            conn.close()

    def test_health_over_http(self):
        status, headers, body = self.request("GET", "/v1/health", {"Origin": "http://localhost:5173"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["ok"], True)
        self.assertEqual(headers["access-control-allow-origin"], "http://localhost:5173")
        self.assertEqual(headers["content-type"], "application/json; charset=utf-8")

    def test_cors_preflight(self):
        for origin in ("http://localhost:5173", "http://127.0.0.1:8787", "https://bible.marketkernel.com", "null"):
            status, headers, _ = self.request("OPTIONS", "/v1/votes/verse/x", {
                "Origin": origin,
                "Access-Control-Request-Method": "PUT",
                "Access-Control-Request-Headers": "authorization, content-type",
            })
            self.assertEqual(status, 204, origin)
            self.assertEqual(headers["access-control-allow-origin"], origin)
            for method in ("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"):
                self.assertIn(method, headers["access-control-allow-methods"])
            self.assertIn("Authorization", headers["access-control-allow-headers"])
            self.assertIn("Content-Type", headers["access-control-allow-headers"])

    def test_cors_refuses_other_origins(self):
        status, headers, _ = self.request("OPTIONS", "/v1/questions", {
            "Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
        self.assertEqual(status, 204)
        self.assertNotIn("access-control-allow-origin", headers)
        status, headers, _ = self.request("GET", "/v1/health", {"Origin": "https://evil.example"})
        self.assertNotIn("access-control-allow-origin", headers)

    def test_private_network_preflight(self):
        _, headers, _ = self.request("OPTIONS", "/v1/health", {
            "Origin": "https://bible.marketkernel.com", "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Private-Network": "true"})
        self.assertEqual(headers.get("access-control-allow-private-network"), "true")

    def test_api_write_over_http(self):
        from server.tests.contract import seed_token
        token = seed_token(self.app, "elena")
        status, headers, body = self.request(
            "POST", "/v1/questions",
            {"Authorization": f"Bearer {token}", "Content-Type": "application/json", "Origin": "null"},
            json.dumps({"lang": "ru", "title": "Вопрос"}).encode("utf-8"))
        self.assertEqual(status, 201, body)
        self.assertTrue(headers["location"].startswith("/v1/questions/"))
        self.assertEqual(json.loads(body)["title"]["ru"], "Вопрос")

    def test_static_data(self):
        status, headers, body = self.request("GET", "/data/catalog.json", {"Origin": "null"})
        self.assertEqual((status, headers["content-type"]), (200, "application/json; charset=utf-8"))
        self.assertEqual(headers["access-control-allow-origin"], "null")
        status, headers, body = self.request("GET", "/data/translations/en-kjv.json.gz")
        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "application/gzip")
        self.assertNotIn("content-encoding", headers)
        self.assertEqual(body, self.gz)
        self.assertEqual(self.request("GET", "/data/../../etc/passwd")[0], 404)
        self.assertEqual(self.request("GET", "/data/%2e%2e/%2e%2e/etc/passwd")[0], 404)
        self.assertEqual(self.request("GET", "/data/missing.json")[0], 404)

    def test_static_site_and_oauth_return(self):
        status, headers, body = self.request("GET", "/?code=abc&state=xyz")
        self.assertEqual((status, headers["content-type"]), (200, "text/html; charset=utf-8"))
        self.assertIn(b"site", body)

    def test_auth_page_over_http(self):
        status, headers, body = self.request(
            "GET", "/oauth2/authorize?response_type=code&client_id=c&redirect_uri=http%3A%2F%2Flocalhost%3A8787%2F"
                   "&state=s&code_challenge=abc&code_challenge_method=S256&identity_provider=Google")
        self.assertEqual(status, 200)
        self.assertIn(b"DEVELOPMENT STUB", body)


class PersistenceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        set_app(None)
        shutil.rmtree(self.tmp)

    def test_import_has_no_side_effects(self):
        # local_server was imported above; nothing may have been created or started.
        self.assertFalse(hasattr(local_server, "app"))
        config = Config(data_dir=os.path.join(self.tmp, "store"), kjv_counts_path=None)
        self.assertFalse(os.path.exists(config.data_dir))

    def test_store_survives_restart_and_reset_reseeds(self):
        config = Config(data_dir=os.path.join(self.tmp, "store"), kjv_counts_path=None)
        app = local_server.build_app(config)
        self.assertTrue(os.path.exists(os.path.join(config.data_dir, "verses.json")))
        verse = dict(app.store.get("verses", "01JAS000000000000000000V01"), id="EXTRA")
        app.store.put("verses", verse)
        app.shutdown()
        again = local_server.build_app(config)                 # not reseeded, extra verse kept
        self.assertIsNotNone(again.store.get("verses", "EXTRA"))
        again.shutdown()
        fresh = local_server.build_app(config, reset=True)     # --reset
        self.assertIsNone(fresh.store.get("verses", "EXTRA"))
        self.assertEqual(len(fresh.store.scan("verses")), 17)
        fresh.shutdown()
        # A store written by an older seed version (older data model) is replaced.
        fresh.store.put("meta", {"id": "seed", "version": 1})
        upgraded = local_server.build_app(config)
        self.assertIsNone(upgraded.store.get("verses", "EXTRA"))
        self.assertEqual(upgraded.store.get("meta", "seed")["version"], SEED_VERSION)
        upgraded.shutdown()


if __name__ == "__main__":
    unittest.main()

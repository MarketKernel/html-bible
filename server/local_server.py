"""Local stand-in for API Gateway + Cognito + the static site.

    python3 server/local_server.py --port 8787 [--latency MS] [--eval-delay S]
        [--token-ttl S] [--reset] [--static DIR]

Serves the API (/v1/…), the Cognito imitation (/oauth2/…, /logout), the
repo's data/ at /data/ and, with --static, a built site at /. CORS is applied
to every response. Importing this module starts nothing.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import posixpath
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Dict, Optional, Tuple
from urllib.parse import unquote, urlsplit

if __package__ in (None, ""):
    # Run as a script: make "server" importable from the repo root.
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import VERSION, gateway  # noqa: E402
from server.core.app import App, set_app  # noqa: E402
from server.core.config import DEFAULT_DATA_DIR, REPO_DIR, Config  # noqa: E402

MAX_BODY = 1024 * 1024
CORS_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
CORS_HEADERS = "Authorization, Content-Type"

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    ".map": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    # Served as the bytes they are: the client unpacks with DecompressionStream,
    # so no Content-Encoding (the browser must not unpack it on the way).
    ".gz": "application/gzip",
}


def content_type(path: str) -> str:
    return CONTENT_TYPES.get(os.path.splitext(path)[1].lower(), "application/octet-stream")


def safe_join(root: str, url_path: str) -> Optional[str]:
    """Map a URL path into root, refusing anything that escapes it."""
    clean = posixpath.normpath(unquote(url_path)).lstrip("/")
    if clean.startswith("..") or "\x00" in clean:
        return None
    full = os.path.realpath(os.path.join(root, clean))
    real_root = os.path.realpath(root)
    if full != real_root and not full.startswith(real_root + os.sep):
        return None
    return full


class StubServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, app: App, data_root: Optional[str], static_dir: Optional[str],
                 latency_ms: int = 0, quiet: bool = False):
        super().__init__(address, RequestHandler)
        self.app = app
        self.data_root = data_root
        self.static_dir = static_dir
        self.latency_ms = latency_ms
        self.quiet = quiet


class RequestHandler(BaseHTTPRequestHandler):
    server: StubServer
    server_version = f"html-bible-stub/{VERSION}"
    protocol_version = "HTTP/1.1"

    def do_GET(self): self._handle()
    def do_POST(self): self._handle()
    def do_PUT(self): self._handle()
    def do_PATCH(self): self._handle()
    def do_DELETE(self): self._handle()
    def do_OPTIONS(self): self._handle()
    def do_HEAD(self): self._handle()

    def log_message(self, fmt, *args):
        if not self.server.quiet:
            sys.stderr.write(f"[{self.log_date_time_string()}] {fmt % args}\n")

    # --- plumbing ---

    def _send(self, status: int, headers: Dict[str, str], body: bytes) -> None:
        self.send_response(status)
        origin = self.headers.get("Origin")
        cors = self._cors_headers(origin)
        merged = dict(headers)
        merged.update(cors)
        merged["Content-Length"] = str(len(body))
        for key, value in merged.items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _cors_headers(self, origin: Optional[str]) -> Dict[str, str]:
        headers = {"Vary": "Origin"}
        if origin and self.server.app.config.origin_allowed(origin):
            headers["Access-Control-Allow-Origin"] = origin
            headers["Access-Control-Expose-Headers"] = "Location"
        return headers

    def _read_body(self) -> Optional[bytes]:
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            return None
        return self.rfile.read(length) if length else b""

    def _json(self, status: int, body: dict) -> None:
        self._send(status, {"Content-Type": "application/json; charset=utf-8"},
                   json.dumps(body, ensure_ascii=False).encode("utf-8"))

    # --- dispatch ---

    def _handle(self) -> None:
        try:
            self._dispatch()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _dispatch(self) -> None:
        parts = urlsplit(self.path)
        path = parts.path or "/"
        if self.command == "OPTIONS":
            return self._preflight()
        body = self._read_body()
        if body is None:
            self.close_connection = True
            return self._json(413, {"error": {"code": "payload_too_large", "message": "Body over 1 MB"}})
        if gateway.owns(path):
            if self.server.latency_ms:
                time.sleep(self.server.latency_ms / 1000)
            method = "GET" if self.command == "HEAD" else self.command
            response = gateway.handle(
                self.server.app, method, path, parts.query, dict(self.headers.items()), body,
                self.client_address[0],
            )
            return self._send_v2(response)
        if path.startswith("/data/") and self.server.data_root:
            return self._static(self.server.data_root, path[len("/data"):])
        if self.server.static_dir:
            return self._static(self.server.static_dir, path)
        if path == "/":
            return self._index()
        return self._json(404, {"error": {"code": "not_found", "message": "Not found"}})

    def _send_v2(self, response: dict) -> None:
        body = response.get("body") or ""
        if response.get("isBase64Encoded"):
            data = base64.b64decode(body)
        else:
            data = body.encode("utf-8")
        self._send(response.get("statusCode", 200), response.get("headers") or {}, data)

    def _preflight(self) -> None:
        origin = self.headers.get("Origin")
        headers = {}
        if origin and self.server.app.config.origin_allowed(origin):
            headers = {
                "Access-Control-Allow-Methods": CORS_METHODS,
                "Access-Control-Allow-Headers": CORS_HEADERS,
                "Access-Control-Max-Age": "600",
            }
            # Chrome's Private Network Access: the public site calling localhost.
            if self.headers.get("Access-Control-Request-Private-Network") == "true":
                headers["Access-Control-Allow-Private-Network"] = "true"
        self._send(204, headers, b"")

    def _static(self, root: str, url_path: str) -> None:
        if self.command not in ("GET", "HEAD"):
            return self._json(405, {"error": {"code": "method_not_allowed", "message": "Static files are read-only"}})
        full = safe_join(root, url_path)
        if full and os.path.isdir(full):
            full = os.path.join(full, "index.html")
        if not full or not os.path.isfile(full):
            return self._json(404, {"error": {"code": "not_found", "message": "No such file"}})
        with open(full, "rb") as fh:
            data = fh.read()
        self._send(200, {"Content-Type": content_type(full), "Cache-Control": "no-cache"}, data)

    def _index(self) -> None:
        page = (
            "<!doctype html><meta charset='utf-8'><title>html-bible stub</title>"
            "<body style='font:16px system-ui;padding:16px'>"
            f"<h1>html-bible server stub {VERSION}</h1><ul>"
            "<li><a href='/v1/health'>/v1/health</a></li>"
            "<li><a href='/v1/questions'>/v1/questions</a></li>"
            "<li><a href='/data/'>/data/</a> (static)</li>"
            "<li>/oauth2/authorize, /oauth2/token, /logout (Cognito imitation)</li>"
            "</ul><p>Start with --static build/pages to serve the site here.</p>"
        )
        self._send(200, {"Content-Type": "text/html; charset=utf-8"}, page.encode("utf-8"))


def build_app(config: Config, reset: bool = False) -> App:
    """The app with its store; seeds an empty store (first run), a store from an
    older seed version (older data model) or after --reset."""
    from server.seed import load_seed, seeded

    app = App(config)
    if reset or not seeded(app):
        app.store.clear()
        load_seed(app)
    return app


def make_server(app: App, host: str = "127.0.0.1", port: int = 8787, data_root: Optional[str] = None,
                static_dir: Optional[str] = None, latency_ms: int = 0, quiet: bool = False) -> StubServer:
    set_app(app)
    return StubServer((host, port), app, data_root, static_dir, latency_ms, quiet)


def start_in_thread(server: StubServer) -> Tuple[threading.Thread, str]:
    """For tests: serve in the background; returns the thread and the base URL."""
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address[:2]
    return thread, f"http://{host}:{port}"


def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="html-bible API, auth and static stub")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--latency", type=int, default=0, metavar="MS", help="delay every API/auth response")
    parser.add_argument("--eval-delay", type=float, default=0.0, metavar="S",
                        help="finish AI re-evaluation S seconds later (0 = in the request)")
    parser.add_argument("--token-ttl", type=int, default=3600, metavar="S", help="access/ID token lifetime")
    parser.add_argument("--reset", action="store_true", help="wipe the data dir and load the seed again")
    parser.add_argument("--static", metavar="DIR", help="serve DIR at / (e.g. build/pages)")
    parser.add_argument("--data-root", default=os.path.join(REPO_DIR, "data"), metavar="DIR",
                        help="served at /data/ (default: the repo's data/)")
    parser.add_argument("--data-dir", default=DEFAULT_DATA_DIR, metavar="DIR", help="where the JSON store lives")
    parser.add_argument("--issuer", help="token iss (default http://localhost:PORT)")
    parser.add_argument("--allow-origin", action="append", default=[], metavar="ORIGIN",
                        help="extra CORS / redirect origin (repeatable)")
    parser.add_argument("--quiet", action="store_true")
    return parser.parse_args(argv)


def main(argv=None) -> None:
    args = parse_args(argv)
    config = Config(
        data_dir=args.data_dir,
        eval_delay=args.eval_delay,
        token_ttl=args.token_ttl,
        issuer=args.issuer or f"http://localhost:{args.port}",
        extra_origins=args.allow_origin,
    )
    app = build_app(config, reset=args.reset)
    static_dir = os.path.abspath(args.static) if args.static else None
    server = make_server(app, args.host, args.port, os.path.abspath(args.data_root), static_dir,
                         args.latency, args.quiet)
    print(f"html-bible stub {VERSION} on http://{args.host}:{args.port}/  (API /v1/, auth /oauth2/, data /data/"
          f"{', site /' if static_dir else ''})", flush=True)
    print(f"  eval-delay {args.eval_delay}s, token-ttl {args.token_ttl}s, latency {args.latency}ms, "
          f"store {args.data_dir}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        app.shutdown()


if __name__ == "__main__":
    main()

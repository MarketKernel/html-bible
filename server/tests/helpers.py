"""Shared test helpers: an in-process client over the gateway."""

from __future__ import annotations

import json
from typing import Optional, Tuple
from urllib.parse import urlencode

from server import gateway
from server.core.app import App, set_app
from server.tests.contract import FixedClock, make_app, seed_token

Q1 = "01JAS000000000000000000Q01"
A1, A2, A3 = (f"01JAS000000000000000000A0{n}" for n in (1, 2, 3))


def V(n: int) -> str:
    return f"01JAS000000000000000000V{n:02d}"


def T(n: int) -> str:
    return f"01JAS000000000000000000T{n:02d}"


class Client:
    def __init__(self, app: App):
        self.app = app

    def call(self, method: str, path: str, who: Optional[str] = None, body=None, token: Optional[str] = None,
             form: Optional[dict] = None, headers: Optional[dict] = None) -> Tuple[int, object]:
        status, _, data = self.raw(method, path, who, body, token, form, headers)
        return status, data

    def raw(self, method, path, who=None, body=None, token=None, form=None, headers=None):
        path, _, query = path.partition("?")
        headers = dict(headers or {})
        if who:
            token = seed_token(self.app, who)
        if token:
            headers["Authorization"] = f"Bearer {token}"
        payload = b""
        if body is not None:
            payload = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        elif form is not None:
            payload = urlencode(form).encode("ascii")
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        response = gateway.handle(self.app, method, path, query, headers, payload)
        text = response.get("body") or ""
        out_headers = response.get("headers") or {}
        data = json.loads(text) if text and out_headers.get("Content-Type", "").startswith("application/json") else text
        return response["statusCode"], out_headers, data


def new_client(**kwargs) -> Client:
    return Client(make_app(**kwargs))


def teardown(client: Client) -> None:
    client.app.shutdown()
    set_app(None)


__all__ = ["Client", "FixedClock", "new_client", "teardown", "Q1", "A1", "A2", "A3", "V", "T"]

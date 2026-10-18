"""Contract fixtures (tests/fixtures/api/*.json): run them against the stub and compare.

Each fixture starts from a fresh, seeded, in-memory server whose clock stands
at FIXTURE_NOW, then runs its steps in order. Expected bodies may contain
placeholders for values a real server makes up (see PLACEHOLDERS); everything
else must match exactly, including the set of keys.

    python3 -m server.tests.contract            # check all fixtures
    python3 -m server.tests.contract --write    # refill the "response" parts from the stub
                                                # (review the diff: this is the contract!)
"""

from __future__ import annotations

import glob
import json
import os
import re
import sys
from typing import Dict, List, Optional, Tuple
from urllib.parse import urlencode

from server import gateway
from server.auth_stub.tokens import access_token_for
from server.core.app import App
from server.core.config import REPO_DIR, Config
from server.core.ids import ULID_RE, parse_iso
from server.seed import load_seed, read_seed, seed_user_ids
from server.storage.json_store import JsonStore

FIXTURE_DIR = os.path.join(REPO_DIR, "tests", "fixtures", "api")
FIXTURE_NOW_ISO = "2026-10-18T12:00:00.000Z"
FIXTURE_NOW = parse_iso(FIXTURE_NOW_ISO)

ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
JWT_RE = re.compile(r"^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$")
TOKEN_REF_RE = re.compile(r"<jwt:(\w+)>")

PLACEHOLDERS = {
    "<ulid>": lambda v: isinstance(v, str) and bool(ULID_RE.match(v)),
    "<iso8601>": lambda v: isinstance(v, str) and bool(ISO_RE.match(v)),
    "<sha256>": lambda v: isinstance(v, str) and bool(SHA_RE.match(v)),
    "<jwt>": lambda v: isinstance(v, str) and bool(JWT_RE.match(v)),
    "<string>": lambda v: isinstance(v, str),
    "<number>": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
}


class FixedClock:
    def __init__(self, now: float = FIXTURE_NOW):
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def make_app(eval_delay: float = 0.0, token_ttl: int = 3600, clock=None, counts_path: Optional[str] = None,
             seed: bool = True) -> App:
    config = Config(data_dir=None, eval_delay=eval_delay, token_ttl=token_ttl, kjv_counts_path=counts_path)
    app = App(config, store=JsonStore(None), clock=clock or FixedClock())
    if seed:
        load_seed(app)
    return app


def seed_token(app: App, key: str) -> str:
    data = read_seed()
    user = next(u for u in data["users"] if u["key"] == key)
    return access_token_for(app, seed_user_ids(data)[key], user["displayName"], user["provider"])


def _request_parts(app: App, request: dict, saved: Dict[str, str]) -> Tuple[str, str, str, Dict[str, str], bytes]:
    path, _, query = re.sub(r"\{(\w+)\}", lambda m: saved.get(m.group(1), m.group(0)), request["path"]).partition("?")
    headers = {k: TOKEN_REF_RE.sub(lambda m: seed_token(app, m.group(1)), v)
               for k, v in (request.get("headers") or {}).items()}
    body = b""
    if "body" in request:
        body = json.dumps(request["body"], ensure_ascii=False).encode("utf-8")
        headers.setdefault("Content-Type", "application/json")
    elif "form" in request:
        body = urlencode(request["form"]).encode("ascii")
        headers.setdefault("Content-Type", "application/x-www-form-urlencoded")
    return request["method"], path, query, headers, body


def run_fixture(fixture: dict) -> List[Tuple[int, Dict[str, str], object]]:
    server = fixture.get("server") or {}
    app = make_app(eval_delay=server.get("evalDelay", 0))
    try:
        results = []
        saved: Dict[str, str] = {}
        for step in fixture["steps"]:
            method, path, query, headers, body = _request_parts(app, step["request"], saved)
            response = gateway.handle(app, method, path, query, headers, body)
            text = response.get("body") or ""
            content_type = (response.get("headers") or {}).get("Content-Type", "")
            parsed = json.loads(text) if text and content_type.startswith("application/json") else text
            results.append((response["statusCode"], response.get("headers") or {}, parsed))
            for name, key in (step.get("save") or {}).items():  # e.g. {"newVerse": "id"} → "{newVerse}" in later paths
                if isinstance(parsed, dict) and key in parsed:
                    saved[name] = parsed[key]
        return results
    finally:
        app.shutdown()


def compare(expected, actual, path: str = "$") -> List[str]:
    if isinstance(expected, str) and expected in PLACEHOLDERS:
        return [] if PLACEHOLDERS[expected](actual) else [f"{path}: {actual!r} is not {expected}"]
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return [f"{path}: expected an object, got {actual!r}"]
        problems = []
        for key in sorted(set(expected) | set(actual)):
            if key not in actual:
                problems.append(f"{path}.{key}: missing")
            elif key not in expected:
                problems.append(f"{path}.{key}: unexpected key")
            else:
                problems += compare(expected[key], actual[key], f"{path}.{key}")
        return problems
    if isinstance(expected, list):
        if not isinstance(actual, list) or len(expected) != len(actual):
            return [f"{path}: expected a list of {len(expected)}, got {actual!r}"[:300]]
        problems = []
        for index, (e, a) in enumerate(zip(expected, actual)):
            problems += compare(e, a, f"{path}[{index}]")
        return problems
    if type(expected) != type(actual) or expected != actual:  # 1 vs 1.0 vs True all differ in JSON
        return [f"{path}: expected {expected!r}, got {actual!r}"]
    return []


def check_fixture(fixture: dict) -> List[str]:
    problems = []
    for index, ((status, headers, body), step) in enumerate(zip(run_fixture(fixture), fixture["steps"])):
        expected = step["response"]
        where = f"step {index + 1}"
        if status != expected["status"]:
            problems.append(f"{where}: status {status}, expected {expected['status']} ({body})")
            continue
        for name, value in (expected.get("headers") or {}).items():
            problems += compare(value, headers.get(name), f"{where} header {name}")
        problems += [f"{where} {p}" for p in compare(expected.get("body"), body)]
    return problems


def load_fixtures() -> Dict[str, dict]:
    fixtures = {}
    for path in sorted(glob.glob(os.path.join(FIXTURE_DIR, "*.json"))):
        with open(path, "r", encoding="utf-8") as fh:
            fixtures[os.path.basename(path)] = json.load(fh)
    return fixtures


# --- regeneration -----------------------------------------------------------

def _seed_values() -> Tuple[set, set]:
    app = make_app()
    ids, hashes = set(), set()
    for table in ("questions", "arguments", "verses", "interpretations"):
        ids.update(item["id"] for item in app.store.scan(table))
    for item in app.store.scan("verdicts"):
        hashes.add(item["verdict"]["inputHash"])
    return ids, hashes


def generalize(value, seed_ids: set, seed_hashes: set):
    """Replace what a real server would make up with placeholders."""
    if isinstance(value, dict):
        return {k: generalize(v, seed_ids, seed_hashes) for k, v in value.items()}
    if isinstance(value, list):
        return [generalize(v, seed_ids, seed_hashes) for v in value]
    if isinstance(value, str):
        if ULID_RE.match(value) and value not in seed_ids:
            return "<ulid>"
        if value == FIXTURE_NOW_ISO:
            return "<iso8601>"
        if SHA_RE.match(value) and value not in seed_hashes:
            return "<sha256>"
        if JWT_RE.match(value) and value.startswith("eyJ"):
            return "<jwt>"
    return value


def write_fixtures() -> None:
    seed_ids, seed_hashes = _seed_values()
    for name, fixture in load_fixtures().items():
        for step, (status, headers, body) in zip(fixture["steps"], run_fixture(fixture)):
            response = {"status": status}
            response["body"] = generalize(body, seed_ids, seed_hashes)
            step["response"] = response
        with open(os.path.join(FIXTURE_DIR, name), "w", encoding="utf-8") as fh:
            json.dump(fixture, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        print(f"wrote {name}")


if __name__ == "__main__":
    if "--write" in sys.argv:
        write_fixtures()
    failed = 0
    for name, fixture in load_fixtures().items():
        problems = check_fixture(fixture)
        if problems:
            failed += 1
            print(f"FAIL {name}\n  " + "\n  ".join(problems[:20]))
    print(f"{len(load_fixtures()) - failed} ok, {failed} failed")
    sys.exit(1 if failed else 0)

"""Server settings: one dataclass, filled from flags (local_server) or env (Lambda)."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import List, Optional

SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO_DIR = os.path.dirname(SERVER_DIR)
DEFAULT_DATA_DIR = os.path.join(SERVER_DIR, ".data")
DEFAULT_COUNTS_PATH = os.path.join(REPO_DIR, "data", "meta", "kjv-counts.json")

# A development secret on purpose: the stub's tokens must never be trusted
# anywhere real. Production verifies Cognito's RS256 tokens instead.
DEV_JWT_SECRET = "html-bible-dev-secret-not-for-production"

SITE_ORIGINS = ["https://bible.marketkernel.com"]
_LOCAL_ORIGIN_RE = re.compile(r"^http://(localhost|127\.0\.0\.1)(:\d{1,5})?$")


@dataclass
class Config:
    data_dir: Optional[str] = None          # None keeps everything in memory (tests)
    eval_delay: float = 0.0                 # seconds; 0 evaluates synchronously
    token_ttl: int = 3600
    code_ttl: int = 300
    refresh_ttl: int = 30 * 24 * 3600
    jwt_secret: str = DEV_JWT_SECRET
    issuer: str = "http://localhost:8787"
    client_ids: Optional[List[str]] = None  # None accepts any client_id (stub)
    kjv_counts_path: Optional[str] = DEFAULT_COUNTS_PATH
    extra_origins: List[str] = field(default_factory=list)

    @classmethod
    def from_env(cls) -> "Config":
        """For Lambda: the same knobs as the local flags, as environment variables."""
        env = os.environ
        clients = env.get("BIBLE_CLIENT_IDS")
        return cls(
            data_dir=env.get("BIBLE_DATA_DIR", DEFAULT_DATA_DIR) or None,
            eval_delay=float(env.get("BIBLE_EVAL_DELAY", "0")),
            token_ttl=int(env.get("BIBLE_TOKEN_TTL", "3600")),
            jwt_secret=env.get("BIBLE_JWT_SECRET", DEV_JWT_SECRET),
            issuer=env.get("BIBLE_ISSUER", "http://localhost:8787"),
            client_ids=[c for c in clients.split(",") if c] if clients else None,
            kjv_counts_path=env.get("BIBLE_KJV_COUNTS", DEFAULT_COUNTS_PATH),
            extra_origins=[o for o in env.get("BIBLE_ALLOWED_ORIGINS", "").split(",") if o],
        )

    def origin_allowed(self, origin: Optional[str]) -> bool:
        """CORS and redirect allow-list: file:// pages ("null"), any local port, the site."""
        if not origin:
            return False
        if origin == "null":
            return True
        origin = origin.rstrip("/")
        return bool(_LOCAL_ORIGIN_RE.match(origin)) or origin in SITE_ORIGINS or origin in self.extra_origins

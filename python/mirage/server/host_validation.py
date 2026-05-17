# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import logging
import os
from collections.abc import Iterable

from starlette.responses import PlainTextResponse
from starlette.types import ASGIApp, Receive, Scope, Send

DEFAULT_ALLOWED_HOSTS: tuple[str, ...] = ("127.0.0.1", "localhost", "::1")

ENV_ALLOWED_HOSTS = "MIRAGE_ALLOWED_HOSTS"

logger = logging.getLogger(__name__)


def parse_allowed_hosts(value: str | None) -> list[str]:
    """Parse a CSV ``MIRAGE_ALLOWED_HOSTS`` value into a host list.

    Empty / missing values fall back to ``DEFAULT_ALLOWED_HOSTS``.

    Args:
        value (str | None): raw env var value.

    Returns:
        list[str]: parsed host list.
    """
    if value is None:
        return list(DEFAULT_ALLOWED_HOSTS)
    items = [h.strip() for h in value.split(",") if h.strip()]
    return items or list(DEFAULT_ALLOWED_HOSTS)


def resolve_allowed_hosts(
        allowed_hosts: Iterable[str] | None = None) -> list[str]:
    """Resolve allowed hosts from explicit arg or env var.

    Args:
        allowed_hosts (Iterable[str] | None): explicit list. If
            ``None``, falls back to ``$MIRAGE_ALLOWED_HOSTS`` env var,
            then ``DEFAULT_ALLOWED_HOSTS``.

    Returns:
        list[str]: resolved host list.
    """
    if allowed_hosts is not None:
        return list(allowed_hosts)
    return parse_allowed_hosts(os.environ.get(ENV_ALLOWED_HOSTS))


class HostHeaderMiddleware:
    """ASGI middleware that 400s requests with disallowed Host headers.

    Replaces Starlette's TrustedHostMiddleware so we can log on
    rejection. Port is stripped before comparison (parity with
    Starlette).

    Args:
        app (ASGIApp): downstream ASGI app.
        allowed_hosts (list[str]): exact hosts to accept. ``"*"`` in
            the list disables enforcement.
    """

    def __init__(self, app: ASGIApp, allowed_hosts: list[str]) -> None:
        self.app = app
        self.allowed_hosts = allowed_hosts
        self.allow_any = "*" in allowed_hosts

    async def __call__(self, scope: Scope, receive: Receive,
                       send: Send) -> None:
        if scope["type"] not in ("http", "websocket") or self.allow_any:
            await self.app(scope, receive, send)
            return
        headers = dict(scope.get("headers") or [])
        raw_host = headers.get(b"host", b"").decode("latin-1")
        host = raw_host.split(":")[0]
        if host in self.allowed_hosts:
            await self.app(scope, receive, send)
            return
        client = scope.get("client") or ("?", 0)
        logger.warning(
            "rejecting request from %s:%s: Host=%r not in allowlist %s",
            client[0], client[1], raw_host, self.allowed_hosts)
        response = PlainTextResponse("Invalid host header", status_code=400)
        await response(scope, receive, send)

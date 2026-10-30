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
import math
import os
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field

from limits import (
    RateLimitItem,
    RateLimitItemPerDay,
    RateLimitItemPerHour,
    RateLimitItemPerMinute,
    RateLimitItemPerSecond,
)
from limits.aio.storage import MemoryStorage
from limits.aio.strategies import FixedWindowRateLimiter
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from mirage.server.auth.middleware import PUBLIC_PATHS
from mirage.server.daemon_config import DaemonConfigError, read_daemon_table
from mirage.server.env import ENV_RATE_LIMITS
from mirage.server.metrics import refused
from mirage.server.paths import mirage_home

logger = logging.getLogger(__name__)

_PER = {
    "second": RateLimitItemPerSecond,
    "minute": RateLimitItemPerMinute,
    "hour": RateLimitItemPerHour,
    "day": RateLimitItemPerDay,
}
_KEYS = frozenset({"ip", "account", "workspace"})
_HEADER = "header:"


@dataclass(frozen=True)
class RateLimit:
    """At most ``rate`` requests for each value of ``key``.

    ``rate`` is a count per unit: ``"600/minute"``, ``"50/second"``; the
    units are second, minute, hour and day. ``key`` is what requests are
    counted by: ``"ip"`` (the client's address, the forwarded one behind a
    trusted proxy), ``"account"`` (the signed-in account),
    ``"workspace"`` (the workspace the path names), ``"header:<name>"``
    (that header's value), or a function of the request. A request whose
    key has no value (no account, no workspace in the path, no such
    header, a function answering None) is not counted by this limit.
    Each value gets a window of one unit from its first request; past the
    count, requests answer 429 with ``Retry-After`` until it ends.

    Args:
        key (str | Callable[[Request], str | None]): what to count by.
        rate (str): the count per unit.

    Raises:
        ValueError: an unknown key or a malformed rate.
    """

    key: str | Callable[[Request], str | None]
    rate: str
    item: RateLimitItem = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        if isinstance(self.key, str) and not (
            self.key in _KEYS
            or (self.key.startswith(_HEADER) and len(self.key) > len(_HEADER))
        ):
            raise ValueError(
                f"rate limit key must be ip, account, workspace or "
                f"header:<name>, got {self.key!r}"
            )
        count, _, unit = (part.strip() for part in self.rate.partition("/"))
        per = _PER.get(unit.removesuffix("s"))
        if (
            not (count.isascii() and count.isdigit())
            or int(count) < 1
            or per is None
        ):
            raise ValueError(
                f"rate must be a count per second, minute, hour or day, "
                f"like 600/minute, got {self.rate!r}"
            )
        object.__setattr__(self, "item", per(int(count)))


def parse_rate_limits(text: str) -> list[RateLimit]:
    """The limits a ``rate_limits`` setting names, comma-separated
    ``key=rate`` entries: ``"ip=1000/minute, header:x-tenant=50/second"``.

    Args:
        text (str): the setting.

    Raises:
        ValueError: an entry without ``=``, or a bad key or rate.
    """
    limits = []
    for entry in text.split(","):
        if not entry.strip():
            continue
        key, eq, rate = entry.partition("=")
        if not eq:
            raise ValueError(
                f"rate limit entries are key=rate, got {entry.strip()!r}"
            )
        limits.append(RateLimit(key.strip(), rate.strip()))
    return limits


def resolve_rate_limits(
    rate_limits: Sequence[RateLimit] | None = None,
) -> tuple[RateLimit, ...]:
    """The server's rate limits: ``rate_limits`` when given, else those
    ``$MIRAGE_RATE_LIMITS`` names, else the ``rate_limits`` key in
    config.toml's ``[daemon]`` table, else none. Mirrors TypeScript's
    ``resolveRateLimits``.

    Args:
        rate_limits (Sequence[RateLimit] | None): the limits the caller
            set.

    Raises:
        DaemonConfigError: the setting names a bad entry.
    """
    if rate_limits is not None:
        return tuple(rate_limits)
    text = os.environ.get(ENV_RATE_LIMITS) or read_daemon_table(
        mirage_home()
    ).get("rate_limits")
    if not text:
        return ()
    try:
        return tuple(parse_rate_limits(str(text)))
    except ValueError as exc:
        raise DaemonConfigError(f"rate_limits: {exc}") from exc


def _value(
    key: str | Callable[[Request], str | None], request: Request
) -> str | None:
    """What ``request`` is counted as under ``key``, None when nothing.

    Args:
        key (str | Callable[[Request], str | None]): the limit's key.
        request (Request): the request.
    """
    if callable(key):
        return key(request)
    if key == "ip":
        return request.client.host if request.client is not None else None
    if key == "account":
        account: str | None = request.scope.get("state", {}).get("account")
        return account
    if key == "workspace":
        parts = request.scope["path"].split("/")
        if parts[1:3] != ["v1", "workspaces"] or len(parts) < 4:
            return None
        return parts[3] or None
    return request.headers.get(key.removeprefix(_HEADER))


class RateLimitMiddleware:
    """ASGI middleware answering 429 past the server's rate limits.

    It runs after authentication, so a limit keyed on the account counts
    the signed-in one; the public paths and WebSocket connections are not
    counted.

    Args:
        app (ASGIApp): downstream ASGI app.
        rate_limits (Sequence[RateLimit]): the limits, each counted on
            its own.
    """

    def __init__(self, app: ASGIApp, rate_limits: Sequence[RateLimit]) -> None:
        self.app = app
        self.rate_limits = tuple(rate_limits)
        self._limiter = FixedWindowRateLimiter(MemoryStorage())

    async def __call__(
        self, scope: Scope, receive: Receive, send: Send
    ) -> None:
        if scope["type"] != "http" or scope["path"] in PUBLIC_PATHS:
            await self.app(scope, receive, send)
            return
        request = Request(scope)
        for at, limit in enumerate(self.rate_limits):
            value = _value(limit.key, request)
            if value is None or await self._limiter.hit(
                limit.item, str(at), value
            ):
                continue
            stats = await self._limiter.get_window_stats(
                limit.item, str(at), value
            )
            wait = max(1, math.ceil(stats.reset_time - time.time()))
            logger.warning("rate-limiting request from %s", value)
            refused("rate_limit")
            response = JSONResponse(
                {"detail": "Too Many Requests"},
                status_code=429,
                headers={"Retry-After": str(wait)},
            )
            await response(scope, receive, send)
            return
        await self.app(scope, receive, send)

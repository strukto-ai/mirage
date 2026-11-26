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

from starlette.types import ASGIApp, Receive, Scope, Send

from mirage.server.daemon_config import read_daemon_table
from mirage.server.env import ENV_ALLOWED_HOSTS, ENV_FORWARDED_ALLOW_IPS
from mirage.server.errors import ErrorCode, HttpError
from mirage.server.host_validation_constants import (
    HOST_PATTERN,
    LOOPBACK_HOSTS,
    SAME_ORIGIN_FETCH_SITES,
)
from mirage.server.paths import mirage_home

logger = logging.getLogger(__name__)


def parse_allowed_hosts(value: str | None) -> list[str]:
    """Parse a comma-separated host list, as ``MIRAGE_ALLOWED_HOSTS``
    and the ``allowed_hosts`` key hold it.

    Args:
        value (str | None): the raw value; None or blank lists none.

    Returns:
        list[str]: the entries it lists.
    """
    return [h.strip() for h in (value or "").split(",") if h.strip()]


def resolve_allowed_hosts(
    allowed_hosts: Iterable[str] | None = None,
) -> list[str]:
    """The host names the server answers: the loopback names, then the
    names added to them. Each added entry is kept without its port or
    IPv6 brackets and in lower case, as a Host is compared.

    Args:
        allowed_hosts (Iterable[str] | None): the names to add. If
            ``None``, ``$MIRAGE_ALLOWED_HOSTS``, else the
            ``allowed_hosts`` key in ``config.toml`` ``[daemon]`` (both
            comma-separated). ``"*"`` turns the Host check off.

    Returns:
        list[str]: the loopback names, then each added name once.
    """
    if allowed_hosts is None:
        raw = os.environ.get(ENV_ALLOWED_HOSTS)
        if not raw:
            from_config = read_daemon_table(mirage_home()).get("allowed_hosts")
            raw = str(from_config) if from_config else None
        allowed_hosts = parse_allowed_hosts(raw)
    hosts = list(LOOPBACK_HOSTS)
    for entry in allowed_hosts:
        name = strip_port(entry).lower()
        if name not in hosts:
            hosts.append(name)
    return hosts


def resolve_forwarded_allow_ips(
    forwarded_allow_ips: Iterable[str] | None = None,
) -> list[str]:
    """The proxies whose ``X-Forwarded-For`` and ``X-Forwarded-Proto``
    the server believes, so the client address a rate limit counts is
    the caller's and not the proxy's. Each entry is an address or a
    network (``10.0.0.0/8``); ``*`` believes every peer.

    Args:
        forwarded_allow_ips (Iterable[str] | None): explicit list. If
            ``None``, falls back to ``$MIRAGE_FORWARDED_ALLOW_IPS``, then
            the ``forwarded_allow_ips`` key in ``config.toml``
            ``[daemon]`` (both comma-separated), then none.

    Returns:
        list[str]: the trusted proxies; empty believes none.
    """
    if forwarded_allow_ips is not None:
        return list(forwarded_allow_ips)
    raw = os.environ.get(ENV_FORWARDED_ALLOW_IPS) or read_daemon_table(
        mirage_home()
    ).get("forwarded_allow_ips")
    return [ip.strip() for ip in str(raw or "").split(",") if ip.strip()]


def strip_port(raw_host: str) -> str:
    """Strip the port (and IPv6 brackets) from a Host header value.

    Returns the bare host only when the value matches one of
    ``host`` / ``host:digits`` / ``[host]`` / ``[host]:digits``; any
    other (malformed) input is returned unchanged so the allowlist
    comparison fails closed.

    Args:
        raw_host (str): raw Host header value.

    Returns:
        str: bare host, or the raw input when malformed.
    """
    match = HOST_PATTERN.match(raw_host)
    if match is None:
        return raw_host
    return match.group(1) or match.group(2) or raw_host


def is_host_allowed(raw_host: str | None, allowed: list[str]) -> bool:
    """Decide whether a Host header value is in the allowlist.

    Args:
        raw_host (str | None): raw Host header value.
        allowed (list[str]): the names from ``resolve_allowed_hosts``;
            ``"*"`` accepts any host.

    Returns:
        bool: True when the host, without its port and in lower case,
        is allowed.
    """
    if "*" in allowed:
        return True
    if not raw_host:
        return False
    return strip_port(raw_host).lower() in allowed


def is_cross_origin(
    raw_host: str, origin: str | None, fetch_site: str | None
) -> bool:
    """Decide whether a browser sent this request from another origin.

    A browser names the page that made a request in ``Origin`` and
    ``Sec-Fetch-Site``; other clients send neither, so a request
    without them is never cross-origin.

    Args:
        raw_host (str): raw Host header value.
        origin (str | None): raw Origin header value.
        fetch_site (str | None): raw Sec-Fetch-Site header value.

    Returns:
        bool: True when either header names another origin.
    """
    if fetch_site is not None and fetch_site not in SAME_ORIGIN_FETCH_SITES:
        return True
    if origin is None:
        return False
    _, sep, authority = origin.partition("://")
    return not sep or authority.lower() != raw_host.lower()


def refusal(
    raw_host: str,
    origin: str | None,
    fetch_site: str | None,
    allowed: list[str],
) -> HttpError | None:
    """The 403 for a request the server answers before any route: a
    Host it does not serve, or a browser page from another origin.
    The message names no header value.

    Args:
        raw_host (str): raw Host header value.
        origin (str | None): raw Origin header value.
        fetch_site (str | None): raw Sec-Fetch-Site header value.
        allowed (list[str]): the names from ``resolve_allowed_hosts``.

    Returns:
        HttpError | None: the refusal, or None to let the request on.
    """
    if not is_host_allowed(raw_host, allowed):
        return HttpError(
            ErrorCode.HOST_NOT_ALLOWED,
            f"host is not allowed; add it to {ENV_ALLOWED_HOSTS}",
        )
    if is_cross_origin(raw_host, origin, fetch_site):
        return HttpError(
            ErrorCode.ORIGIN_NOT_ALLOWED, "cross-origin request refused"
        )
    return None


def refusal_line(
    client: str,
    refused: HttpError,
    raw_host: str,
    origin: str | None,
    fetch_site: str | None,
    allowed: list[str],
) -> str:
    """The warning logged for a ``refusal``, with the headers it was
    decided on.

    Args:
        client (str): the caller's address.
        refused (HttpError): the refusal.
        raw_host (str): raw Host header value.
        origin (str | None): raw Origin header value.
        fetch_site (str | None): raw Sec-Fetch-Site header value.
        allowed (list[str]): the names from ``resolve_allowed_hosts``.

    Returns:
        str: the line.
    """
    return (
        f"rejecting request from {client}: {refused.code.value}: "
        f"Host={raw_host!r} Origin={origin!r} Sec-Fetch-Site={fetch_site!r}, "
        f"allowed {allowed}"
    )


class HostHeaderMiddleware:
    """ASGI middleware that answers ``refusal`` and logs it.

    Args:
        app (ASGIApp): downstream ASGI app.
        allowed_hosts (list[str]): the names from
            ``resolve_allowed_hosts``. ``"*"`` in the list disables the
            Host check, not the origin check.
    """

    def __init__(self, app: ASGIApp, allowed_hosts: list[str]) -> None:
        self.app = app
        self.allowed_hosts = allowed_hosts

    async def __call__(
        self, scope: Scope, receive: Receive, send: Send
    ) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        headers = {
            k: v.decode("latin-1") for k, v in scope.get("headers") or []
        }
        raw_host = headers.get(b"host", "")
        origin = headers.get(b"origin")
        fetch_site = headers.get(b"sec-fetch-site")
        refused = refusal(raw_host, origin, fetch_site, self.allowed_hosts)
        if refused is None:
            await self.app(scope, receive, send)
            return
        client = scope.get("client") or ("?", 0)
        logger.warning(
            refusal_line(
                f"{client[0]}:{client[1]}",
                refused,
                raw_host,
                origin,
                fetch_site,
                self.allowed_hosts,
            )
        )
        await refused.response()(scope, receive, send)

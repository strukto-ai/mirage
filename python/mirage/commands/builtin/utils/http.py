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

# This layer reports what the server said and never decides whether that is an
# error: curl treats a 404 as a successful transfer (exit 0, body on stdout)
# while wget treats it as exit 8, so the status has to reach the command. An
# earlier version called raise_for_status() here, which made both tools fail on
# any 4xx and leaked httpx's exception text (complete with a documentation URL)
# onto stderr.

import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, fields, replace
from typing import Any
from urllib.parse import urlsplit

from mirage.commands.builtin.errors import HttpConnectError, HttpTimeoutError
from mirage.commands.builtin.utils.constants import HTTP_TIMEOUT_SECONDS
from mirage.commands.builtin.utils.cookie import (
    CookieJar,
    cookie_value,
    same_origin,
)
from mirage.context.session_context import current_caller
from mirage.io.network import network_policies
from mirage.io.stream import prime_stream
from mirage.io.types import ByteSource
from mirage.policy.errors import PolicyDenied
from mirage.policy.policies import (
    Policies,
    post_network_gate,
    pre_network_gate,
)
from mirage.policy.types import NetworkContext, NetworkResultContext

# httpx is the [http] extra, so it stays optional: top-level import guarded the
# same way the databricks accessor guards its SDK.
httpx: Any
try:
    import httpx as _httpx
except ImportError:
    httpx = None
else:
    httpx = _httpx

DEFAULT_USER_AGENT = "Mozilla/5.0 (compatible; mirage/1.0)"
DEFAULT_PORTS = {"http": 80, "https": 443}
MISSING_HTTPX = "httpx is required for curl/wget: pip install 'mirage[http]'"


@dataclass(frozen=True, slots=True)
class HttpResponse:
    status: int
    reason: str
    # Whole for every redirect hop; the final hop's arrives as it is read
    # when the request asked for a stream.
    body: ByteSource
    # The URL this hop was asked for and the method the client sent for
    # it: a redirect can move both (a POST becomes a GET on 301, 302 and
    # 303, in httpx as in curl).
    url: str
    # Wire order, names as the server spelled them, repeats kept.
    headers: tuple[tuple[str, str], ...] = ()
    method: str = "GET"
    # The redirect responses followed on the way here, in order; empty
    # when none was followed. curl -i and -v show every hop.
    history: tuple["HttpResponse", ...] = ()

    @property
    def is_error(self) -> bool:
        return self.status >= 400


def _with_default_ua(headers: dict[str, str] | None) -> dict[str, str]:
    # Header names are case-insensitive, so a `user-agent` the caller set
    # replaces the default rather than riding beside it.
    if headers and any(k.lower() == "user-agent" for k in headers):
        return dict(headers)
    return {"User-Agent": DEFAULT_USER_AGENT, **(headers or {})}


def _endpoint(url: str) -> tuple[str, int]:
    parts = urlsplit(url)
    host = parts.hostname or ""
    port = parts.port or DEFAULT_PORTS.get(parts.scheme, 80)
    return host, port


def _hop(resp: Any, body: ByteSource) -> HttpResponse:
    return HttpResponse(
        status=resp.status_code,
        reason=resp.reason_phrase,
        body=body,
        url=str(resp.url),
        headers=tuple(resp.headers.multi_items()),
        method=resp.request.method,
    )


def _response(resp: Any, body: ByteSource) -> HttpResponse:
    return replace(
        _hop(resp, body),
        history=tuple(_hop(r, r.content) for r in resp.history),
    )


def _timeout(url: str, started: float) -> HttpTimeoutError:
    host, port = _endpoint(url)
    return HttpTimeoutError(
        host, port, int((time.monotonic() - started) * 1000)
    )


async def _ended(
    policies: Policies | None,
    asked: NetworkContext,
    status: int,
    size: int,
    failed: bool,
) -> None:
    # post_network once the transfer ends, however it ends: a refusal of
    # one that worked fails it as a broken transfer does.
    seen = {field.name: getattr(asked, field.name) for field in fields(asked)}
    ended = NetworkResultContext(
        **seen, status=status, size=size, failed=failed
    )
    try:
        await post_network_gate(policies, ended)
    except PolicyDenied as exc:
        if not failed:
            raise HttpConnectError(asked.host, asked.port) from exc


async def _streamed(
    client: Any,
    resp: Any,
    url: str,
    started: float,
    policies: Policies | None,
    asked: NetworkContext,
) -> AsyncIterator[bytes]:
    # The body as it arrives, under the same deadline and with the same
    # failures as the request; the client closes once it ends or is let go.
    size = 0
    try:
        async for chunk in resp.aiter_bytes():
            size += len(chunk)
            yield chunk
    except httpx.TimeoutException as exc:
        await _ended(policies, asked, resp.status_code, size, True)
        raise _timeout(url, started) from exc
    except httpx.TransportError as exc:
        await _ended(policies, asked, resp.status_code, size, True)
        host, port = _endpoint(url)
        raise HttpConnectError(host, port) from exc
    except GeneratorExit:
        await _ended(policies, asked, resp.status_code, size, True)
        raise
    finally:
        await resp.aclose()
        await client.aclose()
    await _ended(policies, asked, resp.status_code, size, False)


async def http_request(
    url: str,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    data: bytes | None = None,
    timeout: float | None = HTTP_TIMEOUT_SECONDS,
    follow_redirects: bool = False,
    verify: bool = True,
    *,
    form_data: dict[str, str] | None = None,
    cookies: CookieJar | None = None,
    stream: bool = False,
) -> HttpResponse:
    # A None timeout is no deadline at all (curl's `--max-time 0`), which
    # is what httpx spells it as too. `verify=False` is curl's -k: the
    # server's certificate is not checked. `stream` hands the final body
    # over as it arrives instead of holding all of it first, so a download
    # costs one chunk of memory however large it is.
    if httpx is None:
        raise ImportError(MISSING_HTTPX)
    # The policies of the line sending it judge the request before any
    # connection opens; a refusal reads as a port that would not open.
    policies = network_policies()
    host, port = _endpoint(url)
    caller = current_caller()
    asked = NetworkContext(
        url=url,
        method=method,
        host=host,
        port=port,
        command=caller.command or "",
        session_id="" if caller.session is None else caller.session.session_id,
    )
    try:
        await pre_network_gate(policies, asked)
    except PolicyDenied as exc:
        raise HttpConnectError(host, port) from exc
    started = time.monotonic()
    event_hooks: dict[str, list[Any]] = {}
    if cookies is not None:
        # The jar every hop sends from and keeps the Set-Cookie headers in.
        # Each hop's Cookie header is set here, over the one httpx would
        # build from its own cookies; httpx drops a Cookie header on every
        # redirect, so the one among `headers` is put back after the jar's
        # on the hops that stay on the first origin.
        # httpx hands each hop's URL over with its host in Punycode, so the
        # first URL goes through httpx too before the two are compared.
        first = str(httpx.URL(url))
        typed = next(
            (v for k, v in (headers or {}).items() if k.lower() == "cookie"),
            None,
        )

        async def send_cookies(request: Any) -> None:
            hop = str(request.url)
            value = cookie_value(
                cookies.header(hop), typed if same_origin(hop, first) else None
            )
            request.headers.pop("Cookie", None)
            if value is not None:
                request.headers["Cookie"] = value

        async def keep_cookies(response: Any) -> None:
            cookies.store(
                str(response.request.url),
                response.headers.get_list("set-cookie"),
            )

        event_hooks = {"request": [send_cookies], "response": [keep_cookies]}
    client = httpx.AsyncClient(
        timeout=timeout,
        follow_redirects=follow_redirects,
        verify=verify,
        event_hooks=event_hooks,
    )
    handed = False
    try:
        try:
            resp = await client.send(
                client.build_request(
                    method,
                    url,
                    headers=_with_default_ua(headers),
                    content=data,
                    data=form_data,
                ),
                stream=stream,
            )
        # A timeout is a transport error too, so it is told apart first:
        # curl answers it with its own code (28), not the connect one.
        except httpx.TimeoutException as exc:
            await _ended(policies, asked, 0, 0, True)
            raise _timeout(url, started) from exc
        except httpx.TransportError as exc:
            await _ended(policies, asked, 0, 0, True)
            raise HttpConnectError(host, port) from exc
        if not stream:
            await _ended(
                policies, asked, resp.status_code, len(resp.content), False
            )
            return _response(resp, resp.content)
        body = await prime_stream(
            _streamed(client, resp, url, started, policies, asked)
        )
        handed = True
        return _response(resp, body)
    finally:
        if not handed:
            await client.aclose()


async def http_form_request(
    url: str,
    method: str = "POST",
    form_data: dict[str, str] | None = None,
    headers: dict[str, str] | None = None,
    timeout: float | None = HTTP_TIMEOUT_SECONDS,
    follow_redirects: bool = False,
    verify: bool = True,
    cookies: CookieJar | None = None,
    stream: bool = False,
) -> HttpResponse:
    return await http_request(
        url,
        method,
        headers,
        timeout=timeout,
        follow_redirects=follow_redirects,
        verify=verify,
        form_data=form_data or {},
        cookies=cookies,
        stream=stream,
    )


async def http_get(
    url: str,
    headers: dict[str, str] | None = None,
    timeout: float | None = HTTP_TIMEOUT_SECONDS,
    follow_redirects: bool = True,
    stream: bool = False,
) -> HttpResponse:
    return await http_request(
        url,
        method="GET",
        headers=headers,
        timeout=timeout,
        follow_redirects=follow_redirects,
        stream=stream,
    )

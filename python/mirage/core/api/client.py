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

import asyncio
import json
import logging
import math
from collections.abc import Mapping
from dataclasses import dataclass
from functools import partial
from typing import Any, Literal

import aiohttp
from aiohttp.payload import JsonPayload
from tenacity import (AsyncRetrying, RetryCallState, before_sleep_log,
                      retry_if_exception_type, stop_after_attempt)

from mirage.types import ErrorOf, JsonValue
from mirage.utils.ranges import ByteWindow, range_header, window_of

logger = logging.getLogger(__name__)

ReadMode = Literal["json", "none", "bytes", "text", "location", "response"]


@dataclass(frozen=True, slots=True)
class ApiResponse:
    """Decoded response plus the wire metadata pagination needs."""

    data: Any
    status: int
    headers: Mapping[str, str]


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    """Which statuses retry and where the wait between attempts comes from.

    Args:
        statuses (frozenset[int]): response statuses worth retrying.
        max_retries (int): retries allowed after the first attempt.
        max_backoff (float): ceiling on every inter-attempt wait, whether
            the server asked for it or the exponential fallback chose it.
        delay_source (str): "header" reads Retry-After and falls back to
            exponential backoff (Graph's convention); "body" reads a JSON
            ``retry_after`` field and falls back to 1s (Discord's).
        retry_transport (bool): also retry connection-level failures and
            timeouts, which never carry a response; the wait for those is
            the exponential backoff.
    """

    statuses: frozenset[int] = frozenset()
    max_retries: int = 0
    max_backoff: float = 30.0
    delay_source: Literal["header", "body"] = "header"
    retry_transport: bool = False


NO_RETRY = RetryPolicy()


class SessionPool:
    """One lazily created keep-alive session, recreated after close.

    A session per request is a TCP connect per request, and the closing
    side parks each socket in TIME_WAIT, which exhausts the ephemeral
    port range under load. Whatever object a backend already threads
    into every call owns one of these instead: ``TokenManager`` for the
    OAuth backends, ``SessionAccessor`` for the rest.

    Args:
        timeout (aiohttp.ClientTimeout | None): applied to the session
            at creation; None takes aiohttp's default.
    """

    def __init__(self, timeout: aiohttp.ClientTimeout | None = None) -> None:
        self._timeout = timeout
        self._session: aiohttp.ClientSession | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    def get(self) -> aiohttp.ClientSession:
        """The shared session, created on first use.

        A session is bound to the loop it was created on, so an owner
        that outlives one ``asyncio.run`` and is asked again under the
        next gets a fresh session. The superseded one is handed to its
        own loop to close when that loop still runs, and dropped when
        that loop is gone, because its transports died with it.

        Returns:
            aiohttp.ClientSession: one keep-alive pool for every call
            routed through this owner; recreated if it was closed or its
            loop was replaced.
        """
        loop = asyncio.get_running_loop()
        stale = self._session
        if stale is not None and (stale.closed or self._loop is not loop):
            if (not stale.closed and self._loop is not None
                    and not self._loop.is_closed()):
                asyncio.run_coroutine_threadsafe(stale.close(), self._loop)
            self._session = None
        if self._session is None:
            self._session = aiohttp.ClientSession(timeout=self._timeout)
            self._loop = loop
        return self._session

    async def close(self) -> None:
        """Drain the pool. Idempotent, and safe before first use."""
        if self._session is not None and not self._session.closed:
            await self._session.close()
        self._session = None
        self._loop = None


SessionArg = aiohttp.ClientSession | SessionPool | None


def resolve_session(
    session: SessionArg,
    timeout: aiohttp.ClientTimeout | None = None
) -> tuple[aiohttp.ClientSession, bool]:
    """The live session for one request, plus whether the caller owns it.

    Callers thread the inert ``SessionPool`` and the session materializes
    here, at the moment a request actually sends. Threading a live
    session instead would open one wherever the kwargs are built, which
    is exactly where a mocked request function never gets to close it.

    Args:
        session (SessionArg): a pool to draw from, a live session to
            borrow, or None to own one for this request.
        timeout (aiohttp.ClientTimeout | None): applied only to an owned
            session; a pooled or borrowed one already carries its own.

    Returns:
        tuple[aiohttp.ClientSession, bool]: the session to send on, and
        True when the caller must close it afterwards.
    """
    if isinstance(session, SessionPool):
        return session.get(), False
    if session is not None:
        return session, False
    return aiohttp.ClientSession(timeout=timeout), True


class _RetryableStatus(Exception):
    """A response whose status the policy retries, carried to tenacity.

    The body is read inside the attempt because the wait callback is
    synchronous and cannot await it; the response object stays readable
    for headers, status and request info after its connection returns to
    the pool.
    """

    def __init__(self, resp: aiohttp.ClientResponse, text: str) -> None:
        super().__init__(f"retryable HTTP {resp.status}")
        self.resp = resp
        self.text = text


def status_error(resp: aiohttp.ClientResponse, text: str) -> Exception:
    """The error ``resp.raise_for_status()`` raises, built without raising.

    Shaped as an ``ErrorOf`` so it can be passed to ``api_request``
    directly; the body text is deliberately unused because
    ``raise_for_status`` never reads it.

    Args:
        resp (aiohttp.ClientResponse): a response with status >= 400.
        text (str): the response body, ignored.
    """
    del text
    return aiohttp.ClientResponseError(resp.request_info,
                                       resp.history,
                                       status=resp.status,
                                       message=resp.reason or "",
                                       headers=resp.headers)


def _usable_delay(value: float) -> bool:
    """Whether a server-supplied delay is one we can actually wait out.

    NaN and infinity both park the retry forever (``asyncio.sleep`` never
    wakes from either), and a negative delay is malformed per RFC 9110, so
    all three are as unusable as a header that does not parse at all.

    Args:
        value (float): the delay the server asked for, in seconds.
    """
    return math.isfinite(value) and value >= 0.0


def header_delay(resp: aiohttp.ClientResponse, attempt: int,
                 retry: RetryPolicy) -> float:
    """The wait a response's Retry-After asks for, or exponential backoff.

    Args:
        resp (aiohttp.ClientResponse): the retryable response.
        attempt (int): zero-based attempt number, exponent of the backoff.
        retry (RetryPolicy): supplies the backoff cap.
    """
    retry_after = resp.headers.get("Retry-After")
    if retry_after:
        try:
            delay = float(retry_after)
        except ValueError:
            # malformed Retry-After header: fall back to exponential backoff
            delay = math.nan
        if _usable_delay(delay):
            # max_backoff is the policy's ceiling on every inter-attempt
            # wait, so a server asking for more gets the ceiling
            return min(delay, retry.max_backoff)
    return min(2.0**attempt, retry.max_backoff)


def _body_delay(text: str, retry: RetryPolicy) -> float:
    try:
        data = json.loads(text)
    except ValueError:
        return min(1.0, retry.max_backoff)
    if isinstance(data, dict):
        value = data.get("retry_after")
        # json.loads accepts NaN/Infinity literals, and 1e999 overflows to
        # inf, so a body delay needs the same guard as a header one.
        if isinstance(value, (int, float)) and _usable_delay(float(value)):
            return min(float(value), retry.max_backoff)
    return min(1.0, retry.max_backoff)


def _retry_delay(retry_state: RetryCallState, retry: RetryPolicy) -> float:
    outcome = retry_state.outcome
    error = outcome.exception() if outcome is not None else None
    if not isinstance(error, _RetryableStatus):
        # a transport failure carries no response to read a delay from
        return min(2.0**(retry_state.attempt_number - 1), retry.max_backoff)
    if retry.delay_source == "body":
        return _body_delay(error.text, retry)
    return header_delay(error.resp, retry_state.attempt_number - 1, retry)


def _retry_condition(retry: RetryPolicy) -> Any:
    if retry.retry_transport:
        # Connection failures and timeouts only (a total timeout raises
        # asyncio.TimeoutError, not a ClientConnectionError): response-mapped
        # errors raised by error_of must never come back for another attempt
        return retry_if_exception_type(
            (_RetryableStatus, aiohttp.ClientConnectionError,
             asyncio.TimeoutError))
    return retry_if_exception_type(_RetryableStatus)


def _merged_headers(headers: Mapping[str, str] | None,
                    window: ByteWindow | None) -> Mapping[str, str] | None:
    if window is None:
        return headers
    header = range_header(window.offset, window.size)
    if header is None:
        return headers
    return {**(headers or {}), "Range": header}


async def _attempt(
    session: aiohttp.ClientSession,
    method: str,
    url: str,
    error_of: ErrorOf,
    headers: Mapping[str, str] | None,
    params: Mapping[str, Any] | None,
    json_body: JsonValue,
    json_body_present: bool,
    data: Any,
    retry: RetryPolicy,
    read: ReadMode,
    window: ByteWindow | None,
) -> Any:
    if json_body_present and json_body is None:
        request = session.request(method,
                                  url,
                                  headers=_merged_headers(headers, window),
                                  params=params,
                                  data=JsonPayload(None))
    elif json_body_present:
        request = session.request(method,
                                  url,
                                  headers=_merged_headers(headers, window),
                                  params=params,
                                  json=json_body,
                                  data=data)
    else:
        request = session.request(method,
                                  url,
                                  headers=_merged_headers(headers, window),
                                  params=params,
                                  data=data)
    async with request as resp:
        if resp.status in retry.statuses:
            raise _RetryableStatus(resp, await resp.text())
        if resp.status >= 400:
            raise error_of(resp, await resp.text())
        if read == "none":
            return None
        if read == "bytes":
            return window_of(await resp.read(), resp.status, window)
        if read == "text":
            return await resp.text()
        if read == "location":
            return resp.headers.get("Location")
        text = await resp.text()
        if not text:
            # 204 and an empty 2xx have nothing to decode; the caller gets
            # None rather than a parse error on a call that worked
            data = None
        elif read == "response":
            try:
                data = json.loads(text)
            except ValueError:
                data = text
        else:
            data = json.loads(text)
        if read == "response":
            return ApiResponse(data, resp.status, {
                key.lower(): value
                for key, value in resp.headers.items()
            })
        return data


async def api_request(
    method: str,
    url: str,
    *,
    error_of: ErrorOf,
    headers: Mapping[str, str] | None = None,
    params: Mapping[str, Any] | None = None,
    json_body: JsonValue = None,
    json_body_present: bool | None = None,
    data: Any = None,
    retry: RetryPolicy = NO_RETRY,
    read: ReadMode = "json",
    window: ByteWindow | None = None,
    session: SessionArg = None,
    timeout: aiohttp.ClientTimeout | None = None,
) -> Any:
    """One round-trip against an HTTP API, with retry and error mapping.

    Args:
        method (str): HTTP method.
        url (str): full request URL.
        error_of (ErrorOf): maps a >= 400 response and its body text to the
            backend's own exception; the kit never invents an error shape.
        headers (Mapping[str, str] | None): request headers, already merged
            by the caller.
        params (Mapping[str, Any] | None): query parameters.
        json_body (JsonValue): JSON request body. None sends no body, so a
            caller that means "send an empty object" passes ``{}``
            explicitly.
        json_body_present (bool | None): override whether ``json_body`` is
            sent. This distinguishes an explicit JSON null from no body;
            absent preserves the historical None-means-no-body contract.
        data (Any): raw request body (bytes, or a mapping sent as a form),
            for endpoints that do not speak JSON; exclusive with json_body.
        retry (RetryPolicy): which statuses to retry and how long to wait.
        read (ReadMode): "json" parses the body (an empty one reads as
            None); "none" ignores it; "bytes" returns it raw, trimmed to
            ``window`` when the server ignored the Range; "text" returns it
            as a string; "location" returns the Location header; "response"
            returns decoded data with status and lower-cased headers.
        window (ByteWindow | None): the byte range to request; the Range
            header and the trim-if-unranged guard both come from it.
        session (SessionArg): a live session to reuse across calls, or
            the SessionPool it should come from -- a pool materializes
            its session only here, when the request actually sends; the
            kit opens and closes its own when absent.
        timeout (aiohttp.ClientTimeout | None): timeout for a kit-owned
            session; a reused session already carries its own.
    """
    retrying = AsyncRetrying(
        sleep=asyncio.sleep,
        stop=stop_after_attempt(retry.max_retries + 1),
        wait=partial(_retry_delay, retry=retry),
        retry=_retry_condition(retry),
        before_sleep=before_sleep_log(logger, logging.WARNING),
        reraise=True,
    )
    sess, own = resolve_session(session, timeout=timeout)
    try:
        try:
            present = (json_body is not None
                       if json_body_present is None else json_body_present)
            return await retrying(_attempt, sess, method, url, error_of,
                                  headers, params, json_body, present, data,
                                  retry, read, window)
        except _RetryableStatus as exhausted:
            # retries ran dry: the final retryable response maps through
            # the same hook a plain error status does
            raise error_of(exhausted.resp, exhausted.text) from None
    finally:
        if own:
            await sess.close()

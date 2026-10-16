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
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from functools import partial
from typing import Any, Literal
from urllib.parse import quote

import aiohttp

from mirage.core.api.client import (
    RetryPolicy,
    SessionArg,
    SessionPool,
    api_request,
    header_delay,
    resolve_session,
)
from mirage.core.msgraph.config import MsGraphConfig, graph_api
from mirage.core.msgraph.constants import MAX_BACKOFF, RETRY_STATUSES
from mirage.utils.ranges import ByteWindow
from mirage.vfs.secrets import reveal_secret

# The characters `encodeURIComponent` leaves alone that `quote` would
# escape. Keeping the two spellings identical matters beyond neatness:
# a drive id is almost always `b!<base64url>`, and the ref paths built
# from it go into a JSON body that Graph reads literally, so escaping
# the `!` in one language only would break copy and rename there.
_URI_COMPONENT_SAFE = "!*'()"


def id_segment(value: str) -> str:
    """Escape a Graph identifier for use as one URL path segment.

    A guest user's UPN carries ``#EXT#`` and a SharePoint site id is
    comma-joined, both of which change what the URL addresses if
    interpolated raw: the ``#`` opens a fragment and truncates the path.

    Args:
        value (str): the identifier, unescaped.
    """
    return quote(value, safe=_URI_COMPONENT_SAFE)


def encoded_path(path: str) -> str:
    """Escape a drive-relative item path for a Graph URL.

    Each segment is escaped on its own, the way ``id_segment`` escapes an
    identifier, so a ``/`` inside the path stays a separator and both
    languages spell the same path the same way.

    Args:
        path (str): the item path, slash-separated.
    """
    return "/".join(id_segment(part) for part in path.split("/") if part)


class GraphError(RuntimeError):
    def __init__(self, status: int, code: str, message: str) -> None:
        self.status = status
        self.code = code
        super().__init__(f"Graph API error {status} ({code}): {message}")


def _resolve_token(config: MsGraphConfig) -> str:
    token = config.access_token
    resolved = token() if callable(token) else token
    revealed: str = reveal_secret(resolved)
    return revealed


def headers(config: MsGraphConfig) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {_resolve_token(config)}",
        "Content-Type": "application/json",
    }


def _timeout(config: MsGraphConfig) -> aiohttp.ClientTimeout:
    return aiohttp.ClientTimeout(total=config.timeout)


def new_session(config: MsGraphConfig) -> aiohttp.ClientSession:
    return aiohttp.ClientSession(timeout=_timeout(config))


@asynccontextmanager
async def session_scope(
    config: MsGraphConfig, session: SessionArg
) -> AsyncIterator[aiohttp.ClientSession | SessionPool]:
    """A borrowed session or pool as-is, or an owned session closed on exit.

    Args:
        config (MsGraphConfig): supplies the timeout for an owned session.
        session (SessionArg): a pool or live session to thread onward;
            None opens one session for this scope only.
    """
    if session is not None:
        yield session
        return
    own = new_session(config)
    try:
        yield own
    finally:
        await own.close()


def _policy(config: MsGraphConfig) -> RetryPolicy:
    return RetryPolicy(
        statuses=RETRY_STATUSES,
        max_retries=config.max_retries,
        max_backoff=MAX_BACKOFF,
    )


def _error_of(
    resp: aiohttp.ClientResponse, text: str, *, method: str, url: str
) -> Exception:
    try:
        data = json.loads(text)
        err = data.get("error", {}) if isinstance(data, dict) else {}
    except ValueError:
        err = {}
    return GraphError(
        resp.status,
        err.get("code", "unknownError"),
        err.get("message", f"{method} {url}"),
    )


def _lenient_json(text: str) -> Any:
    # Graph answers 204 and the odd empty 200 for calls that worked; the
    # caller gets an empty object rather than a parse error.
    if not text:
        return {}
    try:
        return json.loads(text)
    except ValueError:
        return {}


async def _request(
    config: MsGraphConfig,
    method: str,
    url: str,
    *,
    session: SessionArg = None,
    params: dict[str, Any] | None = None,
    json_body: dict[str, Any] | None = None,
    data: bytes | None = None,
    extra_headers: dict[str, Any] | None = None,
    auth: bool = True,
    read: Literal["json", "bytes", "none", "location"] = "json",
    window: ByteWindow | None = None,
) -> Any:
    refreshed = False
    while True:
        hdrs = headers(config) if auth else {}
        if extra_headers:
            hdrs.update(extra_headers)
        try:
            result = await api_request(
                method,
                url,
                error_of=partial(_error_of, method=method, url=url),
                headers=hdrs,
                params=params,
                json_body=json_body,
                data=data,
                retry=_policy(config),
                read="text" if read == "json" else read,
                window=window,
                session=session,
                timeout=None if session is not None else _timeout(config),
            )
        except GraphError as err:
            # a 401 under a token provider means the token aged out
            # mid-flight: mint a fresh one and replay the call once
            if (
                err.status == 401
                and auth
                and not refreshed
                and callable(config.access_token)
            ):
                refreshed = True
                continue
            raise
        if read == "json":
            return _lenient_json(result)
        return result


async def graph_get(
    config: MsGraphConfig,
    url: str,
    params: dict[str, Any] | None = None,
    session: SessionArg = None,
) -> dict[str, Any]:
    data: dict[str, Any] = await _request(
        config, "GET", url, params=params, session=session
    )
    return data


async def graph_list(
    config: MsGraphConfig,
    url: str,
    params: dict[str, Any] | None = None,
    session: SessionArg = None,
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    next_url: str | None = url
    next_params = params
    sess, own = resolve_session(session, timeout=_timeout(config))
    try:
        while next_url:
            data = await _request(
                config, "GET", next_url, params=next_params, session=sess
            )
            items.extend(data.get("value", []))
            next_url = data.get("@odata.nextLink")
            next_params = None
    finally:
        if own:
            await sess.close()
    return items


async def graph_get_bytes(
    config: MsGraphConfig,
    url: str,
    window: ByteWindow | None = None,
    session: SessionArg = None,
    auth: bool = True,
) -> bytes:
    data: bytes = await _request(
        config,
        "GET",
        url,
        session=session,
        auth=auth,
        read="bytes",
        window=window,
    )
    return data


async def graph_stream(
    config: MsGraphConfig,
    url: str,
    chunk_size: int = 8192,
    session: SessionArg = None,
    auth: bool = True,
) -> AsyncIterator[bytes]:
    # A chunked generator cannot ride api_request: the body outlives the
    # call, so the response must stay open while the caller consumes it.
    sess, own = resolve_session(session, timeout=_timeout(config))
    try:
        attempt = 0
        refreshed = False
        while True:
            hdrs = headers(config) if auth else {}
            async with sess.get(url, headers=hdrs) as resp:
                if (
                    resp.status in RETRY_STATUSES
                    and attempt < config.max_retries
                ):
                    await asyncio.sleep(
                        header_delay(resp, attempt, _policy(config))
                    )
                    attempt += 1
                    continue
                if (
                    resp.status == 401
                    and auth
                    and not refreshed
                    and callable(config.access_token)
                ):
                    refreshed = True
                    continue
                if resp.status >= 400:
                    raise _error_of(
                        resp, await resp.text(), method="GET", url=url
                    )
                async for chunk in resp.content.iter_chunked(chunk_size):
                    yield chunk
                return
    finally:
        if own:
            await sess.close()


async def graph_post(
    config: MsGraphConfig,
    url: str,
    body: dict[str, Any] | None = None,
    session: SessionArg = None,
) -> dict[str, Any]:
    data: dict[str, Any] = await _request(
        config, "POST", url, json_body=body or {}, session=session
    )
    return data


async def graph_batch(
    config: MsGraphConfig,
    urls: list[str],
    session: SessionArg = None,
) -> list[tuple[int, dict[str, Any], float]]:
    """The answers to several GETs from one JSON batch (``$batch``), each
    as its status, its body and the seconds its ``Retry-After`` asks to be
    waited, in the order of ``urls``.

    Graph runs at most ``BATCH_LIMIT`` requests in a batch. Each URL is a
    full one under the mount's service root, and goes in relative to it,
    as a batch names its requests. A request the reply leaves out answers
    status 0, a body that is not an object answers empty, and a wait is
    at most ``MAX_BACKOFF``, 0 when the answer names none.

    Args:
        config (MsGraphConfig): Graph config.
        urls (list[str]): the GETs, each under ``graph_api(config)``.
        session (SessionArg): pool or live session to ride.
    """
    root = graph_api(config)
    requests = [
        {"id": str(i), "method": "GET", "url": url.removeprefix(root)}
        for i, url in enumerate(urls)
    ]
    data = await _request(
        config,
        "POST",
        f"{root}/$batch",
        json_body={"requests": requests},
        session=session,
    )
    answers: dict[str, tuple[int, dict[str, Any], float]] = {}
    for reply in data.get("responses") or []:
        if isinstance(reply, dict):
            status, body = reply.get("status"), reply.get("body")
            headers = reply.get("headers")
            answers[str(reply.get("id"))] = (
                status if isinstance(status, int) else 0,
                body if isinstance(body, dict) else {},
                _retry_after(headers if isinstance(headers, dict) else {}),
            )
    return [answers.get(str(i), (0, {}, 0.0)) for i in range(len(urls))]


def _retry_after(headers: dict[str, Any]) -> float:
    """The seconds a batched answer's ``Retry-After`` asks to be waited, at
    most ``MAX_BACKOFF``; 0 for none, or for one that is not a count of
    seconds.

    Args:
        headers (dict[str, Any]): the answer's headers.
    """
    for name, value in headers.items():
        if str(name).lower() == "retry-after":
            text = str(value).strip()
            seconds = text.isascii() and text.isdigit()
            return min(float(text), MAX_BACKOFF) if seconds else 0.0
    return 0.0


async def graph_post_monitor(
    config: MsGraphConfig,
    url: str,
    body: dict[str, Any] | None = None,
    session: SessionArg = None,
) -> str:
    location = await _request(
        config,
        "POST",
        url,
        json_body=body or {},
        session=session,
        read="location",
    )
    if not isinstance(location, str) or not location:
        raise GraphError(
            502,
            "missingMonitor",
            f"POST {url} did not return a Location header",
        )
    return location


async def graph_patch(
    config: MsGraphConfig,
    url: str,
    body: dict[str, Any],
    session: SessionArg = None,
) -> dict[str, Any]:
    data: dict[str, Any] = await _request(
        config, "PATCH", url, json_body=body, session=session
    )
    return data


async def graph_delete(
    config: MsGraphConfig, url: str, session: SessionArg = None
) -> None:
    await _request(config, "DELETE", url, session=session, read="none")


async def graph_put_bytes(
    config: MsGraphConfig,
    url: str,
    data: bytes,
    content_type: str = "application/octet-stream",
    session: SessionArg = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = await _request(
        config,
        "PUT",
        url,
        data=data,
        extra_headers={"Content-Type": content_type},
        session=session,
    )
    return payload


def _monitor_error(
    resp: aiohttp.ClientResponse, text: str, *, url: str
) -> Exception:
    return GraphError(resp.status, "monitorError", f"GET {url}")


async def poll_monitor(
    url: str, timeout: float, interval: float = 1.0, session: SessionArg = None
) -> dict[str, Any]:
    waited = 0.0
    sess, own = resolve_session(session)
    try:
        while True:
            payload = await api_request(
                "GET",
                url,
                error_of=partial(_monitor_error, url=url),
                session=sess,
            )
            if not isinstance(payload, dict):
                raise GraphError(
                    502,
                    "invalidMonitorResponse",
                    f"GET {url} did not return an object",
                )
            status = payload.get("status")
            if not isinstance(status, str) or not status:
                raise GraphError(
                    502,
                    "invalidMonitorResponse",
                    f"GET {url} did not return a status",
                )
            if status in ("completed", "failed"):
                return payload
            if waited >= timeout:
                return payload
            await asyncio.sleep(interval)
            waited += interval
    finally:
        if own:
            await sess.close()


async def upload_chunk(
    config: MsGraphConfig,
    upload_url: str,
    data: bytes,
    start: int,
    total: int,
    session: SessionArg = None,
) -> dict[str, Any]:
    end = start + len(data) - 1
    hdrs = {"Content-Range": f"bytes {start}-{end}/{total}"}
    text = await api_request(
        "PUT",
        upload_url,
        error_of=partial(_error_of, method="PUT", url=upload_url),
        headers=hdrs,
        data=data,
        retry=_policy(config),
        read="text",
        session=session,
        timeout=None if session is not None else _timeout(config),
    )
    payload: dict[str, Any] = _lenient_json(text)
    return payload

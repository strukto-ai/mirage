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
from functools import partial
from typing import Any, Literal
from urllib.parse import quote

import aiohttp

from mirage.accessor.onedrive import OneDriveAccessor
from mirage.accessor.sharepoint import SharePointAccessor
from mirage.core.api.client import RetryPolicy, api_request, header_delay
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
    accessor: OneDriveAccessor | SharePointAccessor,
    method: str,
    url: str,
    *,
    params: dict[str, Any] | None = None,
    json_body: dict[str, Any] | None = None,
    data: bytes | None = None,
    extra_headers: dict[str, Any] | None = None,
    auth: bool = True,
    read: Literal["json", "bytes", "none", "location"] = "json",
    window: ByteWindow | None = None,
) -> Any:
    config = accessor.config
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
                session=accessor.pool,
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
    accessor: OneDriveAccessor | SharePointAccessor,
    url: str,
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    data: dict[str, Any] = await _request(accessor, "GET", url, params=params)
    return data


async def graph_list(
    accessor: OneDriveAccessor | SharePointAccessor,
    url: str,
    params: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    next_url: str | None = url
    next_params = params
    while next_url:
        data = await _request(accessor, "GET", next_url, params=next_params)
        items.extend(data.get("value", []))
        next_url = data.get("@odata.nextLink")
        next_params = None
    return items


async def graph_get_bytes(
    accessor: OneDriveAccessor | SharePointAccessor,
    url: str,
    window: ByteWindow | None = None,
    auth: bool = True,
) -> bytes:
    data: bytes = await _request(
        accessor,
        "GET",
        url,
        auth=auth,
        read="bytes",
        window=window,
    )
    return data


async def graph_stream(
    accessor: OneDriveAccessor | SharePointAccessor,
    url: str,
    chunk_size: int = 8192,
    auth: bool = True,
) -> AsyncIterator[bytes]:
    # A chunked generator cannot ride api_request: the body outlives the
    # call, so the response must stay open while the caller consumes it.
    config = accessor.config
    sess = accessor.pool.get()
    attempt = 0
    refreshed = False
    while True:
        hdrs = headers(config) if auth else {}
        async with sess.get(url, headers=hdrs) as resp:
            if resp.status in RETRY_STATUSES and attempt < config.max_retries:
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
                raise _error_of(resp, await resp.text(), method="GET", url=url)
            async for chunk in resp.content.iter_chunked(chunk_size):
                yield chunk
            return


async def graph_post(
    accessor: OneDriveAccessor | SharePointAccessor,
    url: str,
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    data: dict[str, Any] = await _request(
        accessor, "POST", url, json_body=body or {}
    )
    return data


async def graph_batch(
    accessor: OneDriveAccessor | SharePointAccessor, urls: list[str]
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
        accessor (OneDriveAccessor | SharePointAccessor): Graph accessor.
        urls (list[str]): the GETs, each under ``graph_api(config)``.
    """
    root = graph_api(accessor.config)
    requests = [
        {"id": str(i), "method": "GET", "url": url.removeprefix(root)}
        for i, url in enumerate(urls)
    ]
    data = await _request(
        accessor, "POST", f"{root}/$batch", json_body={"requests": requests}
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
    accessor: OneDriveAccessor | SharePointAccessor,
    url: str,
    body: dict[str, Any] | None = None,
) -> str:
    location = await _request(
        accessor,
        "POST",
        url,
        json_body=body or {},
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
    accessor: OneDriveAccessor | SharePointAccessor,
    url: str,
    body: dict[str, Any],
) -> dict[str, Any]:
    data: dict[str, Any] = await _request(
        accessor, "PATCH", url, json_body=body
    )
    return data


async def graph_delete(
    accessor: OneDriveAccessor | SharePointAccessor, url: str
) -> None:
    await _request(accessor, "DELETE", url, read="none")


async def graph_put_bytes(
    accessor: OneDriveAccessor | SharePointAccessor,
    url: str,
    data: bytes,
    content_type: str = "application/octet-stream",
) -> dict[str, Any]:
    payload: dict[str, Any] = await _request(
        accessor,
        "PUT",
        url,
        data=data,
        extra_headers={"Content-Type": content_type},
    )
    return payload


def _monitor_error(
    resp: aiohttp.ClientResponse, text: str, *, url: str
) -> Exception:
    return GraphError(resp.status, "monitorError", f"GET {url}")


async def poll_monitor(
    accessor: OneDriveAccessor | SharePointAccessor,
    url: str,
    interval: float = 1.0,
) -> dict[str, Any]:
    waited = 0.0
    while True:
        payload = await api_request(
            "GET",
            url,
            error_of=partial(_monitor_error, url=url),
            session=accessor.pool,
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
        if waited >= accessor.config.timeout:
            return payload
        await asyncio.sleep(interval)
        waited += interval


async def upload_chunk(
    accessor: OneDriveAccessor | SharePointAccessor,
    upload_url: str,
    data: bytes,
    start: int,
    total: int,
) -> dict[str, Any]:
    end = start + len(data) - 1
    hdrs = {"Content-Range": f"bytes {start}-{end}/{total}"}
    text = await api_request(
        "PUT",
        upload_url,
        error_of=partial(_error_of, method="PUT", url=upload_url),
        headers=hdrs,
        data=data,
        retry=_policy(accessor.config),
        read="text",
        session=accessor.pool,
    )
    payload: dict[str, Any] = _lenient_json(text)
    return payload


async def cancel_upload(
    accessor: OneDriveAccessor | SharePointAccessor, upload_url: str
) -> None:
    await api_request(
        "DELETE",
        upload_url,
        error_of=partial(_error_of, method="DELETE", url=upload_url),
        read="none",
        session=accessor.pool,
    )

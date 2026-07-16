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

import aiohttp

from mirage.core.msgraph.config import MsGraphConfig
from mirage.resource.secrets import reveal_secret
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of

GRAPH_API = "https://graph.microsoft.com/v1.0"
RETRY_STATUSES = {429, 503, 504}
MAX_BACKOFF = 30.0


def split_path(path: PathSpec) -> tuple[str, str]:
    prefix = mount_prefix_of(path.virtual, path.resource_path) or ""
    raw = path.virtual
    if prefix and raw.startswith(prefix):
        rest = raw[len(prefix):]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            raw = rest or "/"
    return prefix, raw.strip("/")


class GraphError(RuntimeError):

    def __init__(self, status: int, code: str, message: str) -> None:
        self.status = status
        self.code = code
        super().__init__(f"Graph API error {status} ({code}): {message}")


def _resolve_token(config: MsGraphConfig) -> str:
    token = config.access_token
    resolved = token() if callable(token) else token
    return reveal_secret(resolved)


def headers(config: MsGraphConfig) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {_resolve_token(config)}",
        "Content-Type": "application/json",
    }


def _timeout(config: MsGraphConfig) -> aiohttp.ClientTimeout:
    return aiohttp.ClientTimeout(total=config.timeout)


def new_session(config: MsGraphConfig) -> aiohttp.ClientSession:
    return aiohttp.ClientSession(timeout=_timeout(config))


async def _raise_for_status(method: str, url: str,
                            resp: aiohttp.ClientResponse) -> None:
    if resp.status < 400:
        return
    try:
        data = await resp.json()
        err = data.get("error", {}) if isinstance(data, dict) else {}
    except (aiohttp.ContentTypeError, ValueError):
        err = {}
    raise GraphError(resp.status, err.get("code", "unknownError"),
                     err.get("message", f"{method} {url}"))


def _retry_delay(resp: aiohttp.ClientResponse, attempt: int) -> float:
    retry_after = resp.headers.get("Retry-After")
    if retry_after:
        try:
            return float(retry_after)
        except ValueError:
            # malformed Retry-After header: fall back to exponential backoff
            pass
    return min(2.0**attempt, MAX_BACKOFF)


def _should_retry(status: int, attempt: int, config: MsGraphConfig) -> bool:
    return status in RETRY_STATUSES and attempt < config.max_retries


async def _retry_action(resp: aiohttp.ClientResponse, attempt: int,
                        refreshed: bool, config: MsGraphConfig,
                        auth: bool) -> str:
    if _should_retry(resp.status, attempt, config):
        await asyncio.sleep(_retry_delay(resp, attempt))
        return "retry"
    if (resp.status == 401 and auth and not refreshed
            and callable(config.access_token)):
        return "refresh"
    return "ok"


async def _request(config: MsGraphConfig,
                   method: str,
                   url: str,
                   *,
                   session: aiohttp.ClientSession | None = None,
                   params: dict | None = None,
                   json_body: dict | None = None,
                   data: bytes | None = None,
                   extra_headers: dict | None = None,
                   auth: bool = True,
                   read: str = "json"):
    own = session is None
    sess = session or aiohttp.ClientSession(timeout=_timeout(config))
    try:
        attempt = 0
        refreshed = False
        while True:
            hdrs = headers(config) if auth else {}
            if extra_headers:
                hdrs.update(extra_headers)
            async with sess.request(method,
                                    url,
                                    headers=hdrs,
                                    params=params,
                                    json=json_body,
                                    data=data) as resp:
                action = await _retry_action(resp, attempt, refreshed, config,
                                             auth)
                if action == "retry":
                    attempt += 1
                    continue
                if action == "refresh":
                    refreshed = True
                    continue
                await _raise_for_status(method, url, resp)
                if read == "bytes":
                    return await resp.read()
                if read == "none":
                    return None
                if read == "location":
                    return resp.headers.get("Location")
                if resp.status == 204 or resp.content_length == 0:
                    return {}
                try:
                    return await resp.json()
                except (aiohttp.ContentTypeError, ValueError):
                    return {}
    finally:
        if own:
            await sess.close()


async def graph_get(config: MsGraphConfig,
                    url: str,
                    params: dict | None = None,
                    session: aiohttp.ClientSession | None = None) -> dict:
    return await _request(config, "GET", url, params=params, session=session)


async def graph_list(
        config: MsGraphConfig,
        url: str,
        params: dict | None = None,
        session: aiohttp.ClientSession | None = None) -> list[dict]:
    items: list[dict] = []
    next_url: str | None = url
    next_params = params
    own = session is None
    sess = session or aiohttp.ClientSession(timeout=_timeout(config))
    try:
        while next_url:
            data = await _request(config,
                                  "GET",
                                  next_url,
                                  params=next_params,
                                  session=sess)
            items.extend(data.get("value", []))
            next_url = data.get("@odata.nextLink")
            next_params = None
    finally:
        if own:
            await sess.close()
    return items


async def graph_get_bytes(config: MsGraphConfig,
                          url: str,
                          range_header: str | None = None,
                          session: aiohttp.ClientSession | None = None,
                          auth: bool = True) -> bytes:
    extra = {"Range": range_header} if range_header else None
    return await _request(config,
                          "GET",
                          url,
                          extra_headers=extra,
                          session=session,
                          auth=auth,
                          read="bytes")


async def graph_stream(config: MsGraphConfig,
                       url: str,
                       chunk_size: int = 8192,
                       session: aiohttp.ClientSession | None = None,
                       auth: bool = True):
    own = session is None
    sess = session or aiohttp.ClientSession(timeout=_timeout(config))
    try:
        attempt = 0
        refreshed = False
        while True:
            hdrs = headers(config) if auth else {}
            async with sess.get(url, headers=hdrs) as resp:
                action = await _retry_action(resp, attempt, refreshed, config,
                                             auth)
                if action == "retry":
                    attempt += 1
                    continue
                if action == "refresh":
                    refreshed = True
                    continue
                await _raise_for_status("GET", url, resp)
                async for chunk in resp.content.iter_chunked(chunk_size):
                    yield chunk
                return
    finally:
        if own:
            await sess.close()


async def graph_post(config: MsGraphConfig,
                     url: str,
                     body: dict | None = None,
                     session: aiohttp.ClientSession | None = None) -> dict:
    return await _request(config,
                          "POST",
                          url,
                          json_body=body or {},
                          session=session)


async def graph_post_monitor(
        config: MsGraphConfig,
        url: str,
        body: dict | None = None,
        session: aiohttp.ClientSession | None = None) -> str | None:
    return await _request(config,
                          "POST",
                          url,
                          json_body=body or {},
                          session=session,
                          read="location")


async def graph_patch(config: MsGraphConfig,
                      url: str,
                      body: dict,
                      session: aiohttp.ClientSession | None = None) -> dict:
    return await _request(config,
                          "PATCH",
                          url,
                          json_body=body,
                          session=session)


async def graph_delete(config: MsGraphConfig,
                       url: str,
                       session: aiohttp.ClientSession | None = None) -> None:
    await _request(config, "DELETE", url, session=session, read="none")


async def graph_put_bytes(
        config: MsGraphConfig,
        url: str,
        data: bytes,
        content_type: str = "application/octet-stream",
        session: aiohttp.ClientSession | None = None) -> dict:
    return await _request(config,
                          "PUT",
                          url,
                          data=data,
                          extra_headers={"Content-Type": content_type},
                          session=session)


async def poll_monitor(url: str,
                       timeout: float,
                       interval: float = 1.0) -> dict:
    waited = 0.0
    async with aiohttp.ClientSession() as session:
        while True:
            async with session.get(url) as resp:
                if resp.status >= 400:
                    raise GraphError(resp.status, "monitorError", f"GET {url}")
                payload = await resp.json()
            status = payload.get("status")
            if status in ("completed", "failed"):
                return payload
            if waited >= timeout:
                return payload
            await asyncio.sleep(interval)
            waited += interval


async def upload_chunk(config: MsGraphConfig, upload_url: str, data: bytes,
                       start: int, total: int) -> dict:
    end = start + len(data) - 1
    hdrs = {"Content-Range": f"bytes {start}-{end}/{total}"}
    async with aiohttp.ClientSession(timeout=_timeout(config)) as session:
        attempt = 0
        while True:
            async with session.put(upload_url, headers=hdrs,
                                   data=data) as resp:
                if _should_retry(resp.status, attempt, config):
                    await asyncio.sleep(_retry_delay(resp, attempt))
                    attempt += 1
                    continue
                await _raise_for_status("PUT", upload_url, resp)
                if resp.status == 204 or resp.content_length == 0:
                    return {}
                try:
                    return await resp.json()
                except (aiohttp.ContentTypeError, ValueError):
                    return {}

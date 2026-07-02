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
from urllib.parse import quote

import aiohttp

from mirage.accessor.onedrive import OneDriveConfig
from mirage.resource.secrets import reveal_secret
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of

GRAPH_API = "https://graph.microsoft.com/v1.0"
RETRY_STATUSES = {429, 503, 504}
MAX_BACKOFF = 30.0


def split_path(path: PathSpec | str) -> tuple[str, str]:
    if isinstance(path, str):
        path = PathSpec(virtual=path,
                        directory=path,
                        resource_path=path.strip("/"))
    prefix = mount_prefix_of(path.virtual, path.resource_path) or ""
    return prefix, path.resource_path


class GraphError(RuntimeError):

    def __init__(self, status: int, code: str, message: str) -> None:
        self.status = status
        self.code = code
        super().__init__(f"Graph API error {status} ({code}): {message}")


def drive_base(config: OneDriveConfig) -> str:
    if config.drive_id:
        return f"{GRAPH_API}/drives/{config.drive_id}"
    if config.site_id:
        return f"{GRAPH_API}/sites/{config.site_id}/drive"
    return f"{GRAPH_API}/me/drive"


def _full_path(config: OneDriveConfig, path: str) -> str:
    p = path.strip("/")
    prefix = (config.key_prefix or "").strip("/")
    if prefix and p:
        return f"{prefix}/{p}"
    return prefix or p


def item_url(config: OneDriveConfig, path: str, action: str = "") -> str:
    base = drive_base(config)
    full = _full_path(config, path)
    if not full:
        return f"{base}/root{action}"
    stem = f"{base}/root:/{quote(full, safe='/')}"
    if action:
        return f"{stem}:{action}"
    return stem


def drive_ref_path(config: OneDriveConfig, folder: str = "") -> str:
    base = drive_base(config)[len(GRAPH_API):]
    if folder:
        return f"{base}/root:/{quote(folder, safe='/')}"
    return f"{base}/root:"


def _resolve_token(config: OneDriveConfig) -> str:
    token = config.access_token
    if callable(token):
        token = token()
    return reveal_secret(token)


def headers(config: OneDriveConfig) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {_resolve_token(config)}",
        "Content-Type": "application/json",
    }


def _timeout(config: OneDriveConfig) -> aiohttp.ClientTimeout:
    return aiohttp.ClientTimeout(total=config.timeout)


def new_session(config: OneDriveConfig) -> aiohttp.ClientSession:
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
            pass
    return min(2.0**attempt, MAX_BACKOFF)


def _should_retry(status: int, attempt: int, config: OneDriveConfig) -> bool:
    return status in RETRY_STATUSES and attempt < config.max_retries


async def _retry_action(resp: aiohttp.ClientResponse, attempt: int,
                        refreshed: bool, config: OneDriveConfig,
                        auth: bool) -> str:
    if _should_retry(resp.status, attempt, config):
        await asyncio.sleep(_retry_delay(resp, attempt))
        return "retry"
    if (resp.status == 401 and auth and not refreshed
            and callable(config.access_token)):
        return "refresh"
    return "ok"


async def _request(config: OneDriveConfig,
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


async def graph_get(config: OneDriveConfig,
                    url: str,
                    params: dict | None = None,
                    session: aiohttp.ClientSession | None = None) -> dict:
    return await _request(config, "GET", url, params=params, session=session)


async def graph_list(
        config: OneDriveConfig,
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


async def graph_get_bytes(config: OneDriveConfig,
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


async def graph_stream(config: OneDriveConfig,
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


async def graph_post(config: OneDriveConfig,
                     url: str,
                     body: dict | None = None,
                     session: aiohttp.ClientSession | None = None) -> dict:
    return await _request(config,
                          "POST",
                          url,
                          json_body=body or {},
                          session=session)


async def graph_post_monitor(
        config: OneDriveConfig,
        url: str,
        body: dict | None = None,
        session: aiohttp.ClientSession | None = None) -> str | None:
    return await _request(config,
                          "POST",
                          url,
                          json_body=body or {},
                          session=session,
                          read="location")


async def graph_patch(config: OneDriveConfig,
                      url: str,
                      body: dict,
                      session: aiohttp.ClientSession | None = None) -> dict:
    return await _request(config,
                          "PATCH",
                          url,
                          json_body=body,
                          session=session)


async def graph_delete(config: OneDriveConfig,
                       url: str,
                       session: aiohttp.ClientSession | None = None) -> None:
    await _request(config, "DELETE", url, session=session, read="none")


async def graph_put_bytes(
        config: OneDriveConfig,
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


async def upload_chunk(config: OneDriveConfig, upload_url: str, data: bytes,
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

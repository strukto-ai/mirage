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
from collections.abc import AsyncIterator, Mapping
from functools import partial
from typing import Protocol
from urllib.parse import quote

import aiohttp

from mirage.core.api.client import (ApiResponse, RetryPolicy, api_request,
                                    header_delay)
from mirage.core.databricks_volume.errors import (DatabricksVolumeApiError,
                                                  DatabricksVolumeAuthError)
from mirage.core.databricks_volume.types import (DatabricksEntry,
                                                 DatabricksFileMeta)
from mirage.resource.databricks_volume.config import DatabricksVolumeConfig
from mirage.resource.secrets import reveal_secret
from mirage.types import JsonValue
from mirage.utils.ranges import ByteWindow

FILES = "files"
DIRECTORIES = "directories"
OCTET_STREAM = "application/octet-stream"

# Databricks answers an over-quota or unavailable workspace with a
# Retry-After, so the wait comes from the header rather than from a
# body field. 401 is deliberately absent: the token is the one the
# config carries, so a replay would send the same refused credential
# again, and for a write it would send the write twice (msgraph's
# single 401 replay exists because it can re-mint; mirage cannot).
RETRY = RetryPolicy(statuses=frozenset({429, 503}), max_retries=3)


def error_from_response(method: str, url: str, resp: aiohttp.ClientResponse,
                        text: str) -> Exception:
    """Map a failed Files API answer onto the backend's own error.

    Args:
        method (str): the HTTP method that was sent.
        url (str): the URL that was sent.
        resp (aiohttp.ClientResponse): the >= 400 response.
        text (str): the response body, empty for a HEAD.
    """
    return databricks_error(method, url, resp.status, text)


def databricks_error(method: str, url: str, status: int,
                     text: str) -> DatabricksVolumeApiError:
    """The same mapping for a reader that holds no response object.

    Args:
        method (str): the HTTP method that was sent.
        url (str): the URL that was sent.
        status (int): the response status.
        text (str): the response body, empty for a HEAD.
    """
    error_code: str | None = None
    message = text
    try:
        data = json.loads(text)
    except ValueError:
        data = None
    if isinstance(data, dict):
        code = data.get("error_code")
        error_code = code if isinstance(code, str) else None
        detail = data.get("message")
        message = detail if isinstance(detail, str) else text
    rendered = f"databricks_volume: {method} {url} → {status} {message}"
    # A refused credential is its own type, because it is the one
    # failure the application can act on: obtain a fresh token and
    # rebuild the resource. Nothing here retries or replays.
    if status == 401:
        return DatabricksVolumeAuthError(rendered, status, error_code)
    return DatabricksVolumeApiError(rendered, status, error_code)


def _entry_of(raw: Mapping[str, "JsonValue"]) -> DatabricksEntry:
    size = raw.get("file_size")
    modified = raw.get("last_modified")
    return DatabricksEntry(
        path=str(raw.get("path", "")),
        is_directory=bool(raw.get("is_directory", False)),
        file_size=size if isinstance(size, int) else None,
        last_modified=modified if isinstance(modified, (int, str)) else None,
    )


def _meta_of(headers: Mapping[str, str]) -> DatabricksFileMeta:
    length = headers.get("content-length")
    return DatabricksFileMeta(
        content_length=int(length) if length else None,
        content_type=headers.get("content-type"),
        last_modified=headers.get("last-modified"),
    )


class DatabricksFilesClient(Protocol):
    """The Files API surface every databricks_volume op reaches through.

    Paths are absolute backend paths inside the volume
    (``/Volumes/<catalog>/<schema>/<volume>/...``), which is what the
    endpoints take verbatim.
    """

    async def download(self,
                       path: str,
                       window: ByteWindow | None = None) -> bytes:
        ...

    def download_stream(self, path: str,
                        chunk_size: int) -> AsyncIterator[bytes]:
        ...

    async def get_metadata(self, path: str) -> DatabricksFileMeta:
        ...

    async def get_directory_metadata(self, path: str) -> None:
        ...

    async def list_directory(self, path: str) -> list[DatabricksEntry]:
        ...

    async def upload(self, path: str, data: bytes) -> None:
        ...

    async def delete(self, path: str) -> None:
        ...

    async def create_directory(self, path: str) -> None:
        ...

    async def delete_directory(self, path: str) -> None:
        ...


class HttpDatabricksFilesClient:
    """The Files API over aiohttp."""

    def __init__(self, config: DatabricksVolumeConfig) -> None:
        """Bind a client to one volume's workspace.

        Args:
            config (DatabricksVolumeConfig): location, credential and
                transport settings.
        """
        self.config = config

    def url(self, endpoint: str, remote_path: str) -> str:
        """The Files API URL for one backend path.

        ``quote`` with its default ``safe="/"`` escapes each segment and
        keeps the separators, which is what the SDK's
        ``_escape_multi_segment_path_parameter`` and the TypeScript
        per-segment ``encodeURIComponent`` both produce.

        Args:
            endpoint (str): ``files`` or ``directories``.
            remote_path (str): absolute path inside the volume.
        """
        return (f"{self.config.host}/api/2.0/fs/{endpoint}"
                f"{quote(remote_path)}")

    def _headers(self,
                 extra: Mapping[str, str] | None = None) -> dict[str, str]:
        token = reveal_secret(self.config.token)
        headers = {"Authorization": f"Bearer {token}"}
        if extra:
            headers.update(extra)
        return headers

    def _timeout(self) -> aiohttp.ClientTimeout:
        return aiohttp.ClientTimeout(total=self.config.timeout)

    async def download(self,
                       path: str,
                       window: ByteWindow | None = None) -> bytes:
        url = self.url(FILES, path)
        data: bytes = await api_request(
            "GET",
            url,
            error_of=partial(error_from_response, "GET", url),
            headers=self._headers({"Accept": OCTET_STREAM}),
            retry=RETRY,
            read="bytes",
            window=window,
            timeout=self._timeout())
        return data

    async def download_stream(self, path: str,
                              chunk_size: int) -> AsyncIterator[bytes]:
        """Stream a file, one chunk at a time.

        The shared kit reads a whole body, so a streaming read owns its
        session the way dropbox's does. RETRY still applies, but only to
        the open, which is the same shape msgraph's stream has: a
        throttled GET has yielded nothing, so another attempt is a
        repeat of the whole read, while a failure mid-body cannot be
        retried without handing the caller the leading bytes twice.

        Args:
            path (str): absolute path inside the volume.
            chunk_size (int): bytes per yielded chunk.
        """
        url = self.url(FILES, path)
        headers = self._headers({"Accept": OCTET_STREAM})
        async with aiohttp.ClientSession(timeout=self._timeout()) as session:
            attempt = 0
            while True:
                async with session.get(url, headers=headers) as resp:
                    if (resp.status in RETRY.statuses
                            and attempt < RETRY.max_retries):
                        await asyncio.sleep(header_delay(resp, attempt, RETRY))
                        attempt += 1
                        continue
                    if resp.status >= 400:
                        raise databricks_error("GET", url, resp.status, await
                                               resp.text())
                    async for chunk in resp.content.iter_chunked(chunk_size):
                        yield chunk
                    return

    async def get_metadata(self, path: str) -> DatabricksFileMeta:
        url = self.url(FILES, path)
        response: ApiResponse = await api_request("HEAD",
                                                  url,
                                                  error_of=partial(
                                                      error_from_response,
                                                      "HEAD", url),
                                                  headers=self._headers(),
                                                  retry=RETRY,
                                                  read="response",
                                                  timeout=self._timeout())
        return _meta_of(response.headers)

    async def get_directory_metadata(self, path: str) -> None:
        url = self.url(DIRECTORIES, path)
        await api_request("HEAD",
                          url,
                          error_of=partial(error_from_response, "HEAD", url),
                          headers=self._headers(),
                          retry=RETRY,
                          read="none",
                          timeout=self._timeout())

    async def list_directory(self, path: str) -> list[DatabricksEntry]:
        url = self.url(DIRECTORIES, path)
        entries: list[DatabricksEntry] = []
        page_token: str | None = None
        while True:
            params = {"page_token": page_token} if page_token else None
            page = await api_request("GET",
                                     url,
                                     error_of=partial(error_from_response,
                                                      "GET", url),
                                     headers=self._headers(),
                                     params=params,
                                     retry=RETRY,
                                     read="json",
                                     timeout=self._timeout())
            body = page if isinstance(page, dict) else {}
            contents = body.get("contents")
            if isinstance(contents, list):
                entries.extend(
                    _entry_of(raw) for raw in contents
                    if isinstance(raw, Mapping))
            token = body.get("next_page_token")
            page_token = token if isinstance(token, str) and token else None
            if page_token is None:
                return entries

    async def upload(self, path: str, data: bytes) -> None:
        url = self.url(FILES, path)
        await api_request("PUT",
                          url,
                          error_of=partial(error_from_response, "PUT", url),
                          headers=self._headers({"Content-Type":
                                                 OCTET_STREAM}),
                          params={"overwrite": "true"},
                          data=data,
                          retry=RETRY,
                          read="none",
                          timeout=self._timeout())

    async def delete(self, path: str) -> None:
        url = self.url(FILES, path)
        await api_request("DELETE",
                          url,
                          error_of=partial(error_from_response, "DELETE", url),
                          headers=self._headers(),
                          retry=RETRY,
                          read="none",
                          timeout=self._timeout())

    async def create_directory(self, path: str) -> None:
        url = self.url(DIRECTORIES, path)
        await api_request("PUT",
                          url,
                          error_of=partial(error_from_response, "PUT", url),
                          headers=self._headers(),
                          retry=RETRY,
                          read="none",
                          timeout=self._timeout())

    async def delete_directory(self, path: str) -> None:
        url = self.url(DIRECTORIES, path)
        await api_request("DELETE",
                          url,
                          error_of=partial(error_from_response, "DELETE", url),
                          headers=self._headers(),
                          retry=RETRY,
                          read="none",
                          timeout=self._timeout())

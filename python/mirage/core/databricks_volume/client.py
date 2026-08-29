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

import inspect
import json
from collections.abc import AsyncIterator, Mapping
from functools import partial
from typing import Protocol
from urllib.parse import quote

import aiohttp

from mirage.core.api.client import ApiResponse, RetryPolicy, api_request
from mirage.core.databricks_volume.errors import DatabricksVolumeApiError
from mirage.core.databricks_volume.types import (DatabricksEntry,
                                                 DatabricksFileMeta)
from mirage.resource.databricks_volume.config import DatabricksVolumeConfig
from mirage.resource.databricks_volume.token_provider import TokenProvider
from mirage.types import JsonValue
from mirage.utils.ranges import ByteWindow

FILES = "files"
DIRECTORIES = "directories"
OCTET_STREAM = "application/octet-stream"

# Databricks answers an over-quota or unavailable workspace with a
# Retry-After, so the wait comes from the header rather than from a
# body field. 401 is deliberately absent: a token is resolved fresh per
# operation and an on-behalf-of provider cannot re-mint one, so a
# refused call is reported rather than replayed (msgraph's single 401
# replay would also re-send a write, which must never happen).
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
    return DatabricksVolumeApiError(
        f"databricks_volume: {method} {url} → {status} {message}", status,
        error_code)


async def resolve_token(provider: TokenProvider) -> str:
    """The bearer token for one operation, awaited when async.

    Args:
        provider (TokenProvider): the application's token source.

    Raises:
        ValueError: the provider answered with something that is not a
            usable token; sending ``Bearer `` alone would come back as
            an opaque 401 instead.
    """
    token = provider.get_token()
    if inspect.isawaitable(token):
        token = await token
    if not isinstance(token, str) or not token:
        raise ValueError(
            "databricks_volume: token provider returned an empty token")
    return token


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
    """The Files API over aiohttp, one token resolution per operation."""

    def __init__(self, config: DatabricksVolumeConfig,
                 token_provider: TokenProvider) -> None:
        """Bind a client to one volume's workspace and token source.

        Args:
            config (DatabricksVolumeConfig): location and transport
                settings; it holds no credential.
            token_provider (TokenProvider): consulted before each
                operation. The token is never stored on the client.
        """
        self.config = config
        self.token_provider = token_provider

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

    async def _headers(self,
                       extra: Mapping[str, str] | None = None
                       ) -> dict[str, str]:
        token = await resolve_token(self.token_provider)
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
            headers=await self._headers({"Accept": OCTET_STREAM}),
            retry=RETRY,
            read="bytes",
            window=window,
            timeout=self._timeout())
        return data

    async def download_stream(self, path: str,
                              chunk_size: int) -> AsyncIterator[bytes]:
        """Stream a file, one chunk at a time.

        The shared kit reads a whole body, so a streaming read owns its
        session the way dropbox's does.

        Args:
            path (str): absolute path inside the volume.
            chunk_size (int): bytes per yielded chunk.
        """
        url = self.url(FILES, path)
        headers = await self._headers({"Accept": OCTET_STREAM})
        async with aiohttp.ClientSession(timeout=self._timeout()) as session:
            async with session.get(url, headers=headers) as resp:
                if resp.status >= 400:
                    raise databricks_error("GET", url, resp.status, await
                                           resp.text())
                async for chunk in resp.content.iter_chunked(chunk_size):
                    yield chunk

    async def get_metadata(self, path: str) -> DatabricksFileMeta:
        url = self.url(FILES, path)
        response: ApiResponse = await api_request(
            "HEAD",
            url,
            error_of=partial(error_from_response, "HEAD", url),
            headers=await self._headers(),
            retry=RETRY,
            read="response",
            timeout=self._timeout())
        return _meta_of(response.headers)

    async def get_directory_metadata(self, path: str) -> None:
        url = self.url(DIRECTORIES, path)
        await api_request("HEAD",
                          url,
                          error_of=partial(error_from_response, "HEAD", url),
                          headers=await self._headers(),
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
                                     headers=await self._headers(),
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
                          headers=await
                          self._headers({"Content-Type": OCTET_STREAM}),
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
                          headers=await self._headers(),
                          retry=RETRY,
                          read="none",
                          timeout=self._timeout())

    async def create_directory(self, path: str) -> None:
        url = self.url(DIRECTORIES, path)
        await api_request("PUT",
                          url,
                          error_of=partial(error_from_response, "PUT", url),
                          headers=await self._headers(),
                          retry=RETRY,
                          read="none",
                          timeout=self._timeout())

    async def delete_directory(self, path: str) -> None:
        url = self.url(DIRECTORIES, path)
        await api_request("DELETE",
                          url,
                          error_of=partial(error_from_response, "DELETE", url),
                          headers=await self._headers(),
                          retry=RETRY,
                          read="none",
                          timeout=self._timeout())

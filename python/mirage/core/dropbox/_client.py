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
import time
from collections.abc import AsyncIterator
from typing import Any

import aiohttp

from mirage.resource.dropbox.config import DropboxConfig
from mirage.resource.secrets import reveal_secret

DROPBOX_TOKEN_URL = "https://api.dropboxapi.com/oauth2/token"
DROPBOX_API_BASE = "https://api.dropboxapi.com/2"
DROPBOX_CONTENT_BASE = "https://content.dropboxapi.com/2"
TOKEN_BUFFER_SECONDS = 300


class DropboxApiError(RuntimeError):

    def __init__(self,
                 message: str,
                 status: int | None = None,
                 summary: str = "") -> None:
        super().__init__(message)
        self.status = status
        # Dropbox error_summary, e.g. "path/not_found/.." or
        # "path/conflict/folder/..".
        self.summary = summary


def summary_of(text: str) -> str:
    try:
        return json.loads(text).get("error_summary", "")
    except ValueError:
        return ""


def _token_url(config: DropboxConfig) -> str:
    if not config.endpoint:
        return DROPBOX_TOKEN_URL
    return f"{config.endpoint.rstrip('/')}/oauth2/token"


async def refresh_access_token(config: DropboxConfig) -> tuple[str, int]:
    body = {
        "grant_type": "refresh_token",
        "refresh_token": reveal_secret(config.refresh_token),
        "client_id": config.client_id,
    }
    secret = reveal_secret(config.client_secret)
    if secret:
        body["client_secret"] = secret
    async with aiohttp.ClientSession() as session:
        async with session.post(_token_url(config), data=body) as resp:
            text = await resp.text()
            if resp.status >= 400:
                raise DropboxApiError(
                    f"Dropbox token refresh → {resp.status} {text}",
                    resp.status)
            data = json.loads(text)
    return data["access_token"], int(data["expires_in"])


class DropboxTokenManager:
    """Caches the short-lived access token, refreshing before expiry."""

    def __init__(self, config: DropboxConfig) -> None:
        self._config = config
        self._access_token: str | None = None
        self._expires_at: float = 0
        self._lock = asyncio.Lock()
        if config.endpoint:
            base = f"{config.endpoint.rstrip('/')}/2"
            self.api_base = base
            self.content_base = base
        else:
            self.api_base = DROPBOX_API_BASE
            self.content_base = DROPBOX_CONTENT_BASE

    async def get_token(self) -> str:
        async with self._lock:
            if self._access_token and time.time() < self._expires_at:
                return self._access_token
            token, expires_in = await refresh_access_token(self._config)
            self._access_token = token
            self._expires_at = (time.time() + expires_in -
                                TOKEN_BUFFER_SECONDS)
            return self._access_token


async def dropbox_auth_headers(tm: DropboxTokenManager) -> dict[str, str]:
    token = await tm.get_token()
    return {"Authorization": f"Bearer {token}"}


async def dropbox_rpc(
    tm: DropboxTokenManager,
    endpoint: str,
    body: dict[str, Any],
) -> dict[str, Any]:
    headers = await dropbox_auth_headers(tm)
    url = f"{tm.api_base}{endpoint}"
    async with aiohttp.ClientSession() as session:
        async with session.post(url, headers=headers, json=body) as resp:
            text = await resp.text()
            if resp.status >= 400:
                raise DropboxApiError(
                    f"Dropbox POST {endpoint} → {resp.status} {text}",
                    resp.status, summary_of(text))
    return json.loads(text)


async def dropbox_upload(tm: DropboxTokenManager, path: str,
                         data: bytes) -> None:
    headers = await dropbox_auth_headers(tm)
    headers["Dropbox-API-Arg"] = json.dumps({
        "path": path,
        "mode": "overwrite",
        "mute": True,
    })
    headers["Content-Type"] = "application/octet-stream"
    url = f"{tm.content_base}/files/upload"
    async with aiohttp.ClientSession() as session:
        async with session.post(url, headers=headers, data=data) as resp:
            if resp.status >= 400:
                text = await resp.text()
                raise DropboxApiError(
                    f"Dropbox upload {path} → {resp.status} {text}",
                    resp.status, summary_of(text))


async def dropbox_download(tm: DropboxTokenManager, path: str) -> bytes:
    headers = await dropbox_auth_headers(tm)
    headers["Dropbox-API-Arg"] = json.dumps({"path": path})
    url = f"{tm.content_base}/files/download"
    async with aiohttp.ClientSession() as session:
        async with session.post(url, headers=headers) as resp:
            if resp.status >= 400:
                text = await resp.text()
                raise DropboxApiError(
                    f"Dropbox download {path} → {resp.status} {text}",
                    resp.status)
            return await resp.read()


async def dropbox_download_stream(
    tm: DropboxTokenManager,
    path: str,
    chunk_size: int = 65536,
) -> AsyncIterator[bytes]:
    headers = await dropbox_auth_headers(tm)
    headers["Dropbox-API-Arg"] = json.dumps({"path": path})
    url = f"{tm.content_base}/files/download"
    async with aiohttp.ClientSession() as session:
        async with session.post(url, headers=headers) as resp:
            if resp.status >= 400:
                text = await resp.text()
                raise DropboxApiError(
                    f"Dropbox download {path} → {resp.status} {text}",
                    resp.status)
            async for chunk in resp.content.iter_chunked(chunk_size):
                yield chunk

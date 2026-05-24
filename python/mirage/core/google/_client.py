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
import time
from collections.abc import AsyncIterator

import aiohttp

from mirage.core.google.config import GoogleConfig
from mirage.resource.secrets import reveal_secret

TOKEN_URL = "https://oauth2.googleapis.com/token"
DRIVE_API_BASE = "https://www.googleapis.com/drive/v3"
DOCS_API_BASE = "https://docs.googleapis.com/v1"
SLIDES_API_BASE = "https://slides.googleapis.com/v1"
SHEETS_API_BASE = "https://sheets.googleapis.com/v4"
GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1"
TOKEN_BUFFER_SECONDS = 300


async def refresh_access_token(config: GoogleConfig, ) -> tuple[str, int]:
    """Exchange refresh token for a new access token.

    Args:
        config (GoogleConfig): OAuth2 credentials.

    Returns:
        tuple[str, int]: (access_token, expires_in_seconds)
    """
    data = {
        "client_id": config.client_id,
        "refresh_token": reveal_secret(config.refresh_token),
        "grant_type": "refresh_token",
    }
    client_secret = reveal_secret(config.client_secret)
    if client_secret:
        data["client_secret"] = client_secret
    async with aiohttp.ClientSession() as session:
        async with session.post(TOKEN_URL, data=data) as resp:
            resp.raise_for_status()
            body = await resp.json()
            return body["access_token"], body["expires_in"]


class TokenManager:
    """Manages OAuth2 access token lifecycle."""

    def __init__(self, config: GoogleConfig) -> None:
        self._config = config
        self._access_token: str | None = None
        self._expires_at: float = 0
        self._lock = asyncio.Lock()

    async def get_token(self) -> str:
        async with self._lock:
            if self._access_token and time.time() < self._expires_at:
                return self._access_token
            token, expires_in = await refresh_access_token(self._config)
            self._access_token = token
            self._expires_at = (time.time() + expires_in -
                                TOKEN_BUFFER_SECONDS)
            return self._access_token


async def google_headers(token_manager: TokenManager, ) -> dict[str, str]:
    token = await token_manager.get_token()
    return {"Authorization": f"Bearer {token}"}


async def google_get(
    token_manager: TokenManager,
    url: str,
    params: dict | None = None,
) -> dict:
    headers = await google_headers(token_manager)
    async with aiohttp.ClientSession() as session:
        async with session.get(url, headers=headers, params=params) as resp:
            resp.raise_for_status()
            return await resp.json()


async def google_post(
    token_manager: TokenManager,
    url: str,
    json: dict,
) -> dict:
    headers = await google_headers(token_manager)
    async with aiohttp.ClientSession() as session:
        async with session.post(url, headers=headers, json=json) as resp:
            resp.raise_for_status()
            return await resp.json()


async def google_put(
    token_manager: TokenManager,
    url: str,
    json: dict,
) -> dict:
    headers = await google_headers(token_manager)
    async with aiohttp.ClientSession() as session:
        async with session.put(url, headers=headers, json=json) as resp:
            resp.raise_for_status()
            return await resp.json()


async def google_delete(
    token_manager: TokenManager,
    url: str,
) -> None:
    headers = await google_headers(token_manager)
    async with aiohttp.ClientSession() as session:
        async with session.delete(url, headers=headers) as resp:
            resp.raise_for_status()


async def google_get_bytes(
    token_manager: TokenManager,
    url: str,
) -> bytes:
    headers = await google_headers(token_manager)
    async with aiohttp.ClientSession() as session:
        async with session.get(url, headers=headers) as resp:
            resp.raise_for_status()
            return await resp.read()


async def google_get_stream(
    token_manager: TokenManager,
    url: str,
    chunk_size: int = 8192,
) -> AsyncIterator[bytes]:
    """Stream bytes from a Google API endpoint.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        url (str): API URL.
        chunk_size (int): chunk size in bytes.
    """
    headers = await google_headers(token_manager)
    async with aiohttp.ClientSession() as session:
        async with session.get(url, headers=headers) as resp:
            resp.raise_for_status()
            async for chunk in resp.content.iter_chunked(chunk_size):
                yield chunk

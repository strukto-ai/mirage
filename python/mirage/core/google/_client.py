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
from typing import Any

import aiohttp

from mirage.core.google.config import GoogleConfig
from mirage.resource.secrets import reveal_secret

TOKEN_URL = "https://oauth2.googleapis.com/token"
DRIVE_API_BASE = "https://www.googleapis.com/drive/v3"
DOCS_API_BASE = "https://docs.googleapis.com/v1"
SLIDES_API_BASE = "https://slides.googleapis.com/v1"
SHEETS_API_BASE = "https://sheets.googleapis.com/v4"
GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1"
DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3"
TOKEN_BUFFER_SECONDS = 300


def token_url() -> str:
    return TOKEN_URL


def drive_base(_token_manager: "TokenManager") -> str:
    return DRIVE_API_BASE


def drive_upload_base(_token_manager: "TokenManager") -> str:
    return DRIVE_UPLOAD_BASE


def docs_base(_token_manager: "TokenManager") -> str:
    return DOCS_API_BASE


def slides_base(_token_manager: "TokenManager") -> str:
    return SLIDES_API_BASE


def sheets_base(_token_manager: "TokenManager") -> str:
    return SHEETS_API_BASE


def gmail_base(_token_manager: "TokenManager") -> str:
    return GMAIL_API_BASE


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
        async with session.post(token_url(), data=data) as resp:
            resp.raise_for_status()
            body = await resp.json()
            return body["access_token"], body["expires_in"]


class TokenManager:
    """Manages OAuth2 access token lifecycle."""

    def __init__(self, config: GoogleConfig) -> None:
        self.config = config
        self._access_token: str | None = None
        self._expires_at: float = 0
        self._lock = asyncio.Lock()

    async def get_token(self) -> str:
        async with self._lock:
            if self._access_token and time.time() < self._expires_at:
                return self._access_token
            token, expires_in = await refresh_access_token(self.config)
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
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    headers = await google_headers(token_manager)
    async with aiohttp.ClientSession() as session:
        async with session.get(url, headers=headers, params=params) as resp:
            resp.raise_for_status()
            return await resp.json()


async def google_post(
    token_manager: TokenManager,
    url: str,
    json: dict[str, Any],
) -> dict[str, Any]:
    headers = await google_headers(token_manager)
    async with aiohttp.ClientSession() as session:
        async with session.post(url, headers=headers, json=json) as resp:
            resp.raise_for_status()
            return await resp.json()


async def google_put(
    token_manager: TokenManager,
    url: str,
    json: dict[str, Any],
) -> dict[str, Any]:
    headers = await google_headers(token_manager)
    async with aiohttp.ClientSession() as session:
        async with session.put(url, headers=headers, json=json) as resp:
            resp.raise_for_status()
            return await resp.json()


async def google_patch(
    token_manager: TokenManager,
    url: str,
    json: dict[str, Any],
    params: dict[str, str] | None = None,
) -> dict[str, Any]:
    headers = await google_headers(token_manager)
    async with aiohttp.ClientSession() as session:
        async with session.patch(url,
                                 headers=headers,
                                 json=json,
                                 params=params) as resp:
            resp.raise_for_status()
            return await resp.json()


async def google_send_bytes(
    token_manager: TokenManager,
    method: str,
    url: str,
    data: bytes,
    content_type: str,
    params: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Send a raw byte payload (upload endpoints) and return the JSON reply.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        method (str): HTTP method ("POST" or "PATCH").
        url (str): API URL.
        data (bytes): request body.
        content_type (str): Content-Type header for the body.
        params (dict | None): query parameters.
    """
    headers = await google_headers(token_manager)
    headers["Content-Type"] = content_type
    async with aiohttp.ClientSession() as session:
        async with session.request(method,
                                   url,
                                   headers=headers,
                                   data=data,
                                   params=params) as resp:
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

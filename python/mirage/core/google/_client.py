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


def google_error_message(body: str, status: int, reason: str | None) -> str:
    """Pull Google's own error text out of an error response body.

    Google reports why a call failed in the body, in one of two shapes: the
    APIs use ``{"error": {"message": ...}}`` and the OAuth token endpoint
    uses a flat ``{"error": ..., "error_description": ...}``. Falls back to
    the raw body, then to the HTTP reason phrase.

    Args:
        body (str): the raw response body.
        status (int): HTTP status code.
        reason (str | None): HTTP reason phrase, the last resort.
    """
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, dict):
        error = parsed.get("error")
        if isinstance(error, dict) and isinstance(error.get("message"), str):
            return str(error["message"])
        if isinstance(error, str):
            description = parsed.get("error_description")
            return f"{error}: {description}" if description else error
    return body.strip() or reason or f"HTTP {status}"


async def raise_for_google_status(resp: aiohttp.ClientResponse) -> None:
    """Raise with Google's message instead of the bare HTTP reason phrase.

    ``resp.raise_for_status()`` raises before anything reads the body, so
    the reason Google gave is discarded and the caller only ever sees
    "Bad Request". An agent cannot correct an error it cannot read, so the
    body is read first and its message becomes the exception's. The
    exception type is unchanged, since callers classify on it (a 403 during
    a mutation becomes EACCES in ``gdrive/resolve.py``).

    Args:
        resp (aiohttp.ClientResponse): the response to check.
    """
    if resp.status < 400:
        return
    raw = await resp.read()
    raise aiohttp.ClientResponseError(
        resp.request_info,
        resp.history,
        status=resp.status,
        message=google_error_message(raw.decode("utf-8", errors="replace"),
                                     resp.status, resp.reason),
        headers=resp.headers,
    )


def token_url(config: GoogleConfig) -> str:
    return f"{config.api_base}/token" if config.api_base else TOKEN_URL


def drive_base(token_manager: "TokenManager") -> str:
    base = token_manager.config.api_base
    return f"{base}/drive/v3" if base else DRIVE_API_BASE


def drive_upload_base(token_manager: "TokenManager") -> str:
    base = token_manager.config.api_base
    return f"{base}/upload/drive/v3" if base else DRIVE_UPLOAD_BASE


def docs_base(token_manager: "TokenManager") -> str:
    base = token_manager.config.api_base
    return f"{base}/v1" if base else DOCS_API_BASE


def slides_base(token_manager: "TokenManager") -> str:
    base = token_manager.config.api_base
    return f"{base}/v1" if base else SLIDES_API_BASE


def sheets_base(token_manager: "TokenManager") -> str:
    base = token_manager.config.api_base
    return f"{base}/v4" if base else SHEETS_API_BASE


def gmail_base(token_manager: "TokenManager") -> str:
    base = token_manager.config.api_base
    return f"{base}/gmail/v1" if base else GMAIL_API_BASE


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
        async with session.post(token_url(config), data=data) as resp:
            await raise_for_google_status(resp)
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
            await raise_for_google_status(resp)
            return await resp.json()


async def google_post(
    token_manager: TokenManager,
    url: str,
    json: dict[str, Any],
) -> dict[str, Any]:
    headers = await google_headers(token_manager)
    async with aiohttp.ClientSession() as session:
        async with session.post(url, headers=headers, json=json) as resp:
            await raise_for_google_status(resp)
            return await resp.json()


async def google_put(
    token_manager: TokenManager,
    url: str,
    json: dict[str, Any],
) -> dict[str, Any]:
    headers = await google_headers(token_manager)
    async with aiohttp.ClientSession() as session:
        async with session.put(url, headers=headers, json=json) as resp:
            await raise_for_google_status(resp)
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
            await raise_for_google_status(resp)
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
            await raise_for_google_status(resp)
            return await resp.json()


async def google_delete(
    token_manager: TokenManager,
    url: str,
) -> None:
    headers = await google_headers(token_manager)
    async with aiohttp.ClientSession() as session:
        async with session.delete(url, headers=headers) as resp:
            await raise_for_google_status(resp)


async def google_get_bytes(
    token_manager: TokenManager,
    url: str,
    range_header: str | None = None,
) -> bytes:
    """GET a URL as raw bytes, optionally only a byte range of it.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        url (str): API URL.
        range_header (str | None): an HTTP ``Range`` value, or None for
            the whole body.
    """
    headers = await google_headers(token_manager)
    if range_header:
        headers["Range"] = range_header
    async with aiohttp.ClientSession() as session:
        async with session.get(url, headers=headers) as resp:
            await raise_for_google_status(resp)
            return await resp.read()

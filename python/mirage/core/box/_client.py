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

from mirage.core.box.config import BoxConfig
from mirage.resource.secrets import reveal_secret

BOX_TOKEN_URL = "https://api.box.com/oauth2/token"
BOX_API_BASE = "https://api.box.com/2.0"
TOKEN_BUFFER_SECONDS = 300


def token_url_of(config: BoxConfig) -> str:
    if config.endpoint:
        return config.endpoint.rstrip("/") + "/oauth2/token"
    return BOX_TOKEN_URL


def api_base_of(config: BoxConfig) -> str:
    if config.endpoint:
        return config.endpoint.rstrip("/") + "/2.0"
    return BOX_API_BASE


class BoxApiError(RuntimeError):

    def __init__(self, message: str, status: int) -> None:
        self.status = status
        super().__init__(message)


async def refresh_access_token(
        config: BoxConfig, current_refresh_token: str) -> tuple[str, str, int]:
    """Exchange the refresh token for a new access token.

    Args:
        config (BoxConfig): Box OAuth credentials.
        current_refresh_token (str): latest refresh token (Box rotates it).

    Returns:
        tuple[str, str, int]: (access_token, refresh_token, expires_in).
    """
    if not config.client_id:
        raise BoxApiError("refresh_access_token: client_id is required", 400)
    data = {
        "grant_type": "refresh_token",
        "refresh_token": current_refresh_token,
        "client_id": config.client_id,
    }
    client_secret = reveal_secret(config.client_secret)
    if client_secret:
        data["client_secret"] = client_secret
    async with aiohttp.ClientSession() as session:
        async with session.post(token_url_of(config), data=data) as resp:
            if resp.status >= 400:
                text = await resp.text()
                raise BoxApiError(
                    f"Box token refresh -> {resp.status} {text}",
                    resp.status,
                )
            body = await resp.json()
            return (body["access_token"], body["refresh_token"],
                    body["expires_in"])


async def fetch_ccg_token(config: BoxConfig) -> tuple[str, int]:
    """Mint a client-credentials token for the app's service account.

    Args:
        config (BoxConfig): Box CCG credentials (client + enterprise).

    Returns:
        tuple[str, int]: (access_token, expires_in).
    """
    if not config.client_id:
        raise BoxApiError("fetch_ccg_token: client_id is required", 400)
    client_secret = reveal_secret(config.client_secret)
    if not client_secret:
        raise BoxApiError("fetch_ccg_token: client_secret is required", 400)
    data = {
        "grant_type": "client_credentials",
        "client_id": config.client_id,
        "client_secret": client_secret,
        "box_subject_type": "enterprise",
        "box_subject_id": config.enterprise_id or "",
    }
    async with aiohttp.ClientSession() as session:
        async with session.post(token_url_of(config), data=data) as resp:
            if resp.status >= 400:
                text = await resp.text()
                raise BoxApiError(f"Box CCG token -> {resp.status} {text}",
                                  resp.status)
            body = await resp.json()
            return body["access_token"], body["expires_in"]


class BoxTokenManager:
    """Manages Box access-token lifecycle across the three auth modes."""

    def __init__(self, config: BoxConfig) -> None:
        self._config = config
        # API base for all non-token calls; api.py reads this instead of the
        # BOX_API_BASE const so a config endpoint override reaches every
        # request.
        self.api_base = api_base_of(config)
        self._dev_token_mode = bool(reveal_secret(config.access_token))
        self._ccg_mode = not self._dev_token_mode and bool(
            config.enterprise_id)
        if self._ccg_mode:
            if not config.client_id:
                raise ValueError(
                    "BoxTokenManager: client_id is required when using "
                    "enterprise_id")
            if not reveal_secret(config.client_secret):
                raise ValueError(
                    "BoxTokenManager: client_secret is required when using "
                    "enterprise_id")
        elif not self._dev_token_mode:
            if not reveal_secret(config.refresh_token):
                raise ValueError(
                    "BoxTokenManager: provide access_token (developer "
                    "token), client_id + client_secret + enterprise_id "
                    "(client credentials), or client_id + refresh_token "
                    "(OAuth)")
            if not config.client_id:
                raise ValueError(
                    "BoxTokenManager: client_id is required when using "
                    "refresh_token")
        self._current_refresh_token = reveal_secret(config.refresh_token) or ""
        self._access_token: str | None = None
        self._expires_at: float = 0
        self._lock = asyncio.Lock()
        if self._dev_token_mode:
            self._access_token = reveal_secret(config.access_token)
            # Mark as never-expires from our side; Box itself will 401 after
            # ~1h and the user has to update the token manually.
            self._expires_at = float("inf")

    def get_refresh_token(self) -> str:
        """Latest refresh token; Box rotates it on each refresh.

        Persist this value to survive restarts without re-authenticating.
        Empty in developer-token and client-credentials modes.
        """
        return self._current_refresh_token

    async def get_token(self) -> str:
        async with self._lock:
            if self._access_token and time.time() < self._expires_at:
                return self._access_token
            if self._dev_token_mode:
                raise BoxApiError(
                    "Box developer token expired (~1 hour lifetime). "
                    "Regenerate it in the app console.", 401)
            return await self._refresh()

    async def _refresh(self) -> str:
        if self._ccg_mode:
            token, expires_in = await fetch_ccg_token(self._config)
            self._access_token = token
            self._expires_at = time.time() + expires_in - TOKEN_BUFFER_SECONDS
            return token
        if self._config.refresh_fn is not None:
            token, new_refresh, expires_in = await self._config.refresh_fn(
                self._current_refresh_token)
        else:
            token, new_refresh, expires_in = await refresh_access_token(
                self._config, self._current_refresh_token)
        self._access_token = token
        self._expires_at = time.time() + expires_in - TOKEN_BUFFER_SECONDS
        if new_refresh != self._current_refresh_token:
            self._current_refresh_token = new_refresh
            if self._config.on_refresh_token_rotated is not None:
                await self._config.on_refresh_token_rotated(new_refresh)
        return token


async def box_auth_headers(tm: BoxTokenManager) -> dict[str, str]:
    token = await tm.get_token()
    return {"Authorization": f"Bearer {token}"}


def _str_params(params: dict[str, Any] | None) -> dict[str, str] | None:
    if params is None:
        return None
    return {k: str(v) for k, v in params.items()}


async def box_get(
    tm: BoxTokenManager,
    url: str,
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    headers = await box_auth_headers(tm)
    async with aiohttp.ClientSession() as session:
        async with session.get(url,
                               headers=headers,
                               params=_str_params(params)) as resp:
            if resp.status >= 400:
                text = await resp.text()
                raise BoxApiError(f"Box GET {url} -> {resp.status} {text}",
                                  resp.status)
            return await resp.json()


async def box_get_bytes(
    tm: BoxTokenManager,
    url: str,
    params: dict[str, Any] | None = None,
) -> bytes:
    headers = await box_auth_headers(tm)
    async with aiohttp.ClientSession() as session:
        async with session.get(url,
                               headers=headers,
                               params=_str_params(params)) as resp:
            if resp.status >= 400:
                text = await resp.text()
                raise BoxApiError(f"Box GET {url} -> {resp.status} {text}",
                                  resp.status)
            return await resp.read()


async def box_get_stream(
    tm: BoxTokenManager,
    url: str,
    params: dict[str, Any] | None = None,
    chunk_size: int = 8192,
) -> AsyncIterator[bytes]:
    headers = await box_auth_headers(tm)
    async with aiohttp.ClientSession() as session:
        async with session.get(url,
                               headers=headers,
                               params=_str_params(params)) as resp:
            if resp.status >= 400:
                text = await resp.text()
                raise BoxApiError(f"Box GET {url} -> {resp.status} {text}",
                                  resp.status)
            async for chunk in resp.content.iter_chunked(chunk_size):
                yield chunk


async def box_post_json(
    tm: BoxTokenManager,
    url: str,
    body: dict[str, Any],
) -> dict[str, Any]:
    headers = await box_auth_headers(tm)
    async with aiohttp.ClientSession() as session:
        async with session.post(url, headers=headers, json=body) as resp:
            if resp.status >= 400:
                text = await resp.text()
                raise BoxApiError(f"Box POST {url} -> {resp.status} {text}",
                                  resp.status)
            return await resp.json()


async def box_put_json(
    tm: BoxTokenManager,
    url: str,
    body: dict[str, Any],
) -> dict[str, Any]:
    headers = await box_auth_headers(tm)
    async with aiohttp.ClientSession() as session:
        async with session.put(url, headers=headers, json=body) as resp:
            if resp.status >= 400:
                text = await resp.text()
                raise BoxApiError(f"Box PUT {url} -> {resp.status} {text}",
                                  resp.status)
            return await resp.json()


async def box_delete(
    tm: BoxTokenManager,
    url: str,
    params: dict[str, Any] | None = None,
) -> None:
    headers = await box_auth_headers(tm)
    async with aiohttp.ClientSession() as session:
        async with session.delete(url,
                                  headers=headers,
                                  params=_str_params(params)) as resp:
            if resp.status >= 400:
                text = await resp.text()
                raise BoxApiError(f"Box DELETE {url} -> {resp.status} {text}",
                                  resp.status)


async def box_upload_multipart(
    tm: BoxTokenManager,
    url: str,
    attributes: dict[str, Any],
    filename: str,
    data: bytes,
) -> dict[str, Any]:
    headers = await box_auth_headers(tm)
    form = aiohttp.FormData()
    form.add_field("attributes", json.dumps(attributes))
    form.add_field("file",
                   data,
                   filename=filename,
                   content_type="application/octet-stream")
    async with aiohttp.ClientSession() as session:
        async with session.post(url, headers=headers, data=form) as resp:
            if resp.status >= 400:
                text = await resp.text()
                raise BoxApiError(f"Box upload {url} -> {resp.status} {text}",
                                  resp.status)
            return await resp.json()

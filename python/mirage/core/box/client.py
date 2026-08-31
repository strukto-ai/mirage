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

import json
from collections.abc import AsyncIterator
from functools import partial
from typing import Any

import aiohttp

from mirage.core.api.client import api_request
from mirage.core.api.oauth import TokenManager as OAuthTokenManager
from mirage.core.box.config import BoxConfig
from mirage.core.box.constants import (BOX_API_BASE, BOX_TOKEN_URL,
                                       TOKEN_BUFFER_SECONDS)
from mirage.resource.secrets import reveal_secret
from mirage.utils.ranges import ByteWindow


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


def _error_of(resp: aiohttp.ClientResponse, text: str, *, label: str,
              url: str) -> Exception:
    return BoxApiError(f"Box {label} {url} -> {resp.status} {text}",
                       resp.status)


def _flow_error(resp: aiohttp.ClientResponse, text: str, *,
                flow: str) -> Exception:
    return BoxApiError(f"{flow} -> {resp.status} {text}", resp.status)


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
    body = await api_request("POST",
                             token_url_of(config),
                             error_of=partial(_flow_error,
                                              flow="Box token refresh"),
                             data=data)
    return (body["access_token"], body["refresh_token"], body["expires_in"])


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
    body = await api_request("POST",
                             token_url_of(config),
                             error_of=partial(_flow_error,
                                              flow="Box CCG token"),
                             data=data)
    return body["access_token"], body["expires_in"]


class BoxTokenManager(OAuthTokenManager):
    """Manages Box access-token lifecycle across the three auth modes."""

    def __init__(self, config: BoxConfig) -> None:
        super().__init__(TOKEN_BUFFER_SECONDS)
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
        if self._dev_token_mode:
            # Mark as never-expires from our side; Box itself will 401 after
            # ~1h and the user has to update the token manually.
            self.seed(reveal_secret(config.access_token), float("inf"))

    def get_refresh_token(self) -> str:
        """Latest refresh token; Box rotates it on each refresh.

        Persist this value to survive restarts without re-authenticating.
        Empty in developer-token and client-credentials modes.
        """
        return self._current_refresh_token

    async def refresh_pair(self) -> tuple[str, float]:
        if self._dev_token_mode:
            raise BoxApiError(
                "Box developer token expired (~1 hour lifetime). "
                "Regenerate it in the app console.", 401)
        if self._ccg_mode:
            token, expires_in = await fetch_ccg_token(self._config)
            return token, expires_in
        if self._config.refresh_fn is not None:
            token, new_refresh, expires_in = await self._config.refresh_fn(
                self._current_refresh_token)
        else:
            token, new_refresh, expires_in = await refresh_access_token(
                self._config, self._current_refresh_token)
        if new_refresh != self._current_refresh_token:
            self._current_refresh_token = new_refresh
            if self._config.on_refresh_token_rotated is not None:
                await self._config.on_refresh_token_rotated(new_refresh)
        return token, expires_in


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
    data: dict[str, Any] = await api_request("GET",
                                             url,
                                             error_of=partial(_error_of,
                                                              label="GET",
                                                              url=url),
                                             headers=await
                                             box_auth_headers(tm),
                                             params=_str_params(params),
                                             session=tm.pool)
    return data


async def box_get_bytes(
    tm: BoxTokenManager,
    url: str,
    params: dict[str, Any] | None = None,
    window: ByteWindow | None = None,
) -> bytes:
    """GET a URL as raw bytes, optionally only a byte range of it.

    Args:
        tm (BoxTokenManager): token manager.
        url (str): API URL.
        params (dict | None): query parameters.
        window (ByteWindow | None): the byte window, or None for the
            whole body.
    """
    data: bytes = await api_request("GET",
                                    url,
                                    error_of=partial(_error_of,
                                                     label="GET",
                                                     url=url),
                                    headers=await box_auth_headers(tm),
                                    params=_str_params(params),
                                    read="bytes",
                                    window=window,
                                    session=tm.pool)
    return data


async def box_get_stream(
    tm: BoxTokenManager,
    url: str,
    params: dict[str, Any] | None = None,
    chunk_size: int = 8192,
) -> AsyncIterator[bytes]:
    headers = await box_auth_headers(tm)
    # The manager's shared pool, not a per-call session: the response
    # context releases its connection back to the pool when the stream
    # ends, so streaming holds one connection, never a whole session.
    async with tm.session().get(url,
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
    data: dict[str, Any] = await api_request("POST",
                                             url,
                                             error_of=partial(_error_of,
                                                              label="POST",
                                                              url=url),
                                             headers=await
                                             box_auth_headers(tm),
                                             json_body=body,
                                             session=tm.pool)
    return data


async def box_put_json(
    tm: BoxTokenManager,
    url: str,
    body: dict[str, Any],
) -> dict[str, Any]:
    data: dict[str, Any] = await api_request("PUT",
                                             url,
                                             error_of=partial(_error_of,
                                                              label="PUT",
                                                              url=url),
                                             headers=await
                                             box_auth_headers(tm),
                                             json_body=body,
                                             session=tm.pool)
    return data


async def box_delete(
    tm: BoxTokenManager,
    url: str,
    params: dict[str, Any] | None = None,
) -> None:
    await api_request("DELETE",
                      url,
                      error_of=partial(_error_of, label="DELETE", url=url),
                      headers=await box_auth_headers(tm),
                      params=_str_params(params),
                      read="none",
                      session=tm.pool)


async def box_upload_multipart(
    tm: BoxTokenManager,
    url: str,
    attributes: dict[str, Any],
    filename: str,
    data: bytes,
) -> dict[str, Any]:
    form = aiohttp.FormData()
    form.add_field("attributes", json.dumps(attributes))
    form.add_field("file",
                   data,
                   filename=filename,
                   content_type="application/octet-stream")
    payload: dict[str,
                  Any] = await api_request("POST",
                                           url,
                                           error_of=partial(_error_of,
                                                            label="upload",
                                                            url=url),
                                           headers=await box_auth_headers(tm),
                                           data=form,
                                           session=tm.pool)
    return payload

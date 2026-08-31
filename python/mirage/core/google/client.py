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
from typing import Any

import aiohttp

from mirage.core.api.client import api_request
from mirage.core.api.oauth import TokenManager as OAuthTokenManager
from mirage.core.google.config import GoogleConfig
from mirage.core.google.constants import (CALENDAR_API_BASE, DOCS_API_BASE,
                                          DRIVE_API_BASE, DRIVE_UPLOAD_BASE,
                                          FORMS_API_BASE, GMAIL_API_BASE,
                                          SHEETS_API_BASE, SLIDES_API_BASE,
                                          TOKEN_BUFFER_SECONDS, TOKEN_URL)
from mirage.resource.secrets import reveal_secret
from mirage.utils.ranges import ByteWindow


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


def _error_of(resp: aiohttp.ClientResponse, text: str) -> Exception:
    """The error a failed call raises, worded with Google's message.

    A bare ``raise_for_status()`` would discard the reason Google gave in
    the body and report only "Bad Request"; an agent cannot correct an
    error it cannot read. The exception type is the plain aiohttp one,
    since callers classify on it (a 403 during a mutation becomes EACCES
    in ``gdrive/resolve.py``).
    """
    return aiohttp.ClientResponseError(
        resp.request_info,
        resp.history,
        status=resp.status,
        message=google_error_message(text, resp.status, resp.reason),
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


def calendar_base(token_manager: "TokenManager") -> str:
    base = token_manager.config.api_base
    return f"{base}/calendar/v3" if base else CALENDAR_API_BASE


def forms_base(token_manager: "TokenManager") -> str:
    base = token_manager.config.api_base
    return f"{base}/v1" if base else FORMS_API_BASE


async def refresh_access_token(config: GoogleConfig, ) -> tuple[str, int]:
    """Exchange refresh token for a new access token.

    Args:
        config (GoogleConfig): OAuth2 credentials.

    Returns:
        tuple[str, int]: (access_token, expires_in_seconds)
    """
    if config.client_id is None or config.refresh_token is None:
        raise ValueError(
            "refresh_access_token needs client_id and refresh_token; this "
            "config authenticates with a pre-minted access_token")
    data = {
        "client_id": config.client_id,
        "refresh_token": reveal_secret(config.refresh_token),
        "grant_type": "refresh_token",
    }
    client_secret = reveal_secret(config.client_secret)
    if client_secret:
        data["client_secret"] = client_secret
    body = await api_request("POST",
                             token_url(config),
                             error_of=_error_of,
                             data=data)
    return body["access_token"], body["expires_in"]


class TokenManager(OAuthTokenManager):
    """Manages OAuth2 access token lifecycle."""

    def __init__(self, config: GoogleConfig) -> None:
        super().__init__(TOKEN_BUFFER_SECONDS)
        self.config = config

    async def refresh_pair(self) -> tuple[str, int]:
        return await refresh_access_token(self.config)

    async def get_token(self) -> str:
        # A supplied token short-circuits the grant entirely, and is read
        # every call rather than cached: a provider callable is the
        # caller's own cache, and caching its answer here would outlive
        # the refresh it just performed. Mirrors _resolve_token in
        # core/msgraph/client.py.
        supplied = self.config.access_token
        if supplied is not None:
            token: str = reveal_secret(
                supplied() if callable(supplied) else supplied)
            return token
        return await super().get_token()


async def google_headers(token_manager: TokenManager, ) -> dict[str, str]:
    token = await token_manager.get_token()
    return {"Authorization": f"Bearer {token}"}


async def google_get(
    token_manager: TokenManager,
    url: str,
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    data: dict[str, Any] = await api_request("GET",
                                             url,
                                             error_of=_error_of,
                                             headers=await
                                             google_headers(token_manager),
                                             params=params,
                                             session=token_manager.pool)
    return data


async def google_post(
    token_manager: TokenManager,
    url: str,
    json: dict[str, Any],
) -> dict[str, Any]:
    data: dict[str, Any] = await api_request("POST",
                                             url,
                                             error_of=_error_of,
                                             headers=await
                                             google_headers(token_manager),
                                             json_body=json,
                                             session=token_manager.pool)
    return data


async def google_put(
    token_manager: TokenManager,
    url: str,
    json: dict[str, Any],
) -> dict[str, Any]:
    data: dict[str, Any] = await api_request("PUT",
                                             url,
                                             error_of=_error_of,
                                             headers=await
                                             google_headers(token_manager),
                                             json_body=json,
                                             session=token_manager.pool)
    return data


async def google_patch(
    token_manager: TokenManager,
    url: str,
    json: dict[str, Any],
    params: dict[str, str] | None = None,
) -> dict[str, Any]:
    data: dict[str, Any] = await api_request("PATCH",
                                             url,
                                             error_of=_error_of,
                                             headers=await
                                             google_headers(token_manager),
                                             params=params,
                                             json_body=json,
                                             session=token_manager.pool)
    return data


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
    payload: dict[str, Any] = await api_request(method,
                                                url,
                                                error_of=_error_of,
                                                headers=headers,
                                                params=params,
                                                data=data,
                                                session=token_manager.pool)
    return payload


async def google_delete(
    token_manager: TokenManager,
    url: str,
) -> None:
    await api_request("DELETE",
                      url,
                      error_of=_error_of,
                      headers=await google_headers(token_manager),
                      read="none",
                      session=token_manager.pool)


async def google_get_bytes(
    token_manager: TokenManager,
    url: str,
    window: ByteWindow | None = None,
) -> bytes:
    """GET a URL as raw bytes, optionally only a byte range of it.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        url (str): API URL.
        window (ByteWindow | None): the byte window, or None for the
            whole body.
    """
    data: bytes = await api_request("GET",
                                    url,
                                    error_of=_error_of,
                                    headers=await
                                    google_headers(token_manager),
                                    read="bytes",
                                    window=window,
                                    session=token_manager.pool)
    return data

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
from collections.abc import AsyncGenerator, Awaitable, Callable, Mapping
from contextlib import aclosing
from dataclasses import replace
from typing import Any, cast

import aiohttp

from mirage.core.api.client import (
    ErrorOf,
    ReadMode,
    RetryPolicy,
    SessionPool,
    api_request,
    api_stream,
)
from mirage.core.api.errors import ApiError
from mirage.core.api.oauth import TokenManager as OAuthTokenManager
from mirage.core.google.config import GoogleConfig
from mirage.core.google.constants import (
    CALENDAR_API_BASE,
    DOCS_API_BASE,
    DRIVE_API_BASE,
    DRIVE_UPLOAD_BASE,
    FORMS_API_BASE,
    GMAIL_API_BASE,
    MAX_BACKOFF,
    MAX_RETRIES,
    RATE_LIMIT_REASONS,
    RETRY_STATUSES,
    SHEETS_API_BASE,
    SLIDES_API_BASE,
    TOKEN_BUFFER_SECONDS,
    TOKEN_URL,
    WRITE_RETRY_STATUSES,
)
from mirage.io.spool import ByteSpool
from mirage.types import JsonValue
from mirage.utils.clock import Clock
from mirage.utils.ranges import ByteWindow
from mirage.vfs.secrets import reveal_secret


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


def transient(status: int, text: str) -> bool:
    """Whether a retryable status is worth waiting out.

    Google answers both "slow down" and "you may not" with a 403, and
    only its error reason tells them apart: the APIs list the reasons in
    ``error.errors``. Every other listed status is transient as it is.

    Args:
        status (int): HTTP status code.
        text (str): the raw response body.
    """
    if status != 403:
        return True
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return False
    error = parsed.get("error") if isinstance(parsed, dict) else None
    errors = error.get("errors") if isinstance(error, dict) else None
    if not isinstance(errors, list):
        return False
    return any(
        isinstance(item, dict)
        and isinstance(reason := item.get("reason"), str)
        and reason in RATE_LIMIT_REASONS
        for item in errors
    )


# A read, the token exchange and the start of a resumable upload retry
# every transient status and a dropped connection: none of them changes
# anything a second attempt could repeat, since an upload session creates
# no file until its last chunk commits.
READ_RETRY = RetryPolicy(
    statuses=RETRY_STATUSES,
    max_retries=MAX_RETRIES,
    max_backoff=MAX_BACKOFF,
    retry_transport=True,
    retryable=transient,
)

# Every other write retries only a rate-limit refusal. A 5xx or a dropped
# connection may come after the change landed, and a retried create,
# append or upload chunk would apply it twice.
WRITE_RETRY = replace(
    READ_RETRY,
    statuses=WRITE_RETRY_STATUSES,
    retry_transport=False,
)


class GoogleApiError(ApiError):
    """A Google API call that failed, worded with Google's message."""


def _error_of(resp: aiohttp.ClientResponse, text: str) -> Exception:
    """The error a failed call raises, worded with Google's message.

    A bare ``raise_for_status()`` would discard the reason Google gave in
    the body and report only "Bad Request"; an agent cannot correct an
    error it cannot read. Callers classify on its status (a 403 during a
    mutation becomes EACCES in ``gdrive/resolve.py``).
    """
    return GoogleApiError(
        google_error_message(text, resp.status, resp.reason), resp.status
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


async def refresh_access_token(
    config: GoogleConfig,
    sleep: Callable[[float], Awaitable[None]] | None = None,
) -> tuple[str, int]:
    """Exchange refresh token for a new access token.

    Args:
        config (GoogleConfig): OAuth2 credentials.
        sleep (Callable[[float], Awaitable[None]] | None): the wait
            between retries; None is ``asyncio.sleep``.

    Returns:
        tuple[str, int]: (access_token, expires_in_seconds)
    """
    if config.client_id is None or config.refresh_token is None:
        raise ValueError(
            "refresh_access_token needs client_id and refresh_token; this "
            "config authenticates with a pre-minted access_token"
        )
    data = {
        "client_id": config.client_id,
        "refresh_token": reveal_secret(config.refresh_token),
        "grant_type": "refresh_token",
    }
    client_secret = reveal_secret(config.client_secret)
    if client_secret:
        data["client_secret"] = client_secret
    body = await api_request(
        "POST",
        token_url(config),
        error_of=_error_of,
        data=data,
        retry=READ_RETRY,
        sleep=sleep,
    )
    return body["access_token"], body["expires_in"]


class TokenManager(OAuthTokenManager):
    """Manages OAuth2 access token lifecycle.

    Args:
        config (GoogleConfig): OAuth2 credentials and API base.
        clock (Clock | None): the clock token expiry and the waits
            between retries of every call made with this manager are
            read on; None is the system clock.
    """

    def __init__(
        self, config: GoogleConfig, clock: Clock | None = None
    ) -> None:
        super().__init__(TOKEN_BUFFER_SECONDS, clock)
        # aiohttp replays an idempotent request whose connection dropped,
        # PUT and DELETE included, beneath any policy; READ_RETRY and
        # WRITE_RETRY decide alone, so an upload chunk or a values update
        # is never sent twice.
        self.pool = SessionPool(config.timeout, retry_connection=False)
        self.config = config

    async def refresh_pair(self) -> tuple[str, int]:
        return await refresh_access_token(self.config, self.clock.sleep)

    async def get_token(self) -> str:
        # A supplied token short-circuits the grant entirely, and is read
        # every call rather than cached: a provider callable is the
        # caller's own cache, and caching its answer here would outlive
        # the refresh it just performed. Mirrors _resolve_token in
        # core/msgraph/client.py.
        supplied = self.config.access_token
        if supplied is not None:
            token: str = reveal_secret(
                supplied() if callable(supplied) else supplied
            )
            return token
        return await super().get_token()


async def google_headers(
    token_manager: TokenManager,
) -> dict[str, str]:
    token = await token_manager.get_token()
    return {"Authorization": f"Bearer {token}"}


async def google_request(
    token_manager: TokenManager,
    method: str,
    url: str,
    *,
    params: Mapping[str, Any] | None = None,
    json_body: JsonValue = None,
    data: bytes | None = None,
    headers: Mapping[str, str] | None = None,
    read: ReadMode = "json",
    window: ByteWindow | None = None,
    retry: RetryPolicy | None = None,
    error_of: ErrorOf = _error_of,
) -> Any:
    """One Google API call: the door every request but a stream takes.

    It signs the call, rides the manager's pool and clock, and picks the
    retry policy from the method, so a new call site cannot forget any of
    them: GET and HEAD read, everything else writes. A write that is safe
    to repeat (the start of a resumable upload) passes READ_RETRY.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        method (str): HTTP method.
        url (str): API URL.
        params (Mapping[str, Any] | None): query parameters.
        json_body (JsonValue): JSON body; None sends none.
        data (bytes | None): raw body, for the upload endpoints.
        headers (Mapping[str, str] | None): headers beside the bearer.
        read (ReadMode): how to read the reply, as for api_request.
        window (ByteWindow | None): the byte range to request.
        retry (RetryPolicy | None): None picks by method.
        error_of (ErrorOf): maps a failed response to the raised error.
    """
    if retry is None:
        retry = (
            READ_RETRY if method.upper() in ("GET", "HEAD") else WRITE_RETRY
        )
    return await api_request(
        method,
        url,
        error_of=error_of,
        headers={**await google_headers(token_manager), **(headers or {})},
        params=params,
        json_body=json_body,
        data=data,
        read=read,
        window=window,
        retry=retry,
        session=token_manager.pool,
        sleep=token_manager.clock.sleep,
    )


async def google_get(
    token_manager: TokenManager,
    url: str,
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    data: dict[str, Any] = await google_request(
        token_manager, "GET", url, params=params
    )
    return data


async def google_post(
    token_manager: TokenManager,
    url: str,
    json: dict[str, Any],
) -> dict[str, Any]:
    data: dict[str, Any] = await google_request(
        token_manager, "POST", url, json_body=json
    )
    return data


async def google_patch(
    token_manager: TokenManager,
    url: str,
    json: dict[str, Any],
    params: dict[str, str] | None = None,
) -> dict[str, Any]:
    data: dict[str, Any] = await google_request(
        token_manager, "PATCH", url, params=params, json_body=json
    )
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
    payload: dict[str, Any] = await google_request(
        token_manager,
        method,
        url,
        params=params,
        data=data,
        headers={"Content-Type": content_type},
    )
    return payload


async def google_delete(
    token_manager: TokenManager,
    url: str,
) -> None:
    await google_request(token_manager, "DELETE", url, read="none")


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
    data: bytes = await google_request(
        token_manager, "GET", url, read="bytes", window=window
    )
    return data


async def google_get_stream(
    token_manager: TokenManager, url: str
) -> AsyncGenerator[bytes, None]:
    """GET a URL's raw bytes as they arrive.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        url (str): API URL.
    """
    source = api_stream(
        url,
        error_of=_error_of,
        headers=await google_headers(token_manager),
        session=token_manager.pool,
        retry=READ_RETRY,
        sleep=token_manager.clock.sleep,
    )
    async with aclosing(source):
        async for chunk in source:
            yield chunk


async def google_resumable(
    tm: TokenManager,
    method: str,
    url: str,
    metadata: dict[str, Any],
    spool: ByteSpool,
    mime_type: str,
    params: dict[str, str],
) -> dict[str, Any]:
    location = await google_request(
        tm,
        method,
        url,
        headers={
            "X-Upload-Content-Type": mime_type,
            "X-Upload-Content-Length": str(spool.size),
        },
        params={**params, "uploadType": "resumable"},
        json_body=metadata,
        read="location",
        retry=READ_RETRY,
    )
    if not location:
        raise RuntimeError("Drive upload session returned no Location")
    offset = 0
    while offset < spool.size:
        data = await spool.read(offset, 8 * 1024 * 1024)
        response = await google_request(
            tm,
            "PUT",
            location,
            headers={
                "Content-Type": mime_type,
                "Content-Range": (
                    f"bytes {offset}-{offset + len(data) - 1}/{spool.size}"
                ),
            },
            data=data,
            read="response",
        )
        if response.status in (200, 201):
            return cast(dict[str, Any], response.data)
        if response.status != 308:
            raise RuntimeError(
                f"Unexpected Drive upload status: {response.status}"
            )
        acknowledged = response.headers.get("range", "")
        next_offset = (
            int(acknowledged.rsplit("-", 1)[-1]) + 1 if acknowledged else 0
        )
        if not offset < next_offset <= offset + len(data):
            raise RuntimeError("Drive upload session made no progress")
        offset = next_offset
    raise RuntimeError("Drive upload session did not commit")

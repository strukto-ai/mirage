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
from collections.abc import AsyncIterator, Callable, Mapping
from functools import partial
from typing import Any

import aiohttp

from mirage.core.api.client import ApiResponse, api_request, lowered_headers
from mirage.core.api.oauth import TokenManager as OAuthTokenManager
from mirage.core.dropbox.constants import (
    DROPBOX_API_BASE,
    DROPBOX_CONTENT_BASE,
    DROPBOX_TOKEN_URL,
    RESULT_HEADER,
    TOKEN_BUFFER_SECONDS,
)
from mirage.utils.ranges import ByteWindow
from mirage.vfs.dropbox.config import DropboxConfig
from mirage.vfs.secrets import reveal_secret


class DropboxApiError(RuntimeError):
    def __init__(
        self, message: str, status: int | None = None, summary: str = ""
    ) -> None:
        super().__init__(message)
        self.status = status
        # Dropbox error_summary, e.g. "path/not_found/.." or
        # "path/conflict/folder/..".
        self.summary = summary


def summary_of(text: str) -> str:
    """An error body's ``error_summary``, or "" when it carries no string.

    Args:
        text (str): the response body.
    """
    try:
        body = json.loads(text)
    except ValueError:
        return ""
    summary = body.get("error_summary") if isinstance(body, dict) else None
    return summary if isinstance(summary, str) else ""


def _token_url_of(config: DropboxConfig) -> str:
    if not config.endpoint:
        return DROPBOX_TOKEN_URL
    return f"{config.endpoint.rstrip('/')}/oauth2/token"


def _flow_error(resp: aiohttp.ClientResponse, text: str) -> Exception:
    return DropboxApiError(
        f"Dropbox token refresh → {resp.status} {text}", resp.status
    )


async def refresh_access_token(config: DropboxConfig) -> tuple[str, int]:
    body = {
        "grant_type": "refresh_token",
        "refresh_token": reveal_secret(config.refresh_token),
        "client_id": config.client_id,
    }
    secret = reveal_secret(config.client_secret)
    if secret:
        body["client_secret"] = secret
    data = await api_request(
        "POST", _token_url_of(config), error_of=_flow_error, data=body
    )
    return data["access_token"], int(data["expires_in"])


class DropboxTokenManager(OAuthTokenManager):
    """Caches the short-lived access token, refreshing before expiry."""

    def __init__(self, config: DropboxConfig) -> None:
        super().__init__(TOKEN_BUFFER_SECONDS)
        self._config = config
        if config.endpoint:
            base = f"{config.endpoint.rstrip('/')}/2"
            self.api_base = base
            self.content_base = base
        else:
            self.api_base = DROPBOX_API_BASE
            self.content_base = DROPBOX_CONTENT_BASE

    async def refresh_pair(self) -> tuple[str, int]:
        return await refresh_access_token(self._config)


async def dropbox_auth_headers(tm: DropboxTokenManager) -> dict[str, str]:
    token = await tm.get_token()
    return {"Authorization": f"Bearer {token}"}


def _rpc_error(
    resp: aiohttp.ClientResponse, text: str, *, endpoint: str
) -> Exception:
    return DropboxApiError(
        f"Dropbox POST {endpoint} → {resp.status} {text}",
        resp.status,
        summary_of(text),
    )


async def dropbox_rpc(
    tm: DropboxTokenManager,
    endpoint: str,
    body: dict[str, Any],
) -> dict[str, Any]:
    data: dict[str, Any] = await api_request(
        "POST",
        f"{tm.api_base}{endpoint}",
        error_of=partial(_rpc_error, endpoint=endpoint),
        headers=await dropbox_auth_headers(tm),
        json_body=body,
        session=tm.pool,
    )
    return data


def _upload_error(
    resp: aiohttp.ClientResponse, text: str, *, path: str
) -> Exception:
    return DropboxApiError(
        f"Dropbox upload {path} → {resp.status} {text}",
        resp.status,
        summary_of(text),
    )


async def dropbox_upload(
    tm: DropboxTokenManager, path: str, data: bytes
) -> None:
    headers = await dropbox_auth_headers(tm)
    headers["Dropbox-API-Arg"] = json.dumps(
        {
            "path": path,
            "mode": "overwrite",
            "mute": True,
        }
    )
    headers["Content-Type"] = "application/octet-stream"
    await api_request(
        "POST",
        f"{tm.content_base}/files/upload",
        error_of=partial(_upload_error, path=path),
        headers=headers,
        data=data,
        read="none",
        session=tm.pool,
    )


def _download_error(
    resp: aiohttp.ClientResponse, text: str, *, path: str
) -> Exception:
    return DropboxApiError(
        f"Dropbox download {path} → {resp.status} {text}", resp.status
    )


async def dropbox_download(
    tm: DropboxTokenManager, path: str, window: ByteWindow | None = None
) -> tuple[bytes, str | None]:
    """Download a file, or a byte range of it, with its result header.

    The second value is the raw ``Dropbox-API-Result`` header, or None when
    the response carries none; ``fingerprint.result_token`` reads it.

    Args:
        tm (DropboxTokenManager): token manager.
        path (str): Dropbox path of the file.
        window (ByteWindow | None): the byte window, or None for the
            whole file.
    """
    headers = await dropbox_auth_headers(tm)
    headers["Dropbox-API-Arg"] = json.dumps({"path": path})
    resp: ApiResponse = await api_request(
        "POST",
        f"{tm.content_base}/files/download",
        error_of=partial(_download_error, path=path),
        headers=headers,
        read="bytes_response",
        window=window,
        session=tm.pool,
    )
    return resp.data, resp.headers.get(RESULT_HEADER.lower())


async def dropbox_download_stream(
    tm: DropboxTokenManager,
    path: str,
    chunk_size: int = 65536,
    on_response: Callable[[Mapping[str, str]], None] | None = None,
) -> AsyncIterator[bytes]:
    """Stream a file's bytes.

    Args:
        tm (DropboxTokenManager): token manager.
        path (str): Dropbox path of the file.
        chunk_size (int): bytes per yielded chunk.
        on_response (Callable[[Mapping[str, str]], None] | None): handed
            the response's headers, lower-cased as ``bytes_response`` hands
            them, before the first chunk.
    """
    headers = await dropbox_auth_headers(tm)
    headers["Dropbox-API-Arg"] = json.dumps({"path": path})
    url = f"{tm.content_base}/files/download"
    # The manager's shared pool, for the reason box_get_stream states.
    async with tm.session().post(url, headers=headers) as resp:
        if resp.status >= 400:
            text = await resp.text()
            raise DropboxApiError(
                f"Dropbox download {path} → {resp.status} {text}", resp.status
            )
        if on_response is not None:
            on_response(lowered_headers(resp.headers))
        async for chunk in resp.content.iter_chunked(chunk_size):
            yield chunk

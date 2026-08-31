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
from mirage.core.dropbox.constants import (DROPBOX_API_BASE,
                                           DROPBOX_CONTENT_BASE,
                                           DROPBOX_TOKEN_URL,
                                           TOKEN_BUFFER_SECONDS)
from mirage.resource.dropbox.config import DropboxConfig
from mirage.resource.secrets import reveal_secret
from mirage.utils.ranges import ByteWindow


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
        summary: str = json.loads(text).get("error_summary", "")
    except ValueError:
        return ""
    return summary


def _token_url(config: DropboxConfig) -> str:
    if not config.endpoint:
        return DROPBOX_TOKEN_URL
    return f"{config.endpoint.rstrip('/')}/oauth2/token"


def _flow_error(resp: aiohttp.ClientResponse, text: str) -> Exception:
    return DropboxApiError(f"Dropbox token refresh → {resp.status} {text}",
                           resp.status)


async def refresh_access_token(config: DropboxConfig) -> tuple[str, int]:
    body = {
        "grant_type": "refresh_token",
        "refresh_token": reveal_secret(config.refresh_token),
        "client_id": config.client_id,
    }
    secret = reveal_secret(config.client_secret)
    if secret:
        body["client_secret"] = secret
    data = await api_request("POST",
                             _token_url(config),
                             error_of=_flow_error,
                             data=body)
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


def _rpc_error(resp: aiohttp.ClientResponse, text: str, *,
               endpoint: str) -> Exception:
    return DropboxApiError(f"Dropbox POST {endpoint} → {resp.status} {text}",
                           resp.status, summary_of(text))


async def dropbox_rpc(
    tm: DropboxTokenManager,
    endpoint: str,
    body: dict[str, Any],
) -> dict[str, Any]:
    data: dict[str,
               Any] = await api_request("POST",
                                        f"{tm.api_base}{endpoint}",
                                        error_of=partial(_rpc_error,
                                                         endpoint=endpoint),
                                        headers=await dropbox_auth_headers(tm),
                                        json_body=body,
                                        session=tm.pool)
    return data


def _upload_error(resp: aiohttp.ClientResponse, text: str, *,
                  path: str) -> Exception:
    return DropboxApiError(f"Dropbox upload {path} → {resp.status} {text}",
                           resp.status, summary_of(text))


async def dropbox_upload(tm: DropboxTokenManager, path: str,
                         data: bytes) -> None:
    headers = await dropbox_auth_headers(tm)
    headers["Dropbox-API-Arg"] = json.dumps({
        "path": path,
        "mode": "overwrite",
        "mute": True,
    })
    headers["Content-Type"] = "application/octet-stream"
    await api_request("POST",
                      f"{tm.content_base}/files/upload",
                      error_of=partial(_upload_error, path=path),
                      headers=headers,
                      data=data,
                      read="none",
                      session=tm.pool)


def _download_error(resp: aiohttp.ClientResponse, text: str, *,
                    path: str) -> Exception:
    return DropboxApiError(f"Dropbox download {path} → {resp.status} {text}",
                           resp.status)


async def dropbox_download(tm: DropboxTokenManager,
                           path: str,
                           window: ByteWindow | None = None) -> bytes:
    """Download a file, optionally only a byte range of it.

    Args:
        tm (DropboxTokenManager): token manager.
        path (str): Dropbox path of the file.
        window (ByteWindow | None): the byte window, or None for the
            whole file.
    """
    headers = await dropbox_auth_headers(tm)
    headers["Dropbox-API-Arg"] = json.dumps({"path": path})
    data: bytes = await api_request("POST",
                                    f"{tm.content_base}/files/download",
                                    error_of=partial(_download_error,
                                                     path=path),
                                    headers=headers,
                                    read="bytes",
                                    window=window,
                                    session=tm.pool)
    return data


async def dropbox_download_stream(
    tm: DropboxTokenManager,
    path: str,
    chunk_size: int = 65536,
) -> AsyncIterator[bytes]:
    headers = await dropbox_auth_headers(tm)
    headers["Dropbox-API-Arg"] = json.dumps({"path": path})
    url = f"{tm.content_base}/files/download"
    # The manager's shared pool, for the reason box_get_stream states.
    async with tm.session().post(url, headers=headers) as resp:
        if resp.status >= 400:
            text = await resp.text()
            raise DropboxApiError(
                f"Dropbox download {path} → {resp.status} {text}", resp.status)
        async for chunk in resp.content.iter_chunked(chunk_size):
            yield chunk

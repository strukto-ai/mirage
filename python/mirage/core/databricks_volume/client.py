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
import inspect
from collections.abc import AsyncGenerator
from contextlib import aclosing
from urllib.parse import quote

from pydantic import BaseModel, ConfigDict, Field, SecretStr, TypeAdapter

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.core.api.client import NO_RETRY, api_request, api_stream
from mirage.core.databricks_volume.errors import (
    DatabricksVolumeCredentialError,
    error_of,
)
from mirage.core.databricks_volume.types import DirectoryEntry, FileMetadata
from mirage.io.spool import ByteSpool
from mirage.utils.ranges import ByteWindow


class _DirectoryEntry(BaseModel):
    model_config = ConfigDict(strict=True)
    path: str
    is_directory: bool = False
    file_size: int | None = Field(default=None, ge=0)
    last_modified: int | None = None


class _DirectoryPage(BaseModel):
    model_config = ConfigDict(strict=True)
    contents: list[_DirectoryEntry] = Field(default_factory=list)
    next_page_token: str | None = None


_LENGTH = TypeAdapter(int)
_BYTES = TypeAdapter(bytes)
# The Files API takes a file in one PUT of at most 5 GiB.
MAX_UPLOAD_SIZE = 5 * 1024**3


def _url(
    accessor: DatabricksVolumeAccessor, endpoint: str, remote_path: str
) -> str:
    return f"{accessor.config.host}/api/2.0/fs/{endpoint}{quote(remote_path, safe='/')}"


async def _headers(accessor: DatabricksVolumeAccessor) -> dict[str, str]:
    provider = accessor.config.token
    try:
        token = (
            await asyncio.to_thread(provider)
            if callable(provider)
            else provider
        )
        if inspect.isawaitable(token):
            token = await token
    except Exception as exc:
        raise DatabricksVolumeCredentialError(
            "databricks_volume: credential provider failed"
        ) from exc
    if isinstance(token, SecretStr):
        token = token.get_secret_value()
    if (
        not isinstance(token, str)
        or not token.strip()
        or "\r" in token
        or "\n" in token
    ):
        raise ValueError(
            "token provider must return a nonblank string without CR or LF"
        )
    return {"Authorization": f"Bearer {token}"}


async def get_metadata(
    accessor: DatabricksVolumeAccessor, remote_path: str
) -> FileMetadata:
    response = await api_request(
        "HEAD",
        _url(accessor, "files", remote_path),
        error_of=error_of,
        headers=await _headers(accessor),
        session=accessor.pool,
        retry=NO_RETRY,
        read="response",
    )
    length = response.headers.get("content-length")
    return FileMetadata(
        None if length is None else _LENGTH.validate_python(length),
        response.headers.get("last-modified"),
    )


async def get_directory_metadata(
    accessor: DatabricksVolumeAccessor, remote_path: str
) -> None:
    await api_request(
        "HEAD",
        _url(accessor, "directories", remote_path),
        error_of=error_of,
        headers=await _headers(accessor),
        session=accessor.pool,
        retry=NO_RETRY,
        read="none",
    )


async def list_directory_contents(
    accessor: DatabricksVolumeAccessor,
    remote_path: str,
    limit: int | None = None,
) -> list[DirectoryEntry]:
    """A directory's entries, a page at a time; no page past the one that
    brings ``limit`` entries.

    Args:
        accessor (DatabricksVolumeAccessor): Databricks accessor.
        remote_path (str): the directory in the volume.
        limit (int | None): stop once this many entries are in hand.
    """
    entries: list[DirectoryEntry] = []
    page_token: str | None = None
    while True:
        raw = await api_request(
            "GET",
            _url(accessor, "directories", remote_path),
            error_of=error_of,
            headers=await _headers(accessor),
            params={} if page_token is None else {"page_token": page_token},
            session=accessor.pool,
            retry=NO_RETRY,
        )
        page = _DirectoryPage.model_validate(raw)
        entries.extend(
            DirectoryEntry(
                entry.path,
                entry.is_directory,
                entry.file_size,
                entry.last_modified,
            )
            for entry in page.contents
        )
        if not page.next_page_token or (
            limit is not None and len(entries) >= limit
        ):
            return entries
        page_token = page.next_page_token


async def download(
    accessor: DatabricksVolumeAccessor,
    remote_path: str,
    *,
    window: ByteWindow | None = None,
) -> bytes:
    response = await api_request(
        "GET",
        _url(accessor, "files", remote_path),
        error_of=error_of,
        headers=await _headers(accessor),
        session=accessor.pool,
        retry=NO_RETRY,
        read="bytes",
        window=window,
    )
    return _BYTES.validate_python(response, strict=True)


async def download_stream(
    accessor: DatabricksVolumeAccessor, remote_path: str
) -> AsyncGenerator[bytes, None]:
    async with aclosing(
        api_stream(
            _url(accessor, "files", remote_path),
            error_of=error_of,
            headers=await _headers(accessor),
            session=accessor.pool,
        )
    ) as stream:
        async for chunk in stream:
            yield chunk


async def upload(
    accessor: DatabricksVolumeAccessor,
    remote_path: str,
    data: bytes | ByteSpool,
    *,
    overwrite: bool,
) -> None:
    """Put one file in a single PUT, at most ``MAX_UPLOAD_SIZE`` bytes.

    Args:
        accessor (DatabricksVolumeAccessor): Databricks accessor.
        remote_path (str): the file in the volume.
        data (bytes | ByteSpool): its bytes, or a spool streamed as the
            body.
        overwrite (bool): replace a file already there.
    """
    body, size = (
        (data, len(data))
        if isinstance(data, bytes)
        else (data.stream(), data.size)
    )
    await api_request(
        "PUT",
        _url(accessor, "files", remote_path),
        error_of=error_of,
        headers={
            **await _headers(accessor),
            "Content-Type": "application/octet-stream",
            "Content-Length": str(size),
        },
        params={"overwrite": str(overwrite).lower()},
        data=body,
        session=accessor.pool,
        retry=NO_RETRY,
        read="none",
    )


async def create_directory(
    accessor: DatabricksVolumeAccessor, remote_path: str
) -> None:
    await api_request(
        "PUT",
        _url(accessor, "directories", remote_path),
        error_of=error_of,
        headers=await _headers(accessor),
        session=accessor.pool,
        retry=NO_RETRY,
        read="none",
    )


async def delete_file(
    accessor: DatabricksVolumeAccessor, remote_path: str
) -> None:
    await api_request(
        "DELETE",
        _url(accessor, "files", remote_path),
        error_of=error_of,
        headers=await _headers(accessor),
        session=accessor.pool,
        retry=NO_RETRY,
        read="none",
    )


async def delete_directory(
    accessor: DatabricksVolumeAccessor, remote_path: str
) -> None:
    await api_request(
        "DELETE",
        _url(accessor, "directories", remote_path),
        error_of=error_of,
        headers=await _headers(accessor),
        session=accessor.pool,
        retry=NO_RETRY,
        read="none",
    )

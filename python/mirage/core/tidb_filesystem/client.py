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

import base64
import logging
from collections.abc import AsyncGenerator, Mapping
from contextlib import aclosing
from typing import Any
from urllib.parse import quote

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

from mirage.accessor.tidb_filesystem import TiDBFilesystemAccessor
from mirage.concurrency.limiter import bounded_map
from mirage.core.api.client import (
    NO_RETRY,
    ReadMode,
    RetryPolicy,
    api_request,
    api_stream,
)
from mirage.core.tidb_filesystem.constants import (
    BATCH_STAT_LIMIT,
    MAX_UPLOAD_WORKERS,
    PRESIGN_BATCH,
    SMALL_FILE_LIMIT,
    TREE_DELETE_RETRY,
)
from mirage.core.tidb_filesystem.errors import (
    TiDBFilesystemApiError,
    error_of,
    has_status,
)
from mirage.core.tidb_filesystem.types import Entry
from mirage.io.spool import ByteSpool
from mirage.types import JsonValue
from mirage.utils.ranges import ByteWindow

logger = logging.getLogger(__name__)


class _ListedEntry(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    name: str
    size: int = Field(default=0, ge=0)
    is_dir: bool = Field(default=False, alias="isDir")
    mtime: int | None = None


class _Listing(BaseModel):
    entries: list[_ListedEntry] = Field(default_factory=list)


class _StatResult(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    status: int
    size: int = Field(default=0, ge=0)
    is_dir: bool = Field(default=False, alias="isDir")
    mtime: int | None = None
    error: str | None = None


class _BatchStat(BaseModel):
    results: list[_StatResult]


class _Upload(BaseModel):
    upload_id: str
    part_size: int = Field(gt=0)
    total_parts: int = Field(gt=0)


class _PresignedPart(BaseModel):
    number: int = Field(gt=0)
    url: str
    size: int = Field(ge=0)
    headers: dict[str, str] = Field(default_factory=dict)


class _Presigned(BaseModel):
    parts: list[_PresignedPart]


class _AppendPart(_PresignedPart):
    read_url: str | None = None
    read_headers: dict[str, str] = Field(default_factory=dict)


class _AppendPlan(BaseModel):
    upload_id: str
    part_size: int = Field(gt=0)
    base_size: int = Field(ge=0)
    upload_parts: list[_AppendPart] = Field(default_factory=list)


_BYTES = TypeAdapter(bytes)


def _url(accessor: TiDBFilesystemAccessor, remote_path: str) -> str:
    return f"{accessor.config.host}/v1/fs{quote(remote_path, safe='/')}"


def _headers(accessor: TiDBFilesystemAccessor) -> dict[str, str]:
    token = accessor.config.token.get_secret_value()
    return {"Authorization": f"Bearer {token}"}


def _name_of(remote_path: str) -> str:
    return remote_path.rstrip("/").rsplit("/", 1)[-1] or "/"


def _mtime_of(value: str | None) -> int | None:
    if value is None or not value.isdigit():
        return None
    return int(value)


def _size_of(data: bytes | ByteSpool) -> int:
    return data.size if isinstance(data, ByteSpool) else len(data)


async def _slice_of(data: bytes | ByteSpool, start: int, size: int) -> bytes:
    if isinstance(data, ByteSpool):
        return await data.read(start, size)
    return data[start : start + size]


async def _request(
    accessor: TiDBFilesystemAccessor,
    method: str,
    target: str,
    *,
    read: ReadMode = "json",
    params: Mapping[str, str] | None = None,
    json_body: JsonValue = None,
    data: bytes | None = None,
    headers: Mapping[str, str] | None = None,
    retry: RetryPolicy = NO_RETRY,
    window: ByteWindow | None = None,
) -> Any:
    return await api_request(
        method,
        target,
        error_of=error_of,
        headers={**_headers(accessor), **(headers or {})},
        params=params,
        json_body=json_body,
        data=data,
        session=accessor.pool,
        retry=retry,
        read=read,
        window=window,
    )


async def stat_entry(
    accessor: TiDBFilesystemAccessor,
    remote_path: str,
    directory: bool = False,
) -> Entry:
    """One path's metadata, from a HEAD.

    drive9 keeps a file and a directory of one name apart: the bare path
    answers the file when there is one, and the path with a trailing
    slash answers the directory.

    Args:
        accessor (TiDBFilesystemAccessor): the file system's accessor.
        remote_path (str): the path in the file system.
        directory (bool): look the path up as a directory.
    """
    target = remote_path.rstrip("/") + "/" if directory else remote_path
    response = await _request(
        accessor, "HEAD", _url(accessor, target), read="response"
    )
    is_dir = response.headers.get("x-dat9-isdir") == "true"
    return Entry(
        _name_of(remote_path),
        is_dir,
        0 if is_dir else int(response.headers.get("content-length", "0")),
        _mtime_of(response.headers.get("x-dat9-mtime")),
    )


async def stat_entries(
    accessor: TiDBFilesystemAccessor, remote_paths: list[str]
) -> list[Entry | None]:
    """Each path's metadata, None for a missing one, in as few requests as
    fs:batch-stat allows.

    Args:
        accessor (TiDBFilesystemAccessor): the file system's accessor.
        remote_paths (list[str]): the paths in the file system.
    """
    found: list[Entry | None] = []
    for start in range(0, len(remote_paths), BATCH_STAT_LIMIT):
        chunk = remote_paths[start : start + BATCH_STAT_LIMIT]
        paths: list[JsonValue] = list(chunk)
        raw = await _request(
            accessor,
            "POST",
            f"{accessor.config.host}/v1/fs:batch-stat",
            json_body={"paths": paths},
        )
        results = _BatchStat.model_validate(raw).results
        if len(results) != len(chunk):
            raise TiDBFilesystemApiError(
                502, "fs:batch-stat answered a different number of paths"
            )
        for remote_path, result in zip(chunk, results):
            if result.status == 404:
                found.append(None)
                continue
            if result.status != 200:
                raise TiDBFilesystemApiError(
                    result.status, result.error or f"HTTP {result.status}"
                )
            found.append(
                Entry(
                    _name_of(remote_path),
                    result.is_dir,
                    0 if result.is_dir else result.size,
                    result.mtime,
                )
            )
    return found


async def list_entries(
    accessor: TiDBFilesystemAccessor, remote_path: str
) -> list[Entry]:
    raw = await _request(
        accessor, "GET", _url(accessor, remote_path), params={"list": "1"}
    )
    return [
        Entry(entry.name, entry.is_dir, entry.size, entry.mtime)
        for entry in _Listing.model_validate(raw).entries
    ]


async def download(
    accessor: TiDBFilesystemAccessor,
    remote_path: str,
    *,
    window: ByteWindow | None = None,
) -> bytes:
    """A file's bytes. A large file answers with a redirect to its object,
    which the session follows with the Range and without the token.

    Args:
        accessor (TiDBFilesystemAccessor): the file system's accessor.
        remote_path (str): the file in the file system.
        window (ByteWindow | None): the byte range to read.
    """
    response = await _request(
        accessor,
        "GET",
        _url(accessor, remote_path),
        read="bytes",
        window=window,
    )
    return _BYTES.validate_python(response, strict=True)


async def download_stream(
    accessor: TiDBFilesystemAccessor, remote_path: str
) -> AsyncGenerator[bytes, None]:
    async with aclosing(
        api_stream(
            _url(accessor, remote_path),
            error_of=error_of,
            headers=_headers(accessor),
            session=accessor.pool,
        )
    ) as stream:
        async for chunk in stream:
            yield chunk


async def _put_part(
    accessor: TiDBFilesystemAccessor, part: _PresignedPart, body: bytes
) -> str:
    response = await api_request(
        "PUT",
        part.url,
        error_of=error_of,
        headers={
            key: value
            for key, value in part.headers.items()
            if key.lower() != "host"
        },
        data=body,
        session=accessor.pool,
        retry=NO_RETRY,
        read="response",
    )
    return str(response.headers.get("etag", ""))


async def _abort(
    accessor: TiDBFilesystemAccessor, method: str, target: str
) -> None:
    try:
        await _request(accessor, method, target, read="none")
    except Exception as exc:
        logger.debug("tidb_filesystem: abort %s failed: %s", target, exc)


async def _upload_parts(
    accessor: TiDBFilesystemAccessor,
    upload: _Upload,
    data: bytes | ByteSpool,
) -> list[JsonValue]:
    host = accessor.config.host

    async def put(part: _PresignedPart) -> JsonValue:
        start = (part.number - 1) * upload.part_size
        body = await _slice_of(data, start, part.size)
        return {
            "number": part.number,
            "etag": await _put_part(accessor, part, body),
        }

    parts: list[JsonValue] = []
    for first in range(1, upload.total_parts + 1, PRESIGN_BATCH):
        last = min(first + PRESIGN_BATCH, upload.total_parts + 1)
        raw = await _request(
            accessor,
            "POST",
            f"{host}/v2/uploads/{upload.upload_id}/presign-batch",
            json_body={
                "parts": [{"part_number": n} for n in range(first, last)]
            },
        )
        presigned = _Presigned.model_validate(raw).parts
        parts.extend(await bounded_map(presigned, put, MAX_UPLOAD_WORKERS))
    return parts


async def _upload_multipart(
    accessor: TiDBFilesystemAccessor,
    remote_path: str,
    data: bytes | ByteSpool,
) -> None:
    host = accessor.config.host
    raw = await _request(
        accessor,
        "POST",
        f"{host}/v2/uploads/initiate",
        json_body={"path": remote_path, "total_size": _size_of(data)},
    )
    upload = _Upload.model_validate(raw)
    try:
        parts = await _upload_parts(accessor, upload, data)
        await _request(
            accessor,
            "POST",
            f"{host}/v2/uploads/{upload.upload_id}/complete",
            json_body={"parts": parts},
            read="none",
        )
    except Exception:
        await _abort(
            accessor, "POST", f"{host}/v2/uploads/{upload.upload_id}/abort"
        )
        raise


async def upload(
    accessor: TiDBFilesystemAccessor,
    remote_path: str,
    data: bytes | ByteSpool,
) -> None:
    """Replace a file's bytes: one PUT below the inline threshold, a
    multipart upload through presigned part URLs from it on, each part
    read from ``data`` as it goes up.

    Args:
        accessor (TiDBFilesystemAccessor): the file system's accessor.
        remote_path (str): the file in the file system.
        data (bytes | ByteSpool): its new content.
    """
    size = _size_of(data)
    if size >= SMALL_FILE_LIMIT:
        await _upload_multipart(accessor, remote_path, data)
        return
    await _request(
        accessor,
        "PUT",
        _url(accessor, remote_path),
        headers={"Content-Type": "application/octet-stream"},
        data=await _slice_of(data, 0, size),
        read="none",
    )


async def append_to(
    accessor: TiDBFilesystemAccessor,
    remote_path: str,
    data: bytes | ByteSpool,
) -> bool:
    """Add bytes to the end of a file drive9 keeps in object storage.

    The server copies the parts the bytes leave alone into a new upload,
    the last part's own bytes come back through its read URL, and they
    go up again with the new ones. False, with nothing sent, for a file
    drive9 keeps inline (400) or a path that is not a file (404).

    Args:
        accessor (TiDBFilesystemAccessor): the file system's accessor.
        remote_path (str): the file in the file system.
        data (bytes | ByteSpool): the bytes to add.
    """
    host = accessor.config.host
    size = _size_of(data)
    try:
        raw = await _request(
            accessor,
            "POST",
            _url(accessor, remote_path),
            params={"append": ""},
            json_body={"append_size": size},
        )
    except TiDBFilesystemApiError as exc:
        if not (has_status(exc, 400) or has_status(exc, 404)):
            raise
        logger.debug("tidb_filesystem: no native append: %s", exc)
        return False
    plan = _AppendPlan.model_validate(raw)

    def kept(part: _AppendPart) -> int:
        start = (part.number - 1) * plan.part_size
        return max(0, min(plan.base_size, start + part.size) - start)

    async def put(part: _AppendPart) -> str:
        own = kept(part)
        original = b""
        if own and part.read_url is not None:
            original = _BYTES.validate_python(
                await api_request(
                    "GET",
                    part.read_url,
                    error_of=error_of,
                    headers=part.read_headers,
                    session=accessor.pool,
                    retry=NO_RETRY,
                    read="bytes",
                ),
                strict=True,
            )
        start = (part.number - 1) * plan.part_size + own - plan.base_size
        added = (
            await _slice_of(data, start, part.size - own)
            if part.size > own
            else b""
        )
        if len(original) != own or len(added) != part.size - own:
            raise TiDBFilesystemApiError(
                502, f"append part {part.number} does not match its plan"
            )
        return await _put_part(accessor, part, original + added)

    try:
        if sum(part.size - kept(part) for part in plan.upload_parts) != size:
            raise TiDBFilesystemApiError(
                502, "the append plan does not cover the appended bytes"
            )
        await bounded_map(plan.upload_parts, put, MAX_UPLOAD_WORKERS)
        await _request(
            accessor,
            "POST",
            f"{host}/v1/uploads/{plan.upload_id}/complete",
            read="none",
        )
    except Exception:
        await _abort(accessor, "DELETE", f"{host}/v1/uploads/{plan.upload_id}")
        raise
    return True


async def make_directory(
    accessor: TiDBFilesystemAccessor, remote_path: str
) -> None:
    await _request(
        accessor,
        "POST",
        _url(accessor, remote_path),
        params={"mkdir": ""},
        read="none",
    )


async def remove(
    accessor: TiDBFilesystemAccessor, remote_path: str, kind: str
) -> None:
    """Remove one entry of the given kind.

    Args:
        accessor (TiDBFilesystemAccessor): the file system's accessor.
        remote_path (str): the entry in the file system.
        kind (str): "file" or "dir"; a directory must be empty.
    """
    await _request(
        accessor,
        "DELETE",
        _url(accessor, remote_path),
        params={"kind": kind},
        read="none",
    )


async def remove_tree(
    accessor: TiDBFilesystemAccessor, remote_path: str
) -> None:
    await _request(
        accessor,
        "DELETE",
        _url(accessor, remote_path),
        params={"recursive": "1"},
        retry=TREE_DELETE_RETRY,
        read="none",
    )


async def move(
    accessor: TiDBFilesystemAccessor, remote_src: str, remote_dst: str
) -> None:
    source = base64.urlsafe_b64encode(remote_src.encode()).rstrip(b"=")
    await _request(
        accessor,
        "POST",
        _url(accessor, remote_dst),
        headers={
            "X-Dat9-Rename-Source": source.decode("ascii"),
            "X-Dat9-Path-Encoding": "base64url",
        },
        params={"rename": ""},
        read="none",
    )

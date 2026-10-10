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

import posixpath
from collections.abc import AsyncIterator, Mapping
from functools import partial
from typing import Any

from mirage.accessor.dropbox import DropboxAccessor
from mirage.cache.context import publish_read, writes_conditioned
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.cache.index.config import ListedMiss
from mirage.cache.index.warm import entry_or_listed_miss
from mirage.core.dropbox.client import (
    DropboxApiError,
    dropbox_download,
    dropbox_download_stream,
)
from mirage.core.dropbox.constants import (
    MISS_SUMMARIES,
    NOT_FILE_SUMMARY,
    RESULT_HEADER,
)
from mirage.core.dropbox.fingerprint import result_of, result_token
from mirage.core.dropbox.readdir import readdir
from mirage.errors.fs import eisdir, enoent
from mirage.observe.context import record, record_stream, start_op
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key, mount_prefix_of
from mirage.utils.ranges import window_for


def dropbox_path_from_virtual(root: str, virtual_key: str, prefix: str) -> str:
    key = virtual_key
    if prefix and key.startswith(prefix):
        key = key[len(prefix) :]
    key = key.strip("/")
    return root if not key else f"{root}/{key}"


async def _resolve_read(
    accessor: DropboxAccessor,
    path: PathSpec,
    index: IndexCacheStore,
) -> tuple[bool, str, str]:
    """Whether a read goes by path, with the index key and mount prefix.

    By path when the cached listing that omits the name is one the
    running command did not fetch; ENOENT or EISDIR for what the index
    answers. Mirrors TS ``resolveRead``.

    Args:
        accessor (DropboxAccessor): Dropbox accessor.
        path (PathSpec): the path read.
        index (IndexCacheStore): listing cache, consulted for the entry.
    """
    prefix = mount_prefix_of(path.virtual, path.vfs_path)
    p = path.virtual
    if prefix and p.startswith(prefix):
        p = p[len(prefix) :] or "/"
    key = p.strip("/")
    if not key:
        raise eisdir(path.virtual)
    virtual_key = prefix + "/" + key if prefix else "/" + key

    parent_key = posixpath.dirname(virtual_key) or "/"
    parent_path = PathSpec.from_str_path(
        parent_key, mount_key(parent_key, prefix)
    )
    # readdir already turns the API's 409 for a missing path into ENOENT,
    # so the only thing swallowed here is a genuinely absent parent.
    warm = (
        partial(readdir, accessor, parent_path, index)
        if parent_key != virtual_key
        else None
    )
    entry = await entry_or_listed_miss(index, virtual_key, warm)
    if entry is ListedMiss.UNTRUSTED:
        return True, virtual_key, prefix
    if entry is None:
        raise enoent(path.virtual)
    if entry.resource_type == "dropbox/folder":
        raise eisdir(path.virtual)
    return False, virtual_key, prefix


def _by_path_refusal(path: PathSpec, exc: DropboxApiError) -> OSError | None:
    """What a download by path that Dropbox refused means, or None.

    Only a miss is ENOENT and a folder's path EISDIR; any other refusal
    (restricted_content, a 5xx) names a file that may exist, and is
    raised as Dropbox sent it.

    Args:
        path (PathSpec): the path read.
        exc (DropboxApiError): the download's error.
    """
    if exc.status != 409:
        return None
    if exc.summary.startswith(MISS_SUMMARIES):
        return enoent(path.virtual)
    if exc.summary.startswith(NOT_FILE_SUMMARY):
        return eisdir(path.virtual)
    return None


def _check_name(path: PathSpec, result: dict[str, Any] | None) -> None:
    """Refuse a download by path that found the name in another case.

    Dropbox matches a path case-insensitively, a listing does not: a file
    stored as ``N`` is not ``n``. Only a name the result spells otherwise
    refuses: a result without one proves nothing, and calling it absent
    would let a write go out over a file that is there.

    Args:
        path (PathSpec): the path read.
        result (dict[str, Any] | None): the download's result metadata.
    """
    named = None if result is None else result.get("name")
    if isinstance(named, str) and named != posixpath.basename(
        path.vfs_path.strip("/")
    ):
        raise enoent(path.virtual)


async def read(
    accessor: DropboxAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
    offset: int = 0,
    size: int | None = None,
) -> bytes:
    """Read a file, optionally only a byte range of it.

    Args:
        accessor (DropboxAccessor): Dropbox accessor.
        path (PathSpec): the path to read.
        index (IndexCacheStore): listing cache, consulted for the entry.
        offset (int): first byte to read.
        size (int | None): how many bytes, or None for the rest.
    """
    window = window_for(offset, size)
    if index is NULL_INDEX:
        # Index-less callers (emulated truncate) download by path.
        by_path = True
        prefix = mount_prefix_of(path.virtual, path.vfs_path)
        virtual_key = path.virtual
    else:
        by_path, virtual_key, prefix = await _resolve_read(
            accessor, path, index
        )
    dropbox_path = dropbox_path_from_virtual(
        accessor.root_path, virtual_key, prefix
    )
    timer = start_op()
    try:
        data, result = await dropbox_download(
            accessor.token_manager, dropbox_path, window
        )
    except DropboxApiError as exc:
        refusal = _by_path_refusal(path, exc) if by_path else None
        if refusal is not None:
            raise refusal from exc
        raise
    meta = result_of(result)
    if by_path:
        _check_name(path, meta)
    token = result_token(meta)
    record(
        "read", path.virtual, "dropbox", len(data), timer, fingerprint=token
    )
    if window is None and writes_conditioned():
        publish_read(path.virtual, data, token)
    return data


async def read_stream(
    accessor: DropboxAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> AsyncIterator[bytes]:
    """Stream a file, stamped with its content_hash.

    Args:
        accessor (DropboxAccessor): Dropbox accessor.
        path (PathSpec): the path to read.
        index (IndexCacheStore): listing cache, consulted for the entry.
    """
    by_path, virtual_key, prefix = await _resolve_read(accessor, path, index)
    dropbox_path = dropbox_path_from_virtual(
        accessor.root_path, virtual_key, prefix
    )
    rec = record_stream("read", path.virtual, "dropbox")

    def stamp(headers: Mapping[str, str]) -> None:
        meta = result_of(headers.get(RESULT_HEADER.lower()))
        if by_path:
            _check_name(path, meta)
        if rec is not None:
            rec.fingerprint = result_token(meta)

    try:
        async for chunk in dropbox_download_stream(
            accessor.token_manager, dropbox_path, on_response=stamp
        ):
            if rec is not None:
                rec.bytes += len(chunk)
            yield chunk
    except DropboxApiError as exc:
        refusal = _by_path_refusal(path, exc) if by_path else None
        if refusal is not None:
            raise refusal from exc
        raise

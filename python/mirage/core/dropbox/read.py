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

from collections.abc import AsyncIterator, Mapping

from mirage.accessor.dropbox import DropboxAccessor
from mirage.cache.context import publish_read, writes_conditioned
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.cache.index.config import ListedMiss
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
from mirage.core.dropbox.paths import dropbox_path_of, spelled_otherwise
from mirage.core.dropbox.readdir import readdir
from mirage.core.hierarchy.probe import resolve_listed_entry
from mirage.errors.fs import eisdir, enoent
from mirage.observe.context import record, record_stream, start_op
from mirage.types import PathSpec
from mirage.utils.ranges import window_for


async def _resolve_read(
    accessor: DropboxAccessor,
    path: PathSpec,
    index: IndexCacheStore,
) -> bool:
    """Whether a read goes by path.

    By path when the cached listing that omits the name is one the
    running command did not fetch; ENOENT or EISDIR for what the index
    answers. Mirrors TS ``resolveRead``.

    Args:
        accessor (DropboxAccessor): Dropbox accessor.
        path (PathSpec): the path read.
        index (IndexCacheStore): listing cache, consulted for the entry.
    """
    if not path.vfs_path.strip("/"):
        raise eisdir(path.virtual)
    entry = await resolve_listed_entry(readdir, accessor, path, index)
    if entry is ListedMiss.UNTRUSTED:
        return True
    if entry is None:
        raise enoent(path.virtual)
    if entry.resource_type == "dropbox/folder":
        raise eisdir(path.virtual)
    return False


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
    # Index-less callers (emulated truncate) download by path and keep the
    # file Dropbox resolves the name to, in whatever case: their rewrite
    # uploads over that same file, so calling it absent would zero it.
    index_less = index is NULL_INDEX
    by_path = not index_less and await _resolve_read(accessor, path, index)
    timer = start_op()
    try:
        data, result = await dropbox_download(
            accessor.token_manager, dropbox_path_of(accessor, path), window
        )
    except DropboxApiError as exc:
        refusal = (
            _by_path_refusal(path, exc) if by_path or index_less else None
        )
        if refusal is not None:
            raise refusal from exc
        raise
    meta = result_of(result)
    if by_path and spelled_otherwise(path, meta):
        raise enoent(path.virtual)
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
    by_path = await _resolve_read(accessor, path, index)
    rec = record_stream("read", path.virtual, "dropbox")

    def stamp(headers: Mapping[str, str]) -> None:
        meta = result_of(headers.get(RESULT_HEADER.lower()))
        if by_path and spelled_otherwise(path, meta):
            raise enoent(path.virtual)
        if rec is not None:
            rec.fingerprint = result_token(meta)

    try:
        async for chunk in dropbox_download_stream(
            accessor.token_manager,
            dropbox_path_of(accessor, path),
            on_response=stamp,
        ):
            if rec is not None:
                rec.bytes += len(chunk)
            yield chunk
    except DropboxApiError as exc:
        refusal = _by_path_refusal(path, exc) if by_path else None
        if refusal is not None:
            raise refusal from exc
        raise

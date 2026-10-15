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
from mirage.core.dropbox.client import (
    DropboxApiError,
    dropbox_download,
    dropbox_download_stream,
)
from mirage.core.dropbox.constants import RESULT_HEADER
from mirage.core.dropbox.fingerprint import result_token
from mirage.core.dropbox.paths import dropbox_path_of
from mirage.errors.fs import eisdir, enoent
from mirage.observe.context import record, record_stream, start_op
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.ranges import window_for


def file_entry(path: PathSpec, entry: FileStat | None) -> FileStat:
    """What is at the file ``path``, as its parent's listing named it.

    Args:
        path (PathSpec): the file.
        entry (FileStat | None): what is at the path.

    Raises:
        FileNotFoundError: nothing is there.
        IsADirectoryError: a folder is.
    """
    if not path.vfs_path.strip("/"):
        raise eisdir(path.virtual)
    if entry is None:
        raise enoent(path.virtual)
    if entry.type is FileType.DIRECTORY:
        raise eisdir(path.virtual)
    return entry


async def read(
    accessor: DropboxAccessor,
    path: PathSpec,
    offset: int = 0,
    size: int | None = None,
    entry: FileStat | None = None,
) -> bytes:
    """Read a file, optionally only a byte range of it.

    Args:
        accessor (DropboxAccessor): Dropbox accessor.
        path (PathSpec): the path to read.
        offset (int): first byte to read.
        size (int | None): how many bytes, or None for the rest.
        entry (FileStat | None): what is at the path.
    """
    file_entry(path, entry)
    window = window_for(offset, size)
    timer = start_op()
    try:
        data, result = await dropbox_download(
            accessor.token_manager, dropbox_path_of(accessor, path), window
        )
    except DropboxApiError as exc:
        # The listing named a file Dropbox no longer has there.
        if exc.status == 409:
            raise enoent(path.virtual) from exc
        raise
    token = result_token(result)
    record(
        "read", path.virtual, "dropbox", len(data), timer, fingerprint=token
    )
    if window is None and writes_conditioned():
        publish_read(path.virtual, data, token)
    return data


async def read_stream(
    accessor: DropboxAccessor,
    path: PathSpec,
    entry: FileStat | None = None,
) -> AsyncIterator[bytes]:
    """Stream a file, stamped with its content_hash.

    Args:
        accessor (DropboxAccessor): Dropbox accessor.
        path (PathSpec): the path to read.
        entry (FileStat | None): what is at the path.
    """
    file_entry(path, entry)
    rec = record_stream("read", path.virtual, "dropbox")

    def stamp(headers: Mapping[str, str]) -> None:
        if rec is not None:
            rec.fingerprint = result_token(headers.get(RESULT_HEADER.lower()))

    async for chunk in dropbox_download_stream(
        accessor.token_manager,
        dropbox_path_of(accessor, path),
        on_response=stamp,
    ):
        if rec is not None:
            rec.bytes += len(chunk)
        yield chunk

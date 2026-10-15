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

import hashlib
from collections.abc import AsyncIterator

from mirage.accessor.box import BoxAccessor
from mirage.cache.context import publish_read, writes_conditioned
from mirage.core.box.api import download_file, download_file_stream
from mirage.core.box.fingerprint import entry_token, read_token
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
    accessor: BoxAccessor,
    path: PathSpec,
    offset: int = 0,
    size: int | None = None,
    entry: FileStat | None = None,
) -> bytes:
    """Read a file, optionally only a byte range of it.

    On a ``write: conditional`` mount a whole read stamps its bytes' own
    sha1, even through an outdated listing row.

    Args:
        accessor (BoxAccessor): Box accessor.
        path (PathSpec): the path to read.
        offset (int): first byte to read.
        size (int | None): how many bytes, or None for the rest.
        entry (FileStat | None): what is at the path.
    """
    found = file_entry(path, entry)
    timer = start_op()
    window = window_for(offset, size)
    data = await download_file(
        accessor.token_manager, found.extra["box_id"], window
    )
    fingerprint = None
    # Only a whole read (no window) through a row with a sha1 can yield a
    # token, so nothing else is hashed. The token never depends on a recorder
    # being bound (tests/vfs/test_read_revalidatable.py holds each declarer
    # to it).
    if window is None and entry_token(found) is not None:
        digest = hashlib.sha1(data).hexdigest()
        fingerprint = (
            digest if writes_conditioned() else read_token(found, digest)
        )
    publish_read(path.virtual, data, fingerprint)
    record(
        "read", path.virtual, "box", len(data), timer, fingerprint=fingerprint
    )
    return data


async def read_stream(
    accessor: BoxAccessor,
    path: PathSpec,
    entry: FileStat | None = None,
) -> AsyncIterator[bytes]:
    """Stream a file, stamped with its sha1 once it has been read whole.

    When a token can result (a recorder is bound and the row has a sha1),
    each chunk feeds a running SHA-1; the token lands only after the last
    chunk, so a stream abandoned part-way stamps nothing. The token is
    chosen as :func:`read` chooses it.

    Args:
        accessor (BoxAccessor): Box accessor.
        path (PathSpec): the path to read.
        entry (FileStat | None): what is at the path.
    """
    found = file_entry(path, entry)
    rec = record_stream("read", path.virtual, "box")
    conditioned = writes_conditioned()
    digest = (
        hashlib.sha1()
        if rec is not None and entry_token(found) is not None
        else None
    )
    async for chunk in download_file_stream(
        accessor.token_manager, found.extra["box_id"]
    ):
        if digest is not None:
            digest.update(chunk)
        if rec is not None:
            rec.bytes += len(chunk)
        yield chunk
    if rec is not None and digest is not None:
        token = digest.hexdigest()
        rec.fingerprint = token if conditioned else read_token(found, token)

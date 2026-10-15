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

from mirage.accessor.hf_hub import HfHubAccessor
from mirage.core.hf_hub.client import etag_value, hub_bytes_tagged, resolve_url
from mirage.core.hf_hub.constants import REFUSED_STATUSES
from mirage.core.hf_hub.lookup import refusals_denied
from mirage.errors.fs import eisdir, enoent
from mirage.observe.context import record, start_op
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.ranges import ByteWindow


def resolve_entry(path_spec: PathSpec, entry: FileStat | None) -> FileStat:
    """The file's row, or the error that says why there is none.

    Shared by every content read so a file, a directory and an absence
    are told apart in exactly one place. It also means a read never
    reaches the network for a path the listing already knows is absent.
    The row is also where the read's token comes from (``row_token``).

    Args:
        path_spec (PathSpec): the path being read.
        entry (FileStat | None): the path's row.

    Raises:
        FileNotFoundError: nothing exists at the path.
        IsADirectoryError: the path names a directory.
    """
    if not path_spec.mount_path.strip("/"):
        raise eisdir(path_spec.virtual)
    if entry is None:
        raise enoent(path_spec.virtual)
    if entry.type is FileType.DIRECTORY:
        raise eisdir(path_spec.virtual)
    return entry


def row_token(entry: FileStat, etag: str) -> str | None:
    """The row's oid, if the response's ETag shows the bytes are that row's.

    The listing can be older than the download: the listing lives until
    the mount re-lists it, while resolve always serves the revision's
    current bytes. Stamping the listing's oid on newer bytes would let a
    later revert to that oid pass them off as fresh, so the oid is stamped
    only when the ETag names one of the row's own ids (the oid for a plain
    file, the xet hash for a Xet one), and otherwise nothing is.

    Args:
        entry (FileStat): the file's row.
        etag (str): the final response's ETag header.

    Returns:
        str | None: the oid to stamp, or None.
    """
    ids = {
        entry.fingerprint,
        entry.extra.get("lfs_oid"),
        entry.extra.get("xet_hash"),
    } - {"", None}
    if etag_value(etag) not in ids:
        return None
    return entry.fingerprint


async def read(
    accessor: HfHubAccessor,
    path: PathSpec,
    offset: int = 0,
    size: int | None = None,
    entry: FileStat | None = None,
) -> bytes:
    """Read a file's content, or a byte window of it.

    Args:
        accessor (HfHubAccessor): backend handle.
        path (PathSpec): the file to read.
        offset (int): first byte to read.
        size (int | None): how many bytes; None reads to the end.
        entry (FileStat | None): the file's row.

    Returns:
        bytes: the content.
    """
    row = resolve_entry(path, entry)
    url = resolve_url(
        accessor.endpoint,
        accessor.repo_type,
        accessor.repo_id,
        accessor.revision,
        accessor.repo_path(path.mount_path),
    )
    window = (
        ByteWindow(offset=offset, size=size)
        if offset or size is not None
        else None
    )
    timer = start_op()
    with refusals_denied(path, REFUSED_STATUSES):
        data, etag = await hub_bytes_tagged(
            accessor.token, url, window, session=accessor.pool
        )
    record(
        "read",
        path.virtual,
        accessor.VFS_NAME,
        len(data),
        timer,
        fingerprint=row_token(row, etag),
    )
    return data

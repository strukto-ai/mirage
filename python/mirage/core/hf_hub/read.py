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
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.core.hf_hub.client import etag_value, hub_bytes_tagged, resolve_url
from mirage.core.hf_hub.constants import REFUSED_STATUSES
from mirage.core.hf_hub.lookup import key_of, lookup_retrying, refusals_denied
from mirage.errors.fs import eisdir, enoent
from mirage.observe.context import record, start_op
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of
from mirage.utils.ranges import ByteWindow


async def resolve_entry(
    accessor: HfHubAccessor,
    path_spec: PathSpec,
    index: IndexCacheStore,
) -> IndexEntry:
    """The tree row for a path, or the error that says why there is none.

    Shared by every content read so a file, a directory and an absence
    are told apart in exactly one place. It also means a read never
    reaches the network for a path the listing already knows is absent.
    The row is also where the read's token comes from (``row_token``).

    Args:
        accessor (HfHubAccessor): backend handle.
        path_spec (PathSpec): the path being read.
        index (IndexCacheStore): the mount's index.

    Returns:
        IndexEntry: the row for the path.

    Raises:
        FileNotFoundError: nothing exists at the path.
        IsADirectoryError: the path names a directory.
    """
    virtual = path_spec.virtual
    prefix = mount_prefix_of(path_spec.virtual, path_spec.vfs_path)
    rel = path_spec.mount_path.strip("/")
    if not rel:
        raise eisdir(virtual)
    with refusals_denied(path_spec):
        found = await lookup_retrying(
            accessor, index, prefix, key_of(prefix, rel)
        )
    if found.is_dir:
        raise eisdir(virtual)
    if found.entry is None:
        raise enoent(virtual)
    return found.entry


def row_token(entry: IndexEntry, etag: str) -> str | None:
    """The row's oid, if the response's ETag shows the bytes are that row's.

    The listing can be older than the download: the tree lives until a
    verdict clears it, while resolve always serves the revision's current
    bytes. Stamping the listing's oid on newer bytes would let a later
    revert to that oid pass them off as fresh, so the oid is stamped only
    when the ETag names one of the row's own ids (the oid for a plain file,
    the xet hash for a Xet one), and otherwise nothing is.

    Args:
        entry (IndexEntry): the tree row the read resolved.
        etag (str): the final response's ETag header.

    Returns:
        str | None: the oid to stamp, or None.
    """
    ids = {
        entry.id,
        entry.extra.get("lfs_oid"),
        entry.extra.get("xet_hash"),
    } - {"", None}
    if etag_value(etag) not in ids:
        return None
    return entry.id or None


async def read(
    accessor: HfHubAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
    offset: int = 0,
    size: int | None = None,
) -> bytes:
    """Read a file's content, or a byte window of it.

    Args:
        accessor (HfHubAccessor): backend handle.
        path (PathSpec): the file to read.
        index (IndexCacheStore): the mount's index.
        offset (int): first byte to read.
        size (int | None): how many bytes; None reads to the end.

    Returns:
        bytes: the content.
    """
    entry = await resolve_entry(accessor, path, index)
    raw = path.mount_path
    url = resolve_url(
        accessor.endpoint,
        accessor.repo_type,
        accessor.repo_id,
        accessor.revision,
        accessor.repo_path(raw),
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
        fingerprint=row_token(entry, etag),
    )
    return data

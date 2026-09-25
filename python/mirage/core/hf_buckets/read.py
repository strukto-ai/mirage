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

from mirage.accessor.hf_buckets import HfBucketsAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.hf_buckets.hub import read_token, resolve_url
from mirage.core.hf_hub.client import HfHubError, hub_bytes_tagged
from mirage.core.hf_hub.constants import REFUSED_STATUSES
from mirage.core.hf_hub.lookup import refusals_denied
from mirage.observe.context import record, start_op
from mirage.types import PathSpec
from mirage.utils.errors import eisdir, enoent
from mirage.utils.ranges import ByteWindow

MISSING_ENTRY = "EntryNotFound"

UNSATISFIABLE = 416


def is_missing(exc: HfHubError) -> bool:
    """Whether a download refusal says the file does not exist.

    Only a 404 carrying ``EntryNotFound`` does. A 404 without it (a CDN
    hop, a bucket the token cannot see) is a failed read of a file that
    may well exist, and reading it as absence would let reconcile drop
    the path's overlay.

    Args:
        exc (HfHubError): the refusal.
    """
    return exc.status == 404 and exc.error_code == MISSING_ENTRY


async def read_bytes(accessor: HfBucketsAccessor,
                     path: PathSpec,
                     index: IndexCacheStore = NULL_INDEX,
                     offset: int = 0,
                     size: int | None = None) -> bytes:
    """Read a bucket file, or a byte window of it, from the Hub.

    Not through opendal: its read returns bare bytes, and the ETag the
    download carries is the file's xet hash, the token stat reports, so it
    is stamped on the read record as it comes.

    Args:
        accessor (HfBucketsAccessor): bucket accessor.
        path (PathSpec): the file to read.
        index (IndexCacheStore): the mount's index.
        offset (int): first byte to read.
        size (int | None): how many bytes; None reads to the end.

    Returns:
        bytes: the content.
    """
    rel = path.mount_path
    if not rel.strip("/"):
        raise eisdir(path)
    if size == 0:
        # No request: a zero-length Range header is not one the Hub, or
        # the client building it, accepts.
        return b""
    window = ByteWindow(offset=offset,
                        size=size) if offset or size is not None else None
    timer = start_op()
    try:
        with refusals_denied(path, REFUSED_STATUSES):
            data, etag = await hub_bytes_tagged(accessor.token,
                                                resolve_url(accessor, rel),
                                                window,
                                                session=accessor.pool)
    except HfHubError as exc:
        if is_missing(exc):
            raise enoent(path) from exc
        if exc.status != UNSATISFIABLE or window is None:
            raise
        # A window starting at or past EOF: the Hub answers 416 where a
        # POSIX read returns nothing. Folded here rather than left to the
        # ops factory, because a caller reading the range door directly
        # (the VFS range_read, tail -f) has no fold of its own.
        data, etag = b"", ""
    record("read",
           path.virtual,
           accessor.VFS_NAME,
           len(data),
           timer,
           fingerprint=read_token(etag))
    return data

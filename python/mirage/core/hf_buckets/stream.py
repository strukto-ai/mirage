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

from mirage.accessor.hf_buckets import HfBucketsAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.hf_buckets.constants import DEFAULT_CHUNK_SIZE
from mirage.core.hf_buckets.hub import read_token, resolve_url
from mirage.core.hf_buckets.read import is_missing, read_bytes
from mirage.core.hf_hub.client import HfHubError, hub_stream
from mirage.core.hf_hub.constants import REFUSED_STATUSES
from mirage.core.hf_hub.lookup import refusals_denied
from mirage.observe.context import record_stream
from mirage.types import PathSpec
from mirage.utils.errors import eisdir, enoent


async def range_read(accessor: HfBucketsAccessor, path: PathSpec, start: int,
                     end: int) -> bytes:
    """Read a byte range, in the VFS API's end-exclusive spelling.

    Args:
        accessor (HfBucketsAccessor): bucket accessor.
        path (PathSpec): the path to read.
        start (int): first byte to read.
        end (int): one past the last byte to read.
    """
    return await read_bytes(accessor, path, offset=start, size=end - start)


async def read_stream(
    accessor: HfBucketsAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
) -> AsyncIterator[bytes]:
    """Stream a bucket file from the Hub, stamped with its ETag.

    Args:
        accessor (HfBucketsAccessor): bucket accessor.
        path (PathSpec): the file to read.
        index (IndexCacheStore): the mount's index.
        chunk_size (int): bytes per yielded chunk.

    Yields:
        bytes: the next chunk of content.
    """
    rel = path.mount_path
    if not rel.strip("/"):
        raise eisdir(path)
    rec = record_stream("read", path.virtual, accessor.VFS_NAME)

    def stamp(headers: Mapping[str, str]) -> None:
        if rec is not None:
            rec.fingerprint = read_token(headers.get("etag", ""))

    try:
        with refusals_denied(path, REFUSED_STATUSES):
            async for chunk in hub_stream(accessor.token,
                                          resolve_url(accessor, rel),
                                          chunk_size,
                                          session=accessor.pool,
                                          on_response=stamp):
                if rec is not None:
                    rec.bytes += len(chunk)
                yield chunk
    except HfHubError as exc:
        if is_missing(exc):
            raise enoent(path) from exc
        raise

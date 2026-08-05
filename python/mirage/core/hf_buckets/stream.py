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

from collections.abc import AsyncIterator

from opendal.exceptions import NotFound

from mirage.accessor.hf_buckets import HfBucketsAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.hf_buckets.constants import DEFAULT_CHUNK_SIZE
from mirage.core.hf_buckets.read import read_bytes
from mirage.observe.context import record_stream
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def range_read(accessor: HfBucketsAccessor, path: PathSpec, start: int,
                     end: int) -> bytes:
    """Read a byte range, in the resource API's end-exclusive spelling.

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
    raw = path.mount_path
    key = raw.lstrip("/")
    op = accessor.operator()
    rec = record_stream("read", raw, accessor.RESOURCE_NAME)
    try:
        async with await op.open(key, "rb") as f:
            while True:
                chunk = await f.read(chunk_size)
                if not chunk:
                    break
                chunk_bytes = bytes(chunk)
                if rec is not None:
                    rec.bytes += len(chunk_bytes)
                yield chunk_bytes
    except NotFound as exc:
        raise enoent(path) from exc

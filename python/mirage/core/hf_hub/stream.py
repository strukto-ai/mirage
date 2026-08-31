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

from mirage.accessor.hf_hub import HfHubAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.hf_hub.client import hub_stream, resolve_url
from mirage.core.hf_hub.constants import DEFAULT_CHUNK_SIZE
from mirage.core.hf_hub.read import read_bytes, resolve_entry
from mirage.observe.context import record_stream
from mirage.types import PathSpec


async def range_read(accessor: HfHubAccessor, path: PathSpec, start: int,
                     end: int) -> bytes:
    """Read a byte range, in the resource API's end-exclusive spelling.

    Args:
        accessor (HfHubAccessor): backend handle.
        path (PathSpec): the path to read.
        start (int): first byte to read.
        end (int): one past the last byte to read.

    Returns:
        bytes: the requested window.
    """
    return await read_bytes(accessor, path, offset=start, size=end - start)


async def read_stream(
    accessor: HfHubAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
) -> AsyncIterator[bytes]:
    """Stream a file's content.

    Args:
        accessor (HfHubAccessor): backend handle.
        path (PathSpec): the file to read.
        index (IndexCacheStore): the mount's index.
        chunk_size (int): bytes per yielded chunk.

    Yields:
        bytes: the next chunk of content.
    """
    await resolve_entry(accessor, path, index)
    raw = path.mount_path
    url = resolve_url(accessor.endpoint, accessor.repo_type, accessor.repo_id,
                      accessor.revision, accessor.repo_path(raw))
    rec = record_stream("read", raw, accessor.RESOURCE_NAME)
    async for chunk in hub_stream(accessor.token,
                                  url,
                                  chunk_size,
                                  session=accessor.pool):
        if rec is not None:
            rec.bytes += len(chunk)
        yield chunk

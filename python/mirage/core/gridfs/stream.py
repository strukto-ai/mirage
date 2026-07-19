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

from bson import ObjectId
from gridfs.errors import NoFile

from mirage.accessor.gridfs import GridFSAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.gridfs._client import _key, bucket, latest_file
from mirage.core.gridfs.read import read_bytes
from mirage.observe.context import record_stream, revision_for
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def read_stream(
    accessor: GridFSAccessor,
    path_spec: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
    chunk_size: int = 8192,
) -> AsyncIterator[bytes]:
    """Async generator yielding chunks of a GridFS file.

    Args:
        accessor (GridFSAccessor): GridFS accessor.
        path_spec (PathSpec): File path.
        index: Index cache store.
        chunk_size (int): Size of each chunk in bytes.
    """
    virtual = path_spec.virtual
    path = path_spec.mount_path
    config = accessor.config
    key = _key(path, config)
    pinned_revision = revision_for(virtual)
    rec = record_stream("read", path, "gridfs")
    if pinned_revision is not None:
        file_id = ObjectId(pinned_revision)
    else:
        doc = await latest_file(accessor, key)
        if doc is None:
            raise enoent(virtual)
        file_id = doc["_id"]
    try:
        out = await bucket(accessor).open_download_stream(file_id)
    except NoFile as exc:
        raise enoent(virtual) from exc
    if rec is not None:
        revision = str(file_id)
        rec.fingerprint = revision
        rec.revision = revision
    try:
        while True:
            chunk = await out.read(chunk_size)
            if not chunk:
                break
            if rec is not None:
                rec.bytes += len(chunk)
            yield bytes(chunk)
    finally:
        await out.close()


async def range_read(accessor: GridFSAccessor, path_spec: PathSpec, start: int,
                     end: int) -> bytes:
    """Read a byte range from a GridFS file.

    Args:
        accessor (GridFSAccessor): GridFS accessor.
        path_spec (PathSpec): File path.
        start (int): Start byte offset.
        end (int): End byte offset (exclusive).
    """
    return await read_bytes(accessor,
                            path_spec,
                            offset=start,
                            size=end - start)

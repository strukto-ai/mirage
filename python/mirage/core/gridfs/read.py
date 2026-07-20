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

import time

from bson import ObjectId
from gridfs.errors import NoFile

from mirage.accessor.gridfs import GridFSAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.gridfs._client import _key, bucket, latest_file
from mirage.observe.context import record, revision_for
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def read_bytes(accessor: GridFSAccessor,
                     path_spec: PathSpec,
                     index: IndexCacheStore = NULL_INDEX,
                     offset: int = 0,
                     size: int | None = None) -> bytes:
    """Read bytes from GridFS, with optional range read.

    Args:
        accessor (GridFSAccessor): GridFS accessor.
        path_spec (PathSpec): File path.
        index: Index cache store.
        offset (int): Byte offset for range reads.
        size (int | None): Number of bytes for range reads.
    """
    virtual = path_spec.virtual
    path = path_spec.mount_path
    config = accessor.config
    key = _key(path, config)
    start_ms = int(time.monotonic() * 1000)
    pinned_revision = revision_for(virtual)
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
    try:
        if offset:
            await out.seek(offset)
        data = await out.read(size if size is not None else -1)
    finally:
        await out.close()
    revision = str(file_id)
    record("read",
           path,
           "gridfs",
           len(data),
           start_ms,
           fingerprint=revision,
           revision=revision)
    return data

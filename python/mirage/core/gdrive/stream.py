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

import posixpath
from collections.abc import AsyncIterator

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.gdocs.read import read_doc
from mirage.core.gdrive import DIRECTORY_RESOURCE_TYPES
from mirage.core.gdrive.readdir import readdir
from mirage.core.google.drive import download_file_stream
from mirage.core.gsheets.read import read_spreadsheet
from mirage.core.gslides.read import read_presentation
from mirage.observe.context import record_stream
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_key, mount_prefix_of


async def read_stream(
    accessor: GDriveAccessor,
    path_spec: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
    chunk_size: int = 8192,
) -> AsyncIterator[bytes] | bytes:
    virtual = path_spec.virtual
    prefix = mount_prefix_of(path_spec.virtual, path_spec.resource_path)
    path = path_spec.virtual

    if prefix and path.startswith(prefix):
        rest = path[len(prefix):]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            path = rest or "/"
    key = path.strip("/")
    virtual_key = prefix + "/" + key if prefix else "/" + key
    result = await index.get(virtual_key)
    if result.entry is None:
        # cold index: list the parent directory to populate the entry,
        # then retry
        parent_key = posixpath.dirname(virtual_key) or "/"
        if parent_key != virtual_key:
            parent_path = PathSpec.from_str_path(parent_key,
                                                 mount_key(parent_key, prefix))
            try:
                await readdir(accessor, parent_path, index)
                result = await index.get(virtual_key)
            except Exception:
                # parent refresh failed; fall through to FileNotFoundError
                pass
        if result.entry is None:
            raise enoent(virtual)
    rt = result.entry.resource_type
    if rt in DIRECTORY_RESOURCE_TYPES:
        raise IsADirectoryError(virtual)
    if rt == "gdrive/gdoc":
        return await read_doc(accessor.token_manager, result.entry.id)
    if rt == "gdrive/gsheet":
        return await read_spreadsheet(accessor.token_manager, result.entry.id)
    if rt == "gdrive/gslide":
        return await read_presentation(accessor.token_manager, result.entry.id)
    return _stream_file(accessor, result.entry.id, path, chunk_size)


async def stream(
    accessor: GDriveAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
    chunk_size: int = 8192,
) -> AsyncIterator[bytes]:
    result = await read_stream(accessor, path, index, chunk_size)
    if isinstance(result, bytes):
        yield result
        return
    async for chunk in result:
        yield chunk


async def _stream_file(
    accessor: GDriveAccessor,
    file_id: str,
    path: str,
    chunk_size: int,
) -> AsyncIterator[bytes]:
    rec = record_stream("read", path, "gdrive")
    async for chunk in download_file_stream(accessor.token_manager, file_id,
                                            chunk_size):
        if rec is not None:
            rec.bytes += len(chunk)
        yield chunk

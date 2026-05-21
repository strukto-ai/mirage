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

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.gdocs.read import read_doc
from mirage.core.google.drive import download_file_stream
from mirage.core.gsheets.read import read_spreadsheet
from mirage.core.gslides.read import read_presentation
from mirage.observe.context import record_stream
from mirage.types import PathSpec


async def read_stream(
    accessor: GDriveAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
    chunk_size: int = 8192,
) -> AsyncIterator[bytes] | bytes:
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    if isinstance(path, PathSpec):
        prefix = path.prefix
        path = path.original

    if prefix and path.startswith(prefix):
        rest = path[len(prefix):]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            path = rest or "/"
    key = path.strip("/")
    if index is None:
        raise FileNotFoundError(path)
    virtual_key = prefix + "/" + key if prefix else "/" + key
    result = await index.get(virtual_key)
    if result.entry is None:
        raise FileNotFoundError(path)
    rt = result.entry.resource_type
    if rt == "gdrive/gdoc":
        return await read_doc(accessor.token_manager, result.entry.id)
    if rt == "gdrive/gsheet":
        return await read_spreadsheet(accessor.token_manager, result.entry.id)
    if rt == "gdrive/gslide":
        return await read_presentation(accessor.token_manager, result.entry.id)
    return _stream_file(accessor, result.entry.id, path, chunk_size)


async def _stream_file(
    accessor: GDriveAccessor,
    file_id: str,
    path: PathSpec,
    chunk_size: int,
) -> AsyncIterator[bytes]:
    rec = record_stream("read", path, "gdrive")
    async for chunk in download_file_stream(accessor.token_manager, file_id,
                                            chunk_size):
        if rec is not None:
            rec.bytes += len(chunk)
        yield chunk

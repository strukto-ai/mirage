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

import json
import logging
import posixpath
from collections.abc import AsyncIterator

from mirage.accessor.box import BoxAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.core.box._client import BoxTokenManager
from mirage.core.box.api import (download_file, download_file_stream,
                                 get_extracted_text)
from mirage.core.box.readdir import readdir
from mirage.core.filetype.boxcanvas import process_boxcanvas
from mirage.core.filetype.boxnote import process_boxnote
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_key, mount_prefix_of

logger = logging.getLogger(__name__)

OFFICE_FORMAT_BY_RT = {
    "box/gdoc": "docx",
    "box/gsheet": "xlsx",
    "box/gslides": "pptx",
}


async def _process_box_office(tm: BoxTokenManager, entry: IndexEntry,
                              office_format: str) -> bytes:
    body_text = await get_extracted_text(tm, entry.id)
    envelope = {
        "id": entry.id,
        "name": entry.vfs_name or entry.name,
        "format": office_format,
        "size": entry.size,
        "modified_at": entry.remote_time,
        "body_text": body_text,
    }
    return (json.dumps(envelope, indent=2, ensure_ascii=False) +
            "\n").encode("utf-8")


async def _resolve_entry(
    accessor: BoxAccessor,
    path: PathSpec,
    index: IndexCacheStore,
) -> IndexEntry:
    virtual = path.virtual
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    key = path.resource_path
    if not key:
        raise IsADirectoryError(virtual)
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
            except FileNotFoundError as exc:
                logger.debug("read populate failed for %s: %s", virtual_key,
                             exc)
        if result.entry is None:
            raise enoent(virtual)
    if result.entry.resource_type == "box/folder":
        raise IsADirectoryError(virtual)
    return result.entry


async def read(
    accessor: BoxAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> bytes:
    entry = await _resolve_entry(accessor, path, index)
    rt = entry.resource_type
    office_format = OFFICE_FORMAT_BY_RT.get(rt)
    if office_format is not None:
        return await _process_box_office(accessor.token_manager, entry,
                                         office_format)
    raw = await download_file(accessor.token_manager, entry.id)
    if rt == "box/boxnote":
        return process_boxnote(raw)
    if rt == "box/boxcanvas":
        return process_boxcanvas(raw)
    return raw


async def stream(
    accessor: BoxAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> AsyncIterator[bytes]:
    entry = await _resolve_entry(accessor, path, index)
    rt = entry.resource_type
    office_format = OFFICE_FORMAT_BY_RT.get(rt)
    if office_format is not None:
        yield await _process_box_office(accessor.token_manager, entry,
                                        office_format)
        return
    if rt in ("box/boxnote", "box/boxcanvas"):
        # Box-native JSON formats are tiny; fetch all then process --
        # streaming the raw JSON would force callers to parse partial
        # bytes anyway.
        raw = await download_file(accessor.token_manager, entry.id)
        yield (process_boxnote(raw)
               if rt == "box/boxnote" else process_boxcanvas(raw))
        return
    async for chunk in download_file_stream(accessor.token_manager, entry.id):
        yield chunk

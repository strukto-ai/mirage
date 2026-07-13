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

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.gdocs.read import read_doc
from mirage.core.gdrive import DIRECTORY_RESOURCE_TYPES
from mirage.core.gdrive.readdir import readdir
from mirage.core.google._client import TokenManager
from mirage.core.google.drive import download_file
from mirage.core.gsheets.read import read_spreadsheet
from mirage.core.gslides.read import read_presentation
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_key, mount_prefix_of


async def read_bytes(
    token_manager: TokenManager,
    file_id: str,
) -> bytes:
    return await download_file(token_manager, file_id)


async def read(
    accessor: GDriveAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> bytes:
    virtual = path.virtual
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    key = path.resource_path
    if index is None:
        raise enoent(virtual)
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
    if result.entry.resource_type in DIRECTORY_RESOURCE_TYPES:
        raise IsADirectoryError(virtual)
    if result.entry.resource_type == "gdrive/gdoc":
        return await read_doc(accessor.token_manager, result.entry.id)
    if result.entry.resource_type == "gdrive/gsheet":
        return await read_spreadsheet(accessor.token_manager, result.entry.id)
    if result.entry.resource_type == "gdrive/gslide":
        return await read_presentation(accessor.token_manager, result.entry.id)
    return await download_file(accessor.token_manager, result.entry.id)

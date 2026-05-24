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

import logging

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.core.databricks_volume.errors import is_not_found
from mirage.core.databricks_volume.path import backend_path, virtual_path
from mirage.types import PathSpec

logger = logging.getLogger(__name__)
SCOPE_ERROR = 10_000


async def readdir(
    accessor: DatabricksVolumeAccessor,
    path: PathSpec,
    index: IndexCacheStore,
) -> list[str]:
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    list_path = path.dir if path.pattern else path
    virtual_key = list_path.original.rstrip("/") or "/"
    listing = await index.list_dir(virtual_key)
    if listing.entries is not None:
        return listing.entries
    remote_path = backend_path(accessor.config, list_path)
    try:
        entries = list(accessor.files.list_directory_contents(remote_path))
    except Exception as exc:
        if is_not_found(exc):
            raise FileNotFoundError(list_path.strip_prefix) from exc
        raise
    pairs = sorted(
        (virtual_path(accessor.config, entry.path, path.prefix), entry)
        for entry in entries)
    names = [name for name, _ in pairs]
    if len(names) > SCOPE_ERROR:
        logger.warning(
            "databricks_volume readdir: %s returned %d entries (limit %d)",
            virtual_key,
            len(names),
            SCOPE_ERROR,
        )
    index_entries = []
    for full_path, entry in pairs:
        name = full_path.rstrip("/").rsplit("/", 1)[-1]
        resource_type = "folder" if getattr(entry, "is_directory",
                                            False) else "file"
        index_entries.append((name,
                              IndexEntry(
                                  id=full_path,
                                  name=name,
                                  resource_type=resource_type,
                                  size=getattr(entry, "file_size", None),
                              )))
    await index.set_dir(virtual_key, index_entries)
    return names

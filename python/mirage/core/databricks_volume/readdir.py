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
from collections.abc import Awaitable, Callable
from functools import partial

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.core.databricks_volume.errors import is_not_found
from mirage.core.databricks_volume.path import backend_path, virtual_path
from mirage.core.databricks_volume.stat import modified_to_iso
from mirage.types import PathSpec
from mirage.utils.errors import listing_error
from mirage.utils.key_prefix import mount_prefix_of

logger = logging.getLogger(__name__)
SCOPE_ERROR = 10_000

Probe = Callable[[DatabricksVolumeAccessor, str], Awaitable[None]]


async def _probe_file(accessor: DatabricksVolumeAccessor,
                      remote_path: str) -> None:
    await accessor.client.get_metadata(remote_path)


async def _probe_directory(accessor: DatabricksVolumeAccessor,
                           remote_path: str) -> None:
    await accessor.client.get_directory_metadata(remote_path)


async def _exists(accessor: DatabricksVolumeAccessor, probe: Probe,
                  key: str) -> bool:
    try:
        await probe(accessor, backend_path(accessor.config, key))
    except Exception as exc:
        if is_not_found(exc):
            return False
        raise
    return True


async def _is_file(accessor: DatabricksVolumeAccessor, key: str) -> bool:
    return await _exists(accessor, _probe_file, key)


async def _is_dir(accessor: DatabricksVolumeAccessor, key: str) -> bool:
    return await _exists(accessor, _probe_directory, key)


async def readdir(
    accessor: DatabricksVolumeAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> list[str]:
    list_path = path.dir if path.pattern else path
    virtual_key = list_path.virtual.rstrip("/") or "/"
    listing = await index.list_dir(virtual_key)
    if listing.entries is not None:
        return listing.entries
    remote_path = backend_path(accessor.config, list_path)
    try:
        entries = await accessor.client.list_directory(remote_path)
    except Exception as exc:
        # The Files API answers 404 for a missing path and for a path under
        # a file alike, so the errno comes from walking the ancestors: one
        # metadata request per component, on this failure path only.
        if is_not_found(exc):
            raise await listing_error(list_path, list_path.mount_path,
                                      partial(_is_file, accessor),
                                      partial(_is_dir, accessor)) from exc
        raise
    pairs = sorted(
        (virtual_path(accessor.config, entry.path,
                      mount_prefix_of(path.virtual, path.resource_path)),
         entry) for entry in entries)
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
        resource_type = "folder" if entry.is_directory else "file"
        remote_time = modified_to_iso(entry.last_modified)
        size = entry.file_size
        if not entry.is_directory and size is None:
            # DirectoryEntry normally carries file_size; when the lister
            # omits it, one HEAD per affected file fills the gap so the
            # index never caches an unknown size.
            metadata = await accessor.client.get_metadata(entry.path)
            size = metadata.content_length
        index_entries.append((name,
                              IndexEntry(
                                  id=full_path,
                                  name=name,
                                  resource_type=resource_type,
                                  size=size,
                                  remote_time=remote_time or "",
                              )))
    await index.set_dir(virtual_key, index_entries)
    return names

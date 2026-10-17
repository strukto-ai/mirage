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
from mirage.core.databricks_volume.client import (
    get_directory_metadata,
    get_metadata,
    list_directory_contents,
)
from mirage.core.databricks_volume.errors import is_not_found
from mirage.core.databricks_volume.path import backend_path
from mirage.core.databricks_volume.stat import modified_to_iso
from mirage.core.databricks_volume.types import FileMetadata
from mirage.errors.fs import listing_error
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.filetype import content_type_for_path
from mirage.vfs.databricks_volume.config import DatabricksVolumeConfig

logger = logging.getLogger(__name__)
SCOPE_ERROR = 10_000


async def _exists(
    config: DatabricksVolumeConfig,
    probe: Callable[[str], Awaitable[FileMetadata | None]],
    key: str,
) -> bool:
    try:
        await probe(backend_path(config, key))
    except Exception as exc:
        if is_not_found(exc):
            return False
        raise
    return True


async def _is_file(accessor: DatabricksVolumeAccessor, key: str) -> bool:
    return await _exists(accessor.config, partial(get_metadata, accessor), key)


async def _is_dir(accessor: DatabricksVolumeAccessor, key: str) -> bool:
    return await _exists(
        accessor.config, partial(get_directory_metadata, accessor), key
    )


async def readdir(
    accessor: DatabricksVolumeAccessor, path: PathSpec
) -> list[FileStat]:
    """A folder's rows, as the Files API lists them.

    Args:
        accessor (DatabricksVolumeAccessor): Databricks accessor.
        path (PathSpec): the folder, or a glob word in it.

    Raises:
        FileNotFoundError: nothing is at the path.
        NotADirectoryError: the path, or a folder above it, is a file.
    """
    list_path = path.dir if path.pattern else path
    remote_path = backend_path(accessor.config, list_path)
    try:
        entries = await list_directory_contents(accessor, remote_path)
    except Exception as exc:
        # The Files API answers 404 for a missing path and for a path under
        # a file alike, so the errno comes from walking the ancestors: one
        # metadata request per component, on this failure path only.
        if is_not_found(exc):
            raise await listing_error(
                list_path,
                list_path.mount_path,
                partial(_is_file, accessor),
                partial(_is_dir, accessor),
            ) from exc
        raise
    if len(entries) > SCOPE_ERROR:
        logger.warning(
            "databricks_volume readdir: %s returned %d entries (limit %d)",
            list_path.virtual,
            len(entries),
            SCOPE_ERROR,
        )
    rows: list[FileStat] = []
    for entry in sorted(entries, key=lambda item: item.path):
        name = entry.path.rstrip("/").rsplit("/", 1)[-1]
        if entry.is_directory:
            rows.append(FileStat(name=name, type=FileType.DIRECTORY))
            continue
        size = entry.file_size
        if size is None:
            # DirectoryEntry normally carries file_size; when the lister
            # omits it, one HEAD per affected file fills the gap so no row
            # carries an unknown size.
            metadata = await get_metadata(accessor, entry.path)
            size = metadata.content_length
        rows.append(
            FileStat(
                name=name,
                size=size,
                modified=modified_to_iso(entry.last_modified),
                type=FileType.FILE,
                content=content_type_for_path(name),
            )
        )
    return rows

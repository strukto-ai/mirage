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
from collections.abc import Callable
from typing import Protocol

from mirage.accessor.base import Accessor
from mirage.cache.context import invalidate_after_unlink
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.google._client import TokenManager
from mirage.core.google.drive import delete_file
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_key, mount_prefix_of

logger = logging.getLogger(__name__)

# The Drive-item backends (gdocs, gsheets, gslides) present the same
# synthetic owned/shared tree over the index; stat and unlink differ only
# in the readdir they warm the cache with.
VIRTUAL_DIRS = {"", "owned", "shared"}


class DriveItemAccessor(Protocol):
    token_manager: TokenManager


def make_stat(readdir: Callable) -> Callable:
    """Build a Drive-item stat over a backend's readdir.

    Args:
        readdir (Callable): backend readdir ``(accessor, path, index)``
            that populates the index for a parent directory.
    """

    async def stat(
        accessor: Accessor,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX,
    ) -> FileStat:
        virtual = path.virtual
        prefix = mount_prefix_of(path.virtual, path.resource_path)
        key = path.resource_path
        if key in VIRTUAL_DIRS:
            name = key if key else "/"
            return FileStat(name=name, type=FileType.DIRECTORY)
        virtual_key = prefix + "/" + key if prefix else "/" + key
        result = await index.get(virtual_key)
        if result.entry is None:
            parent_virtual = virtual_key.rsplit("/", 1)[0] or "/"
            try:
                await readdir(
                    accessor,
                    PathSpec(virtual=parent_virtual,
                             directory=parent_virtual,
                             resource_path=mount_key(parent_virtual, prefix)),
                    index=index,
                )
            except FileNotFoundError as exc:
                logger.debug("stat readdir populate failed for %s: %s",
                             parent_virtual, exc)
            result = await index.get(virtual_key)
            if result.entry is None:
                raise enoent(virtual)
        return FileStat(
            name=result.entry.vfs_name,
            type=FileType.JSON,
            modified=result.entry.remote_time,
            size=result.entry.size,
            extra={
                "doc_id": result.entry.id,
                "doc_name": result.entry.name,
                **result.entry.extra,
            },
        )

    return stat


def make_unlink(readdir: Callable) -> Callable:
    """Build a Drive-item unlink over a backend's readdir.

    Args:
        readdir (Callable): backend readdir ``(accessor, path, index)``
            that populates the index for a parent directory.
    """

    async def unlink(
        accessor: DriveItemAccessor,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX,
    ) -> None:
        prefix = mount_prefix_of(path.virtual, path.resource_path)
        raw = path.virtual
        stripped = raw[len(prefix
                           ):] if prefix and raw.startswith(prefix) else raw
        key = stripped.strip("/")
        if key in VIRTUAL_DIRS:
            raise IsADirectoryError(raw)
        virtual_key = prefix + "/" + key if prefix else "/" + key
        result = await index.get(virtual_key)
        if result.entry is None:
            parent = "/" + "/".join(key.split("/")[:-1])
            parent_path = PathSpec.from_str_path(
                prefix + parent, mount_key(prefix + parent, prefix))
            await readdir(accessor, parent_path, index)
            result = await index.get(virtual_key)
        if result.entry is None:
            raise enoent(path)
        await delete_file(accessor.token_manager, result.entry.id)
        parent_dir = "/".join(virtual_key.rsplit("/", 1)[:-1]) or "/"
        await index.invalidate_dir(parent_dir)
        await invalidate_after_unlink(path)

    return unlink

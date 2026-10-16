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

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.core.msgraph.drive import (
    batch_tree,
    directory_path,
    readdir_items,
    virtual_key,
)
from mirage.core.sharepoint.resolve import (
    drive_loc,
    list_drives,
    list_sites,
    resolve,
)
from mirage.types import FileStat, FileType, PathSpec


def _folders(names: list[str]) -> list[FileStat]:
    """A namespace level (the sites, or one site's libraries) as rows.

    Args:
        names (list[str]): the level's entries.
    """
    return [
        FileStat(name=name, type=FileType.DIRECTORY) for name in sorted(names)
    ]


async def readdir(
    accessor: SharePointAccessor, path: PathSpec
) -> list[FileStat]:
    target = directory_path(path)
    resolved = await resolve(accessor, target)
    if resolved.level == "root":
        return _folders(await list_sites(accessor))
    if resolved.level == "site" and resolved.site_id is not None:
        return _folders(await list_drives(accessor, resolved.site_id))
    if resolved.drive_id is None:
        return []
    return await readdir_items(
        accessor.config,
        drive_loc(accessor.config, resolved, target.vfs_path),
        virtual_key(path),
        session=accessor.pool,
    )


async def tree(
    accessor: SharePointAccessor, path: PathSpec
) -> dict[str, FileStat] | None:
    """Every item under a folder of a document library, each as its
    folder's listing renders it, from the folders' listings batched
    (``batch_tree``).

    None above the libraries and for a library that is not there: the
    sites and a site's libraries are walked, and the walk reads each
    library's tree on its own.

    Args:
        accessor (SharePointAccessor): backend accessor.
        path (PathSpec): the directory.
    """
    resolved = await resolve(accessor, path)
    if resolved.level in ("root", "site") or resolved.drive_id is None:
        return None
    return await batch_tree(
        accessor.config,
        drive_loc(accessor.config, resolved, path.vfs_path),
        virtual_key(path),
        session=accessor.pool,
    )

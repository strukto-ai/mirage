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

from mirage.accessor.onedrive import OneDriveAccessor
from mirage.core.onedrive._client import new_session, split_path
from mirage.core.onedrive.find import iter_tree
from mirage.core.onedrive.stat import stat
from mirage.types import FileType, PathSpec


async def du(accessor: OneDriveAccessor, path: PathSpec) -> int:
    """Total size in bytes under a path.

    A file has no ``/children`` endpoint (Graph 404s on it), so resolve
    the file case from its own stat and only walk the tree for a
    directory, mirroring how s3 sums the exact key plus its children.

    Args:
        accessor (OneDriveAccessor): OneDrive accessor.
        path (PathSpec): target path.
    """
    try:
        info = await stat(accessor, path)
    except FileNotFoundError:
        info = None
    if info is not None and info.type != FileType.DIRECTORY:
        return info.size or 0
    _, base = split_path(path)
    total = 0
    async with new_session(accessor.config) as session:
        async for _rel, item, is_dir in iter_tree(accessor.config,
                                                  base,
                                                  session=session):
            if not is_dir:
                total += item.get("size", 0)
    return total


async def du_all(accessor: OneDriveAccessor,
                 path: PathSpec) -> list[tuple[str, int]]:
    """List of (path, size) tuples plus a total entry.

    For a file there is no tree to walk; return an empty list so the
    generic du falls back to ``du`` for the single-file total.

    Args:
        accessor (OneDriveAccessor): OneDrive accessor.
        path (PathSpec): target path.
    """
    try:
        info = await stat(accessor, path)
    except FileNotFoundError:
        info = None
    if info is not None and info.type != FileType.DIRECTORY:
        return []
    _, base = split_path(path)
    results: list[tuple[str, int]] = []
    total = 0
    async with new_session(accessor.config) as session:
        async for rel, item, is_dir in iter_tree(accessor.config,
                                                 base,
                                                 session=session):
            if is_dir:
                continue
            size = item.get("size", 0)
            results.append(("/" + rel, size))
            total += size
    results.append(("/" + base if base else "/", total))
    return results

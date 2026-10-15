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

from mirage.accessor.github import GitHubAccessor
from mirage.core.github.repo import ensure_ref
from mirage.core.github.tree import (
    fetch_dir_tree,
    refresh_tree,
    row_of,
    tree_listing,
)
from mirage.errors.fs import enoent, enotdir
from mirage.types import DirListing, FileStat, FileType, PathSpec


async def readdir(
    accessor: GitHubAccessor,
    path: PathSpec,
    entry: FileStat | None = None,
) -> DirListing:
    """A folder's listing, with every folder below it as seeds.

    One recursive tree answers the whole repository at the head it names,
    so the listing carries that head as its version. A tree GitHub
    truncated names only some paths; the folder is then read from its own
    tree, by the sha its row carries, and once a mount has seen its tree
    truncated it asks no recursive tree again.

    Args:
        accessor (GitHubAccessor): backend handle.
        path (PathSpec): the folder, or a glob word in it.
        entry (FileStat | None): the folder's row, as its parent lists it.

    Raises:
        NotADirectoryError: a file is at the path.
        FileNotFoundError: nothing is.
    """
    rel = (path.dir if path.pattern else path).mount_path.strip("/")
    if not (accessor.tree_loaded and accessor.truncated):
        fetched = await refresh_tree(accessor)
        if fetched is not None:
            tree, version = fetched
            return tree_listing(tree, rel, version, path.virtual)
    if not rel:
        sha = await ensure_ref(accessor)
    elif entry is None:
        raise enoent(path.virtual)
    elif entry.type is not FileType.DIRECTORY:
        raise enotdir(path.virtual)
    else:
        sha = str(entry.extra["sha"])
    rows = await fetch_dir_tree(
        accessor.config, accessor.owner, accessor.repo, sha, accessor.pool
    )
    return DirListing(entries=[row_of(row, row.path) for row in rows])

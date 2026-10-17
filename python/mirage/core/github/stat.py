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

import aiohttp

from mirage.accessor.github import GitHubAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.cache.index.ram import ListingCheckStore
from mirage.core.github.repo import ensure_ref
from mirage.core.github.tree import (
    fetch_dir_tree,
    fetch_head,
    point_row,
    refresh_tree,
    row_of,
)
from mirage.errors.fs import enoent
from mirage.types import FileStat, FileType, PathSpec

log = logging.getLogger(__name__)


async def stat(
    accessor: GitHubAccessor,
    path: PathSpec,
    entry: FileStat | None = None,
    index: IndexCacheStore = NULL_INDEX,
) -> FileStat:
    """Stat one path in the repository.

    A path answers with its row, as its folder's listing names it. The
    gate's check is handed no listed row, so it asks for the one path with
    one directory listing, its parent's; a parent it cannot see, and a
    truncated listing without the name, are no answer, so the whole tree is
    asked instead, and one GitHub truncates is walked down from the ref one
    directory at a time.

    Args:
        accessor (GitHubAccessor): backend handle.
        path (PathSpec): the path to stat.
        entry (FileStat | None): the path's row.
        index (IndexCacheStore): the store the stat runs under.

    Returns:
        FileStat: the rendered stat.

    Raises:
        FileNotFoundError: nothing exists at the path.
    """
    rel = path.mount_path.strip("/")
    if not rel:
        return FileStat(
            name="/",
            type=FileType.DIRECTORY,
            fingerprint=await _root_version(accessor, index),
        )
    if entry is not None:
        return entry
    if not isinstance(index, ListingCheckStore):
        raise enoent(path.virtual)
    answer = await point_row(accessor, rel)
    if answer is not None:
        row, truncated = answer
        if row is not None:
            return row_of(row, row.path)
        if not truncated:
            raise enoent(path.virtual)
    if not (accessor.tree_loaded and accessor.truncated):
        whole = await refresh_tree(accessor)
        if whole is not None:
            tree, _ = whole
            if rel not in tree:
                raise enoent(path.virtual)
            return row_of(tree[rel], rel.rsplit("/", 1)[-1])
    found = await _walked(accessor, rel)
    if found is None:
        raise enoent(path.virtual)
    return found


async def _walked(accessor: GitHubAccessor, rel: str) -> FileStat | None:
    """The row at ``rel``, walked down from the ref one directory at a
    time; None when a level does not name it.

    Args:
        accessor (GitHubAccessor): backend handle.
        rel (str): the path, repo-relative.
    """
    sha = await ensure_ref(accessor)
    names = rel.split("/")
    for depth, name in enumerate(names):
        rows = await fetch_dir_tree(
            accessor.account, accessor.owner, accessor.repo, sha
        )
        found = next((row for row in rows if row.path == name), None)
        if found is None:
            return None
        if depth == len(names) - 1:
            return row_of(found, name)
        if found.type != "tree":
            return None
        sha = found.sha
    return None


async def tree(
    accessor: GitHubAccessor, path: PathSpec
) -> dict[str, FileStat] | None:
    """Every entry under a directory of the repository, each as its row,
    from one recursive tree. None when GitHub truncates that tree, which
    then names only some paths, or when ``path`` is no directory in it,
    so the walk's readdir and stat report what is there.

    Args:
        accessor (GitHubAccessor): backend handle.
        path (PathSpec): the directory.
    """
    if accessor.tree_loaded and accessor.truncated:
        return None
    fetched = await refresh_tree(accessor)
    if fetched is None:
        return None
    whole, _ = fetched
    base = path.mount_path.strip("/")
    if base and getattr(whole.get(base), "type", None) != "tree":
        return None
    lead = base + "/" if base else ""
    return {
        key[len(lead) :]: row_of(entry, key.rsplit("/", 1)[-1])
        for key, entry in whole.items()
        if key.startswith(lead) and key != base
    }


async def _root_version(
    accessor: GitHubAccessor,
    index: IndexCacheStore,
) -> str | None:
    """The version of the whole mount: the head commit its ref is at.

    Only the gate's ``ListingCheckStore`` asks for it, with one shallow
    request. Every other index (the mount's own, the null index) names no
    version and reads nothing, neither the index nor the backend, so a
    getattr of the root never pays a check or a store round trip: nothing
    reads a root fingerprint off a mount-view stat. Nothing here refills
    the index: a refused head names no version rather than falling into a
    lookup.

    Args:
        accessor (GitHubAccessor): the mount's accessor.
        index (IndexCacheStore): the index the stat was asked through.

    Returns:
        str | None: the head commit sha, or None when it is not asked for
        or not known.
    """
    if not isinstance(index, ListingCheckStore):
        return None
    try:
        return await fetch_head(
            accessor.account,
            accessor.owner,
            accessor.repo,
            await ensure_ref(accessor),
        )
    except aiohttp.ClientResponseError as exc:
        log.debug(
            "head of %s/%s not answered: %s",
            accessor.owner,
            accessor.repo,
            exc,
        )
        return None

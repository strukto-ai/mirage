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
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.cache.index.ram import ListingCheckStore
from mirage.core.github.lookup import locate, lookup_retrying, point_lookup
from mirage.core.github.repo import ensure_ref
from mirage.core.github.tree import fetch_head
from mirage.errors.fs import enoent
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.filetype import content_type_for_path

log = logging.getLogger(__name__)


def stat_of(entry: IndexEntry) -> FileStat:
    """Render one tree row as a FileStat, the same from either route.

    Args:
        entry (IndexEntry): the row for the path.

    Returns:
        FileStat: the rendered stat.
    """
    if entry.resource_type == "folder":
        return FileStat(name=entry.name, type=FileType.DIRECTORY)
    return FileStat(
        name=entry.name,
        size=entry.size,
        type=FileType.FILE,
        content=content_type_for_path(entry.name),
        fingerprint=entry.id,
        extra={"sha": entry.id},
    )


async def stat(
    accessor: GitHubAccessor,
    path_spec: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> FileStat:
    """Stat one path in the repository.

    Args:
        accessor (GitHubAccessor): backend handle.
        path_spec (PathSpec): the path to stat.
        index (IndexCacheStore): the mount's index.

    Returns:
        FileStat: the rendered stat.

    Raises:
        FileNotFoundError: nothing exists at the path.
    """
    prefix, rel, key = locate(path_spec)
    if not rel:
        return FileStat(
            name="/",
            type=FileType.DIRECTORY,
            fingerprint=await _root_version(accessor, index),
        )
    # A probe through a throwaway index asks for this one path; everything
    # else answers from the mount's listing, filling it if need be.
    found = await point_lookup(accessor, index, prefix, rel)
    if found is None:
        found = await lookup_retrying(accessor, index, prefix, key)
    if found.entry is None:
        raise enoent(path_spec.virtual)
    return stat_of(found.entry)


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
            accessor.config,
            accessor.owner,
            accessor.repo,
            await ensure_ref(accessor),
            accessor.pool,
        )
    except aiohttp.ClientResponseError as exc:
        log.debug(
            "head of %s/%s not answered: %s",
            accessor.owner,
            accessor.repo,
            exc,
        )
        return None

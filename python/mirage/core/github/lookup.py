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
from dataclasses import dataclass

from mirage.accessor.github import GitHubAccessor
from mirage.cache.index import (NULL_INDEX, IndexCacheStore, IndexEntry,
                                LookupStatus)
from mirage.cache.index.lock import index_lock
from mirage.core.github.readdir import _readdir
from mirage.core.github.tree import index_entry, point_row
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

log = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class Found:
    """What sits at one mount-absolute key.

    Args:
        entry (IndexEntry | None): the row, or None when nothing is there.
    """

    entry: IndexEntry | None = None


def root_of(prefix: str) -> str:
    """The key of the mount root, whose listing tells a live index from not.

    Args:
        prefix (str): the mount prefix ("/gh"), or "" for a root mount.

    Returns:
        str: the root key.
    """
    return prefix.rstrip("/") or "/"


async def lookup(
    accessor: GitHubAccessor,
    index: IndexCacheStore,
    prefix: str,
    key: str,
) -> Found:
    """Resolve one mount-absolute key through the mount's listing.

    The parent's current listing is what establishes membership: an entry
    row survives invalidation and a replacement listing, so a key it no
    longer names is absent even when its old row is still there. The
    parent is filled first if the index holds no listing for it.

    Without an index the parent is read the way ``_readdir`` reads it with
    none, which answers from the truncated walk alone; TypeScript's twin
    answers absent for an undefined index, which no door passes.

    Args:
        accessor (GitHubAccessor): the mount's accessor.
        index (IndexCacheStore): the mount's index, or NULL_INDEX.
        prefix (str): the mount prefix the keys are built against.
        key (str): the mount-absolute path to resolve.

    Returns:
        Found: the row, or an empty Found when the listing has no such key.
    """
    async with index_lock(index, root_of(prefix)):
        parent = key.rsplit("/", 1)[0] or "/"
        try:
            children = await _readdir(
                accessor,
                PathSpec(virtual=parent,
                         directory=parent,
                         vfs_path=mount_key(parent, prefix)),
                index=index,
            )
        except FileNotFoundError as exc:
            log.debug("lookup of %s found no parent listing: %s", key, exc)
            return Found()
        if key not in children:
            return Found()
        return Found(entry=(await index.get(key)).entry)


async def lookup_retrying(
    accessor: GitHubAccessor,
    index: IndexCacheStore,
    prefix: str,
    key: str,
) -> Found:
    """``lookup``, asked once more if the index was cleared under it.

    A ``read: fresh`` verdict clears the mount index without taking its
    lock, and one landing mid-lookup leaves a miss that only says the store
    is empty. Read as absence, that miss reaches ``on_op_missing`` through a
    dispatcher door and drops the path's overlay for good. Two signs tell
    it from a real one: the root listing is gone (a live index always has
    one), or the accessor wrote a listing while the lookup ran, which is a
    clear followed by a concurrent reseed.

    Args:
        accessor (GitHubAccessor): the mount's accessor.
        index (IndexCacheStore): the mount's index, or NULL_INDEX.
        prefix (str): the mount prefix the keys are built against.
        key (str): the mount-absolute path to resolve.

    Returns:
        Found: the row, or an empty Found for a real absence.
    """
    refills = accessor.refills
    found = await lookup(accessor, index, prefix, key)
    if found.entry is not None or index is NULL_INDEX:
        return found
    root = await index.list_dir(root_of(prefix))
    if (root.status is not LookupStatus.NOT_FOUND
            and accessor.refills == refills):
        return found
    return await lookup(accessor, index, prefix, key)


async def point_lookup(
    accessor: GitHubAccessor,
    index: IndexCacheStore,
    prefix: str,
    rel: str,
) -> Found | None:
    """Answer one path with one directory listing, where a walk would be waste.

    Taken only when the index holds no listing at all while the mount has
    listed before, which is what a nonzero ``accessor.refills`` records
    (every listing written into any index counts): the throwaway store
    reconcile and the drift check stat through, or a mount index a verdict
    just cleared. A mount that never
    listed seeds through its tree as it always has, and a live or expired
    index keeps its own answer. The root is read before the accessor, so a
    live index answers without the accessor being consulted.

    Nothing is written back: one directory is not the mount's listing, and
    seeding it would make every other path read as absent. A parent it
    cannot see, and a truncated listing without the name, are no answer, so
    the whole tree is asked instead.

    Args:
        accessor (GitHubAccessor): the mount's accessor.
        index (IndexCacheStore): the index the caller passed.
        prefix (str): the mount prefix the keys are built against.
        rel (str): the path as the mount sees it.

    Returns:
        Found | None: the answer, or None when the index should answer.
    """
    if index is NULL_INDEX:
        return None
    root = await index.list_dir(root_of(prefix))
    if root.status is not LookupStatus.NOT_FOUND or accessor.refills == 0:
        return None
    answer = await point_row(accessor, rel)
    if answer is None:
        return None
    row, truncated = answer
    if row is None:
        return None if truncated else Found()
    return Found(entry=index_entry(row, row.path))

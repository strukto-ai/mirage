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
from mirage.cache.index import (
    NULL_INDEX,
    IndexCacheStore,
    IndexEntry,
    LookupStatus,
)
from mirage.cache.index.lock import index_lock
from mirage.core.github.readdir import _readdir
from mirage.core.github.tree import index_entry, point_row, refill_snapshot
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key, mount_prefix_of

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


def locate(path_spec: PathSpec) -> tuple[str, str, str]:
    """Where one path sits, the same for a stat and a read.

    Args:
        path_spec (PathSpec): the path asked about.

    Returns:
        tuple[str, str, str]: the mount prefix ("" for a root mount), the
        path as the mount sees it with no slash at either end ("" for the
        mount root), and the mount-absolute key the index files it under.
    """
    prefix = mount_prefix_of(path_spec.virtual, path_spec.vfs_path)
    rel = path_spec.mount_path.strip("/")
    return prefix, rel, (prefix + "/" + rel if prefix else "/" + rel)


async def lookup(
    accessor: GitHubAccessor,
    index: IndexCacheStore,
    prefix: str,
    key: str,
    recover_evicted: bool = True,
) -> Found:
    """Resolve one mount-absolute key through the mount's listing.

    The parent's current listing is what establishes membership: an entry
    row survives invalidation and a replacement listing, so a key it no
    longer names is absent even when its old row is still there. The
    parent is filled first if the index holds no listing for it.

    Without an index the parent is read the way ``_readdir`` reads it with
    none, which answers from the truncated walk alone; TypeScript's twin
    answers absent for an undefined index, which no caller passes.

    Args:
        accessor (GitHubAccessor): the mount's accessor.
        index (IndexCacheStore): the mount's index, or NULL_INDEX.
        prefix (str): the mount prefix the keys are built against.
        key (str): the mount-absolute path to resolve.
        recover_evicted (bool): whether a listed name with no row refills
            once; the retry passes False, so a row the refill did not bring
            back costs one refill per call, not two.

    Returns:
        Found: the row, or an empty Found when the listing has no such key.
    """
    async with index_lock(index, root_of(prefix)):
        if not await _listed(accessor, index, prefix, key):
            return Found()
        entry = (await index.get(key)).entry
        if entry is not None or index is NULL_INDEX:
            return Found(entry=entry)
        # A clear can race the read and another op reseed the index after
        # it; read the row once more before taking the miss as an eviction.
        entry = (await index.get(key)).entry
        if entry is not None or not recover_evicted:
            return Found(entry=entry)
        # Eviction can drop a row its listing still names. The store serves
        # the listing regardless, so the miss is checked here, on demand:
        # refill once, as for an expired listing, and resolve the key again.
        log.debug("lookup of %s found a listed name with no row", key)
        if accessor.truncated:
            await index.invalidate_dir(key.rsplit("/", 1)[0] or "/")
        else:
            await refill_snapshot(accessor, index, prefix)
        if not await _listed(accessor, index, prefix, key):
            return Found()
        return Found(entry=(await index.get(key)).entry)


async def _listed(
    accessor: GitHubAccessor,
    index: IndexCacheStore,
    prefix: str,
    key: str,
) -> bool:
    """Whether the parent's current listing names ``key``.

    Args:
        accessor (GitHubAccessor): the mount's accessor.
        index (IndexCacheStore): the mount's index, held under its lock.
        prefix (str): the mount prefix the keys are built against.
        key (str): the mount-absolute path to resolve.
    """
    parent = key.rsplit("/", 1)[0] or "/"
    try:
        children = await _readdir(
            accessor,
            PathSpec(
                virtual=parent,
                directory=parent,
                vfs_path=mount_key(parent, prefix),
            ),
            index=index,
        )
    except FileNotFoundError as exc:
        log.debug("lookup of %s found no parent listing: %s", key, exc)
        return False
    return key in children


async def lookup_retrying(
    accessor: GitHubAccessor,
    index: IndexCacheStore,
    prefix: str,
    key: str,
) -> Found:
    """``lookup``, asked once more when it finds nothing.

    A ``read: fresh`` verdict clears the mount index without taking its
    lock, and one landing mid-lookup leaves a miss that only says the store
    was emptied. Read as absence, that miss reaches ``on_enoent``
    through a dispatcher and drops the path's overlay for good. The
    second lookup refills a cleared index, or reads the one another op
    reseeded meanwhile, so a miss is absent only when both agree. A genuine
    miss costs one more index read and no request, since the first lookup
    left the listing that answers the second; only a missing directory in
    a truncated tree is walked twice. The second lookup does not refill
    for a listed name with no row: the first already did, so a row the
    refill did not bring back is absent after one refill, not two. Two
    clears inside one call can still produce a false miss, as in hf.

    Args:
        accessor (GitHubAccessor): the mount's accessor.
        index (IndexCacheStore): the mount's index, or NULL_INDEX.
        prefix (str): the mount prefix the keys are built against.
        key (str): the mount-absolute path to resolve.

    Returns:
        Found: the row, or an empty Found for a real absence.
    """
    found = await lookup(accessor, index, prefix, key)
    if found.entry is not None or index is NULL_INDEX:
        return found
    return await lookup(accessor, index, prefix, key, recover_evicted=False)


async def point_lookup(
    accessor: GitHubAccessor,
    index: IndexCacheStore,
    prefix: str,
    rel: str,
) -> Found | None:
    """Answer one path with one directory listing, where a walk would be waste.

    Taken whenever the index holds no listing at all: the throwaway store
    reconcile and the drift check stat through, a mount index a verdict
    just cleared, or one nothing has listed into yet. A live or expired
    index keeps its own answer, and its root is read first, so a live index
    answers without a request.

    Nothing is written back: one directory is not the mount's listing, and
    seeding it would make every other path read as absent. The next readdir
    or read fills the index from the whole tree. A parent it cannot see,
    and a truncated listing without the name, are no answer, so the whole
    tree is asked instead.

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
    if root.status is not LookupStatus.NOT_FOUND:
        return None
    answer = await point_row(accessor, rel)
    if answer is None:
        return None
    row, truncated = answer
    if row is None:
        return None if truncated else Found()
    return Found(entry=index_entry(row, row.path))

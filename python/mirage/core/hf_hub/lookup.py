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
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass

from mirage.accessor.hf_hub import HfHubAccessor
from mirage.cache.index import (
    NULL_INDEX,
    IndexCacheStore,
    IndexEntry,
    ListResult,
    LookupResult,
    LookupStatus,
)
from mirage.cache.index.lock import index_lock
from mirage.core.hf_hub.client import HfHubError
from mirage.core.hf_hub.constants import ABSENT_STATUSES
from mirage.core.hf_hub.tree import (
    ensure_live_snapshot,
    fetch_path,
    index_rows,
    local_rows,
    refill_snapshot,
)
from mirage.errors.fs import eacces
from mirage.types import PathSpec

log = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class Found:
    """What sits at one mount-absolute key.

    ``entry`` is None for a directory the tree implies but has no row of
    its own for, which is why a caller must read ``is_dir`` and
    ``exists`` rather than testing ``entry`` for truth.

    Args:
        entry (IndexEntry | None): the tree row, when there is one.
        children (list[str] | None): the directory's listing, when the
            key names a directory.
    """

    entry: IndexEntry | None = None
    children: list[str] | None = None

    @property
    def exists(self) -> bool:
        return self.entry is not None or self.children is not None

    @property
    def is_dir(self) -> bool:
        if self.children is not None:
            return True
        return self.entry is not None and self.entry.resource_type == "folder"


async def lookup(
    accessor: HfHubAccessor,
    index: IndexCacheStore,
    prefix: str,
    key: str,
    recover_evicted: bool = True,
) -> Found:
    """Resolve one mount-absolute key against the mount's listing.

    The single place the two storage paths are told apart: a workspace
    mount answers from its seeded index, and a mount built without one
    (a unit test, a command constructed outside a workspace) answers from
    tables derived from the accessor's tree. Both are built by
    ``index_rows``, so they cannot disagree.

    Args:
        accessor (HfHubAccessor): the mount's accessor.
        index (IndexCacheStore): the mount's index, or NULL_INDEX.
        prefix (str): the mount prefix the keys are built against.
        key (str): the mount-absolute path to resolve.
        recover_evicted (bool): whether a listed name with no row refills
            once; the retry passes False, so a row the refill did not bring
            back costs one refill per call, not two.

    Returns:
        Found: the row and/or listing at that key.
    """
    if index is NULL_INDEX:
        entries, children = await local_rows(accessor, prefix)
        return Found(entry=entries.get(key), children=children.get(key))
    root = prefix.rstrip("/") or "/"
    parent_key = key.rstrip("/").rsplit("/", 1)[0] or "/"
    async with index_lock(index, root):
        refilled = await ensure_live_snapshot(accessor, index, prefix)
        result = await index.get(key)
        listing = await index.list_dir(key)
        parent = listing if key == root else await index.list_dir(parent_key)
        # The index is the whole listing rather than a cache in front of one,
        # so an *expired* answer means the tree aged out, not that the path
        # is gone. Refetch once and ask again; a miss against a live index is
        # a real absence and must not cost a tree fetch. A name the parent
        # lists with no row of its own was evicted, which the store does not
        # check, so it is refilled the same way.
        if refilled is None and (
            LookupStatus.EXPIRED in (parent.status, listing.status)
            or (recover_evicted and _row_evicted(key, result, listing, parent))
        ):
            refilled = await refill_snapshot(accessor, index, prefix)
            result = await index.get(key)
            listing = await index.list_dir(key)
            parent = (
                listing if key == root else await index.list_dir(parent_key)
            )
        # A lock wait can outlast the TTL; use this refill only on EXPIRED.
        if refilled is not None and LookupStatus.EXPIRED in (
            parent.status,
            listing.status,
        ):
            refilled = index.scope_snapshot(refilled)
            rows = refilled.children.get(key)
            return Found(
                entry=refilled.entries.get(key),
                children=None if rows is None else list(rows),
            )
        return Found(entry=result.entry, children=listing.entries)


def _row_evicted(
    key: str, result: LookupResult, listing: ListResult, parent: ListResult
) -> bool:
    """Whether the parent lists ``key`` while neither its row nor its listing
    is stored.

    Args:
        key (str): the mount-absolute path being resolved.
        result (LookupResult): the key's own row lookup.
        listing (ListResult): the key's own listing, for a directory.
        parent (ListResult): the parent's listing.
    """
    return (
        result.entry is None
        and listing.entries is None
        and parent is not listing
        and parent.entries is not None
        and key in parent.entries
    )


async def lookup_retrying(
    accessor: HfHubAccessor,
    index: IndexCacheStore,
    prefix: str,
    key: str,
) -> Found:
    """``lookup``, asked once more if the index was cleared under it.

    A reconcile verdict clears the mount index, and one landing between
    the refill and the read leaves a miss that only says the store is
    empty. Read as absence, that miss reaches ``on_op_missing`` through a
    dispatcher door and drops the path's overlay for good. Two signs tell
    that miss from a real one: the root listing is gone (a live index
    always has one), or the accessor refilled an index while the lookup
    ran, which is a clear followed by a concurrent reseed. The first
    lookup's own eviction refill counts as one, so the second lookup does
    not refill for a listed name with no row: a row that refill did not
    bring back is absent after one refill, not two.

    Args:
        accessor (HfHubAccessor): the mount's accessor.
        index (IndexCacheStore): the mount's index, or NULL_INDEX.
        prefix (str): the mount prefix the keys are built against.
        key (str): the mount-absolute path to resolve.

    Returns:
        Found: the row and/or listing at that key.
    """
    refills = accessor.refills
    found = await lookup(accessor, index, prefix, key)
    if found.exists or index is NULL_INDEX:
        return found
    root = await index.list_dir(key_of(prefix, ""))
    if (
        root.status is not LookupStatus.NOT_FOUND
        and accessor.refills == refills
    ):
        return found
    return await lookup(accessor, index, prefix, key, recover_evicted=False)


async def point_lookup(
    accessor: HfHubAccessor,
    index: IndexCacheStore,
    prefix: str,
    rel: str,
) -> Found | None:
    """Answer one path with one request, where a whole walk would be waste.

    Taken only when the index holds no tree at all while the mount has
    loaded one before: the throwaway store reconcile and the drift check
    stat through, or a mount index a verdict just cleared. A mount that
    never loaded its tree seeds it as it always has, and a live or expired
    index keeps its own answer. Nothing is written back: one row is not a
    listing, and seeding it would make every other path read as absent.

    The row's id is the git oid a tree row carries. Its mtime can differ
    from the tree's: paths-info expands commits only when the mount forces
    it, while the tree's own default expands a repository small enough.

    Args:
        accessor (HfHubAccessor): the mount's accessor.
        index (IndexCacheStore): the index the caller passed.
        prefix (str): the mount prefix the keys are built against.
        rel (str): the path as the mount sees it.

    Returns:
        Found | None: the answer, or None when the index should answer.
    """
    if index is NULL_INDEX or not accessor.tree_loaded:
        return None
    root = await index.list_dir(key_of(prefix, ""))
    if root.status is not LookupStatus.NOT_FOUND:
        return None
    entries, _ = index_rows(await fetch_path(accessor, rel), prefix)
    return Found(entry=entries.get(key_of(prefix, rel)))


@contextmanager
def refusals_denied(
    path_spec: PathSpec, statuses: frozenset[int] = ABSENT_STATUSES
) -> Iterator[None]:
    """Report a repository the Hub will not show as permission denied.

    A 401, 403 or 404 for the repository or revision is the Hub declining
    to show the listing, so the path answers the way a directory the caller
    may not open does: every file tool already reports that and steps past
    it, where a raw Hub error would stop a walk across other mounts. It is
    never absence, which reconcile would turn into a delete.

    Args:
        path_spec (PathSpec): the path the operation was asked about.
        statuses (frozenset[int]): the refusal statuses; a download narrows
            them to REFUSED_STATUSES.
    """
    try:
        yield
    except HfHubError as exc:
        if exc.status not in statuses:
            raise
        log.debug("hf %s refused: %s", path_spec.virtual, exc)
        raise eacces(path_spec) from exc


def key_of(prefix: str, local: str) -> str:
    """The mount-absolute key for a mount-local path.

    Args:
        prefix (str): the mount prefix ("/m"), or "" for a root mount.
        local (str): the path as the mount sees it.

    Returns:
        str: the key the index and the derived tables are keyed by.
    """
    rel = local.strip("/")
    stem = prefix.rstrip("/")
    if not rel:
        return stem or "/"
    return f"{stem}/{rel}" if stem else f"/{rel}"


async def probe_file(
    accessor: HfHubAccessor, index: IndexCacheStore, prefix: str, local: str
) -> bool:
    """Whether a mount-local path exists as a non-directory."""
    found = await lookup(accessor, index, prefix, key_of(prefix, local))
    return found.exists and not found.is_dir


async def probe_dir(
    accessor: HfHubAccessor, index: IndexCacheStore, prefix: str, local: str
) -> bool:
    """Whether a mount-local path exists as a directory."""
    found = await lookup(accessor, index, prefix, key_of(prefix, local))
    return found.is_dir


def dir_stat_entry(key: str) -> IndexEntry:
    """A row for a directory the tree implies but has no row for.

    Args:
        key (str): the mount-absolute path of the directory.

    Returns:
        IndexEntry: a folder row named after the key's last segment.
    """
    return IndexEntry(
        id="",
        name=key.rstrip("/").rsplit("/", 1)[-1] or "/",
        resource_type="folder",
    )

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
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

from mirage.accessor.github import GitHubAccessor
from mirage.cache.index import (NULL_INDEX, IndexCacheStore, IndexEntry,
                                LookupStatus)
from mirage.core.api.client import SessionArg
from mirage.core.github.client import github_get
from mirage.core.github.config import GitHubConfig
from mirage.core.github.repo import ensure_ref
from mirage.core.github.tree_entry import TreeEntry

log = logging.getLogger(__name__)


def _parse_tree_response(
    data: dict[str, Any],
    owner: str,
    repo: str,
    ref: str,
) -> tuple[dict[str, TreeEntry], bool]:
    truncated = bool(data.get("truncated"))
    if truncated:
        log.warning("GitHub tree response truncated for %s/%s@%s", owner, repo,
                    ref)
    result: dict[str, TreeEntry] = {}
    for item in data.get("tree", []):
        # Submodule gitlinks (type "commit") have no size and no blob to
        # read; exclude them from the tree entirely.
        if item["type"] == "commit":
            continue
        result[item["path"]] = TreeEntry(
            path=item["path"],
            type=item["type"],
            sha=item["sha"],
            size=item.get("size"),
        )
    return result, truncated


async def fetch_tree(
    config: GitHubConfig,
    owner: str,
    repo: str,
    ref: str,
    session: SessionArg = None,
) -> tuple[dict[str, TreeEntry], bool]:
    data = await github_get(
        config.token,
        "/repos/{owner}/{repo}/git/trees/{ref}",
        params={"recursive": "1"},
        base_url=config.base_url,
        session=session,
        owner=owner,
        repo=repo,
        ref=ref,
    )
    return _parse_tree_response(data, owner, repo, ref)


async def fetch_dir_tree(
    config: GitHubConfig,
    owner: str,
    repo: str,
    tree_sha: str,
    session: SessionArg = None,
) -> list[TreeEntry]:
    """Fetch a single directory's tree (non-recursive).

    Used as fallback when the recursive tree was truncated.
    """
    data = await github_get(
        config.token,
        "/repos/{owner}/{repo}/git/trees/{tree_sha}",
        base_url=config.base_url,
        session=session,
        owner=owner,
        repo=repo,
        tree_sha=tree_sha,
    )
    result: list[TreeEntry] = []
    for item in data.get("tree", []):
        if item["type"] == "commit":
            continue
        result.append(
            TreeEntry(
                path=item["path"],
                type=item["type"],
                sha=item["sha"],
                size=item.get("size"),
            ))
    return result


def index_rows(
        tree: dict[str, TreeEntry],
        prefix: str) -> tuple[dict[str, IndexEntry], dict[str, list[str]]]:
    """Turn a git tree into the index's entry and children tables.

    Keyed by mount-absolute path, the way every other backend keys its
    index, so the shared cache machinery can spell an eviction without
    knowing which backend it is talking to. The tree itself stays
    repo-relative; ``prefix`` is what lifts it.

    Shared so the mount's seed and a later refill build the same rows;
    TypeScript keeps its twin in this module too (`populateIndex`).

    Args:
        tree (dict[str, TreeEntry]): the recursive tree, keyed by
            repo-relative path.
        prefix (str): the mount prefix ("/gh"), or "" for a root mount.

    Returns:
        tuple[dict[str, IndexEntry], dict[str, list[str]]]: entries keyed
        by mount-absolute path, and each directory's sorted children.
    """
    stem = prefix.rstrip("/")
    dirs: dict[str, list[tuple[str, IndexEntry]]] = defaultdict(list)
    # The repository root always exists, so it gets a row even when the
    # tree is empty. Without it an empty repository is byte for byte a
    # dropped index, and `ensure_live_index` would refetch on every read
    # of one; `ls` on it also read as ENOENT rather than as empty.
    dirs[stem or "/"] = []
    for path, entry in tree.items():
        parts = path.rsplit("/", 1)
        if len(parts) == 2:
            parent, name = stem + "/" + parts[0], parts[1]
        else:
            parent, name = stem or "/", parts[0]
        dirs[parent].append(
            (name,
             IndexEntry(
                 id=entry.sha,
                 name=name,
                 resource_type=("folder" if entry.type == "tree" else "file"),
                 size=entry.size,
             )))
    entries = {
        (parent.rstrip("/") + "/" + name): entry
        for parent, rows in dirs.items()
        for name, entry in rows
    }
    children = {
        parent: sorted(parent.rstrip("/") + "/" + name for name, _ in rows)
        for parent, rows in dirs.items()
    }
    return entries, children


def seed_index(
    accessor: GitHubAccessor,
    index: IndexCacheStore,
    prefix: str,
) -> None:
    """Write the accessor's tree into ``index`` under ``prefix``.

    Args:
        accessor (GitHubAccessor): the mount's accessor, holding the tree.
        index (IndexCacheStore): the index to seed.
        prefix (str): the mount prefix the keys are built against.
    """
    entries, children = index_rows(accessor.tree, prefix)
    index.seed(entries, children,
               datetime.now(timezone.utc) + timedelta(days=365))


async def refill_index(
    accessor: GitHubAccessor,
    index: IndexCacheStore,
    prefix: str,
) -> bool:
    """Refetch the recursive tree and re-seed the index from it.

    The mount fetches the whole tree once and seeds the index with it, so
    the index is the listing rather than a cache in front of one. That
    makes a cleared or expired index indistinguishable from an empty
    repository -- `ls` reported the mount root missing after an
    invalidation, and reported nothing at all once the day-long TTL
    lapsed. This is the refill that makes dropping the index mean
    "refetch", which is what invalidating it was always supposed to mean.

    Args:
        accessor (GitHubAccessor): the mount's accessor, holding the
            config and the ref to refetch.
        index (IndexCacheStore): the index to re-seed.
        prefix (str): the mount prefix the index keys are built against.

    Returns:
        bool: whether a refill happened; False when there is no index to
        seed, so a caller does not retry a lookup that cannot change.
    """
    if index is NULL_INDEX:
        return False
    ref = await ensure_ref(accessor)
    tree, truncated = await fetch_tree(accessor.config, accessor.owner,
                                       accessor.repo, ref, accessor.pool)
    accessor.truncated = truncated
    accessor.tree = tree
    accessor.tree_loaded = True
    seed_index(accessor, index, prefix)
    return True


async def ensure_live_index(
    accessor: GitHubAccessor,
    index: IndexCacheStore,
    prefix: str,
) -> bool:
    """Refetch when the index holds no listing at all.

    Every reader here treats a missing listing as a real absence, which
    is right against a *live* index and wrong against one that was never
    filled or has been dropped, and invalidation drops rather than
    expires: `invalidate_dir` removes the directory's row outright, so
    the EXPIRED probe each reader already runs never fires. An external
    change (a watch event is the only thing that invalidates a mount
    with no write ops) therefore left the whole mount answering ENOENT
    permanently, since the seeded expiry is a year out.

    The root listing is what tells live from not, in one lookup and no
    request: the tree is written whole, so while the index is live every
    directory has a row and the mount root always does. One refill makes
    it live again, so this cannot cost a fetch per miss, which is what
    kept the readers from probing on absence in the first place.

    Not live always **refetches**, and never re-seeds the tree the mount
    was built with. That tree is only true at build time: the first read
    of a mount can come long after it, and reusing it then served an
    index built from a repository five external writes ago. It is still
    what ``accessor.tree`` starts as, so find and du have something to
    read before any listing happens, and every refill reseats it.

    Args:
        accessor (GitHubAccessor): the mount's accessor.
        index (IndexCacheStore): the index to check and fill.
        prefix (str): the mount prefix the index keys are built against.

    Returns:
        bool: whether the index was filled.
    """
    if index is NULL_INDEX:
        return False
    # The liveness probe comes before anything on the accessor, so a live
    # index still answers every read without one.
    if (await index.list_dir(prefix.rstrip("/") or "/")).status \
            != LookupStatus.NOT_FOUND:
        return False
    # A truncated tree is not the whole listing, so the invariant this
    # rests on does not hold and readdir's per-directory fallback owns
    # the miss instead.
    if accessor.truncated:
        return False
    return await refill_index(accessor, index, prefix)


async def ensure_tree(
    accessor: GitHubAccessor,
    index: IndexCacheStore = NULL_INDEX,
    prefix: str = '',
) -> None:
    """Fetch the recursive tree if this mount has not got one yet.

    The mount is constructed without touching the network, so readers
    that consult ``accessor.tree`` directly rather than through the
    index -- find, du and grep's scope counter -- have to hydrate it
    first. Readers that go through the index do not call this:
    :func:`ensure_live_index` already refetches for them.

    Prefers that same refill when an index is wired, so a first `find`
    seeds the index for the `ls` after it instead of fetching a tree
    only this call can see. Falls back to a bare fetch when there is no
    index, which is the only case the old build-time fetch was really
    covering.

    Hydration is tracked by ``tree_loaded``, never by whether the tree
    holds anything: an empty repository hydrates to ``{}``, and reading
    that as "not hydrated" refetched it on every call, twice per call
    once an index was wired (the refill seeds an empty root, then the
    fallback runs because the tree still looks empty).

    Args:
        accessor (GitHubAccessor): the mount's accessor.
        index (IndexCacheStore): the mount's index, when it has one.
        prefix (str): the mount prefix the index keys are built against.
    """
    if accessor.tree_loaded:
        return
    async with accessor.tree_lock:
        if accessor.tree_loaded:
            return
        if index is not NULL_INDEX:
            await ensure_live_index(accessor, index, prefix)
            if accessor.tree_loaded:
                return
        ref = await ensure_ref(accessor)
        tree, truncated = await fetch_tree(accessor.config, accessor.owner,
                                           accessor.repo, ref, accessor.pool)
        accessor.truncated = truncated
        accessor.tree = tree
        accessor.tree_loaded = True

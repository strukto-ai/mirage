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
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

from mirage.accessor.hf_hub import HfHubAccessor
from mirage.cache.index import (NULL_INDEX, IndexCacheStore, IndexEntry,
                                LookupStatus)
from mirage.core.hf_hub.client import (HfHubError, api_url, hub_get_response,
                                       rev_segment)
from mirage.core.hf_hub.constants import (MAX_TREE_PAGES, TREE_PAGE_SIZE,
                                          TREE_PAGE_SIZE_EXPANDED)
from mirage.core.hf_hub.tree_entry import TreeEntry
from mirage.utils import key_prefix as kp

log = logging.getLogger(__name__)

# `Link: <url>; rel="next"`, which is how the tree endpoint hands back its
# cursor. Bounded repetition on the URL body so a pathological header
# cannot backtrack quadratically.
_NEXT_LINK = re.compile(r'<([^>]{1,4096})>\s*;\s*rel="next"')

# A repository the mount cannot see reads as an empty tree rather than as
# an error: 404 is a revision or subtree that does not exist, and the Hub
# answers 401 rather than 404 for a repo an anonymous caller may not know
# about, so both mean "nothing to list here" to a mount.
_ABSENT_STATUSES = frozenset({401, 403, 404})


def parse_entry(item: dict[str, Any]) -> TreeEntry:
    """Turn one tree row into a TreeEntry.

    Args:
        item (dict[str, Any]): a decoded tree row.

    Returns:
        TreeEntry: the row, with the LFS and Xet facts kept.
    """
    lfs = item.get("lfs")
    lfs = lfs if isinstance(lfs, dict) else {}
    commit = item.get("lastCommit")
    commit = commit if isinstance(commit, dict) else {}
    size = item.get("size")
    return TreeEntry(
        path=str(item.get("path", "")),
        type=str(item.get("type", "file")),
        oid=str(item.get("oid", "")),
        size=size if isinstance(size, int) else None,
        last_modified=str(commit.get("date", "")),
        last_commit=str(commit.get("id", "")),
        lfs_oid=str(lfs.get("oid", "")),
        xet_hash=str(item.get("xetHash", "")),
    )


def next_cursor(headers: Any) -> str:
    """The next page's URL, read out of the Link header.

    The Hub pages the tree with an opaque cursor rather than a page
    number, so the only way to ask for page two is to follow the URL it
    handed back.

    Args:
        headers (Any): the response's lower-cased header mapping.

    Returns:
        str: the next URL, or "" when this was the last page.
    """
    link = headers.get("link", "") if hasattr(headers, "get") else ""
    match = _NEXT_LINK.search(link) if link else None
    return match.group(1) if match else ""


def page_params(expand: bool) -> dict[str, Any]:
    """Query for one tree page.

    Args:
        expand (bool): whether to ask for each path's last commit.

    Returns:
        dict[str, Any]: the query parameters.
    """
    return {
        "recursive": "true",
        "expand": "true" if expand else "false",
        "limit": str(TREE_PAGE_SIZE_EXPANDED if expand else TREE_PAGE_SIZE),
    }


def tree_url(accessor: HfHubAccessor) -> str:
    """The tree endpoint for the mount's revision and key prefix.

    Args:
        accessor (HfHubAccessor): the mount's accessor.

    Returns:
        str: the absolute URL.
    """
    suffix = f"/tree/{rev_segment(accessor.revision)}"
    # The prefix is normalized with a trailing slash, which the tree
    # endpoint reads as a path segment of its own.
    stem = accessor.key_prefix.strip("/")
    if stem:
        suffix += "/" + stem
    return api_url(accessor.endpoint, accessor.repo_type, accessor.repo_id,
                   suffix)


def collect(rows: Any, prefix: str, into: dict[str, TreeEntry]) -> None:
    """Fold one page of tree rows into the mount's listing.

    Args:
        rows (Any): the decoded page, which is a list when the Hub
            answered a listing.
        prefix (str): the mount's key prefix, stripped from every path.
        into (dict[str, TreeEntry]): the listing being built.
    """
    stem = prefix.rstrip("/")
    for item in rows if isinstance(rows, list) else []:
        if not isinstance(item, dict):
            continue
        entry = parse_entry(item)
        if not entry.path:
            continue
        # A prefix mount lists its own subtree, and the row naming that
        # directory is not a child of anything. `kp.strip` cannot drop it
        # on its own: the prefix is normalized with a trailing slash, so
        # the bare directory path does not start with it and comes back
        # unchanged, which would key the prefix itself under the mount
        # root. The Hub does not send such a row today; this is what
        # keeps it harmless if it starts to.
        if stem and entry.path == stem:
            continue
        rel = kp.strip(prefix, entry.path) if prefix else entry.path
        if rel:
            into[rel] = entry


def truncated(repo_id: str) -> HfHubError:
    """The refusal for a listing the page ceiling cut short.

    Raised rather than returned because this listing is not a cache in
    front of the Hub, it is seeded as the mount's whole index: a partial
    one reads as a complete one, so every file past the ceiling becomes
    a confident false absence and `hf download` silently omits it. An
    error the caller can see is the lesser failure.

    Args:
        repo_id (str): the repository being walked.

    Returns:
        HfHubError: carrying the ceiling in its message.
    """
    return HfHubError(f"hf: {repo_id}: listing exceeds {MAX_TREE_PAGES} pages",
                      0)


async def walk_pages(
    accessor: HfHubAccessor,
    url: str,
    params: dict[str, Any] | None,
    into: dict[str, TreeEntry],
    limit: int = MAX_TREE_PAGES,
) -> str:
    """Follow the cursor from one page to the last, folding as it goes.

    Args:
        accessor (HfHubAccessor): the mount's accessor.
        url (str): the first page's URL.
        params (dict[str, Any] | None): the first page's query; every
            page after it carries its own inside the cursor URL.
        into (dict[str, TreeEntry]): the listing being built.
        limit (int): how many pages to follow.

    Returns:
        str: the cursor left unfollowed when the limit ran out, "" when
        the walk reached the end.

    Raises:
        HfHubError: the Hub refused for a reason that is not absence.
    """
    for _ in range(limit):
        try:
            response = await hub_get_response(accessor.token,
                                              url,
                                              params,
                                              session=accessor.pool)
        except HfHubError as exc:
            if exc.status in _ABSENT_STATUSES:
                log.debug("hf tree %s answered %s: %s", url, exc.status, exc)
                return ""
            raise
        collect(response.data, accessor.key_prefix, into)
        url = next_cursor(response.headers)
        if not url:
            return ""
        # The cursor URL carries the whole query already; sending the
        # first page's params alongside it duplicates them.
        params = None
    return url


async def fetch_tree(accessor: HfHubAccessor) -> dict[str, TreeEntry]:
    """Every path under the mount's subtree, in one paged walk.

    ``recursive=true`` returns the whole subtree. Size, oid and the LFS
    and Xet hashes all ride the bare row, so the only thing
    ``expand=true`` adds is the commit that last touched each path --
    a Hub file's only mtime -- and it costs a twentyfold drop in page
    size (1000 rows to 50, with any explicit limit above 100 refused).

    Which one is used is the mount's call, and its default is neither:
    ask for one expanded page, and if the whole repository fit in it,
    that page is the answer and the mtimes came free. Only a repository
    too big for one page falls back to the bare walk, and pays one
    wasted request for the attempt.

    Paging is by cursor, so unlike GitHub's recursive tree there is no
    truncation flag and no per-directory fallback: the walk either
    completes or raises.

    Args:
        accessor (HfHubAccessor): the mount's accessor.

    Returns:
        dict[str, TreeEntry]: entries keyed by path relative to the
        mount's key_prefix, with the prefix stripped.

    Raises:
        HfHubError: the Hub refused for a reason that is not absence.
    """
    url = tree_url(accessor)
    expand = accessor.expand_commits
    result: dict[str, TreeEntry] = {}
    if expand is not False:
        # One page, and no cursor followed: whether a second page exists
        # is exactly the question being asked.
        left = await walk_pages(accessor,
                                url,
                                page_params(True),
                                result,
                                limit=1)
        if not left:
            return result
        if expand:
            if await walk_pages(accessor, left, None, result):
                raise truncated(accessor.repo_id)
            return result
        # Too big to expand. The bare walk restarts from the first page
        # rather than continuing from this cursor, because the cursor
        # belongs to the expanded query and its rows carry a different
        # page size.
        result = {}
    if await walk_pages(accessor, url, page_params(False), result):
        raise truncated(accessor.repo_id)
    return result


def index_rows(
        tree: dict[str, TreeEntry],
        prefix: str) -> tuple[dict[str, IndexEntry], dict[str, list[str]]]:
    """Turn a Hub tree into the index's entry and children tables.

    Keyed by mount-absolute path, the way every other backend keys its
    index, so the shared cache machinery can spell an eviction without
    knowing which backend it is talking to. The tree itself stays
    mount-relative; ``prefix`` is what lifts it.

    Args:
        tree (dict[str, TreeEntry]): the recursive tree, keyed by
            mount-relative path.
        prefix (str): the mount prefix ("/m"), or "" for a root mount.

    Returns:
        tuple[dict[str, IndexEntry], dict[str, list[str]]]: entries keyed
        by mount-absolute path, and each directory's sorted children.
    """
    stem = prefix.rstrip("/")
    dirs: dict[str, list[tuple[str, IndexEntry]]] = defaultdict(list)
    # The repository root always exists, so it gets a row even when the
    # tree is empty. Without it an empty repo is byte for byte a dropped
    # index and every read would refetch.
    dirs[stem or "/"] = []
    for path, entry in tree.items():
        parts = path.rsplit("/", 1)
        if len(parts) == 2:
            parent, name = stem + "/" + parts[0], parts[1]
        else:
            parent, name = stem or "/", parts[0]
        extra: dict[str, Any] = {"oid": entry.oid}
        if entry.last_commit:
            extra["last_commit"] = entry.last_commit
        if entry.lfs_oid:
            extra["lfs_oid"] = entry.lfs_oid
        if entry.xet_hash:
            extra["xet_hash"] = entry.xet_hash
        dirs[parent].append(
            (name,
             IndexEntry(
                 id=entry.oid,
                 name=name,
                 resource_type=("folder" if entry.is_dir else "file"),
                 remote_time=entry.last_modified,
                 size=None if entry.is_dir else entry.size,
                 extra=extra,
             )))
        # A tree row names its parent directories implicitly. The Hub's
        # recursive listing does emit a row per directory, but a page
        # boundary can deliver a child before its parent, so the parent's
        # bucket is created here too and merged with its own row's.
        head = parts[0] if len(parts) == 2 else ""
        while head:
            dirs.setdefault(stem + "/" + head, [])
            head = head.rsplit("/", 1)[0] if "/" in head else ""
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
    accessor: HfHubAccessor,
    index: IndexCacheStore,
    prefix: str,
) -> None:
    """Write the accessor's tree into ``index`` under ``prefix``.

    Args:
        accessor (HfHubAccessor): the mount's accessor, holding the tree.
        index (IndexCacheStore): the index to seed.
        prefix (str): the mount prefix the keys are built against.
    """
    entries, children = index_rows(accessor.tree, prefix)
    index.seed(entries, children,
               datetime.now(timezone.utc) + timedelta(days=365))


async def refill_index(
    accessor: HfHubAccessor,
    index: IndexCacheStore,
    prefix: str,
) -> bool:
    """Refetch the tree and re-seed the index from it.

    The mount fetches the whole tree once and seeds the index with it, so
    the index *is* the listing rather than a cache in front of one. That
    makes a cleared or expired index indistinguishable from an empty
    repository, which is why dropping the index has to mean "refetch".

    Args:
        accessor (HfHubAccessor): the mount's accessor.
        index (IndexCacheStore): the index to re-seed.
        prefix (str): the mount prefix the index keys are built against.

    Returns:
        bool: whether a refill happened; False when there is no index to
        seed, so a caller does not retry a lookup that cannot change.
    """
    if index is NULL_INDEX:
        return False
    tree = await fetch_tree(accessor)
    accessor.tree = tree
    accessor.tree_loaded = True
    accessor.rows_cache = None
    seed_index(accessor, index, prefix)
    return True


async def ensure_live_index(
    accessor: HfHubAccessor,
    index: IndexCacheStore,
    prefix: str,
) -> bool:
    """Refetch when the index holds no listing at all.

    Every reader treats a missing listing as a real absence, which is
    right against a *live* index and wrong against one that was never
    filled or has been dropped. The root listing is what tells the two
    apart, in one lookup and no request: the tree is written whole, so
    while the index is live the mount root always has a row.

    Args:
        accessor (HfHubAccessor): the mount's accessor.
        index (IndexCacheStore): the index to check and fill.
        prefix (str): the mount prefix the index keys are built against.

    Returns:
        bool: whether the index was filled.
    """
    if index is NULL_INDEX:
        return False
    if (await index.list_dir(prefix.rstrip("/")
                             or "/")).status != LookupStatus.NOT_FOUND:
        return False
    return await refill_index(accessor, index, prefix)


async def ensure_tree(
    accessor: HfHubAccessor,
    index: IndexCacheStore = NULL_INDEX,
    prefix: str = '',
) -> None:
    """Fetch the tree if this mount has not got one yet.

    The mount is constructed without touching the network, so readers
    that consult ``accessor.tree`` directly rather than through the index
    -- find and du -- have to hydrate it first. Readers that go through
    the index do not call this; :func:`ensure_live_index` refetches for
    them.

    Hydration is tracked by ``tree_loaded``, never by whether the tree
    holds anything: an empty repository hydrates to ``{}``, and reading
    that as "not hydrated" refetches it on every call forever.

    Args:
        accessor (HfHubAccessor): the mount's accessor.
        index (IndexCacheStore): the mount's index, when it has one.
        prefix (str): the mount prefix the index keys are built against.
    """
    if accessor.tree_loaded:
        return
    async with accessor.tree_lock:
        if accessor.tree_loaded:
            return
        if index is not NULL_INDEX:
            await refill_index(accessor, index, prefix)
            return
        accessor.tree = await fetch_tree(accessor)
        accessor.tree_loaded = True
        accessor.rows_cache = None


async def local_rows(
    accessor: HfHubAccessor,
    prefix: str,
) -> tuple[dict[str, IndexEntry], dict[str, list[str]]]:
    """The index tables built straight from the accessor's tree.

    What a mount with no index wired reads instead. Every reader has an
    index inside a workspace, but a backend constructed on its own (a
    unit test, a command built outside a workspace) has NULL_INDEX, whose
    every lookup is a miss -- so without this, readdir answered ENOENT for
    a repository it could list perfectly well. Built by the same
    :func:`index_rows` the seeded path uses, so the two cannot disagree.

    Args:
        accessor (HfHubAccessor): the mount's accessor.
        prefix (str): the mount prefix the keys are built against.

    Returns:
        tuple[dict[str, IndexEntry], dict[str, list[str]]]: entries keyed
        by mount-absolute path, and each directory's sorted children.
    """
    await ensure_tree(accessor)
    cached = accessor.rows_cache
    if cached is not None and cached[0] == prefix:
        return cached[1], cached[2]
    entries, children = index_rows(accessor.tree, prefix)
    accessor.rows_cache = (prefix, entries, children)
    return entries, children

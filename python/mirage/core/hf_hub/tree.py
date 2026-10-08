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
from mirage.cache.index import (
    NULL_INDEX,
    IndexCacheStore,
    IndexEntry,
    LookupStatus,
)
from mirage.cache.index.config import IndexSnapshot
from mirage.cache.index.diff import departed
from mirage.cache.index.lock import index_lock
from mirage.core.hf_hub.client import (
    HfHubError,
    api_url,
    hub_get_response,
    hub_post,
    rev_segment,
)
from mirage.core.hf_hub.constants import (
    GITATTRIBUTES,
    MAX_TREE_PAGES,
    TREE_PAGE_SIZE,
    TREE_PAGE_SIZE_EXPANDED,
)
from mirage.core.hf_hub.repo import head_commit, mount_version
from mirage.core.hf_hub.tree_entry import TreeEntry
from mirage.utils import key_prefix as kp
from mirage.utils.fnmatch import fnmatchcase

log = logging.getLogger(__name__)

# `Link: <url>; rel="next"`, which is how the tree endpoint hands back its
# cursor. Bounded repetition on the URL body so a pathological header
# cannot backtrack quadratically.
_NEXT_LINK = re.compile(r'<([^>]{1,4096})>\s*;\s*rel="next"')

# The one refusal that means "nothing to list": the mount's key_prefix names
# no folder. Every other refusal (401 for a bad token or an unknown repo, 403
# for a gated one, 404 for a missing repo or revision) is an error, because
# this listing is seeded as the mount's whole index and an empty one would
# read every file as deleted.
_MISSING_SUBTREE = "EntryNotFound"


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


def tree_url(accessor: HfHubAccessor, revision: str | None = None) -> str:
    """The tree endpoint for a revision and the mount's key prefix.

    Args:
        accessor (HfHubAccessor): the mount's accessor.
        revision (str | None): the revision to walk at, the mount's own
            when None. A refill passes the commit its head resolved to, so
            the rows it stores are the ones that version names.

    Returns:
        str: the absolute URL.
    """
    suffix = f"/tree/{rev_segment(revision or accessor.revision)}"
    # The prefix is normalized with a trailing slash, which the tree
    # endpoint reads as a path segment of its own.
    stem = accessor.key_prefix.strip("/")
    if stem:
        suffix += "/" + stem
    return api_url(
        accessor.endpoint, accessor.repo_type, accessor.repo_id, suffix
    )


def paths_info_url(accessor: HfHubAccessor) -> str:
    """The paths-info endpoint for the mount's revision.

    Unlike the tree endpoint the key prefix does not ride the route: the
    segment after ``paths-info`` is the whole revision, so the prefix goes
    into each requested path instead.

    Args:
        accessor (HfHubAccessor): the mount's accessor.

    Returns:
        str: the absolute URL.
    """
    return api_url(
        accessor.endpoint,
        accessor.repo_type,
        accessor.repo_id,
        f"/paths-info/{rev_segment(accessor.revision)}",
    )


async def fetch_path(
    accessor: HfHubAccessor, rel: str
) -> dict[str, TreeEntry]:
    """The listing row for one mount-relative path, in one request.

    The row is folded by ``collect``, the same as a tree page, so it keys
    and carries the same oid a whole-tree walk would. Only a row naming
    exactly the asked path counts: an answer about some other path is not
    an answer about this one, and must not read as its absence.

    Args:
        accessor (HfHubAccessor): the mount's accessor.
        rel (str): the path as the mount sees it.

    Returns:
        dict[str, TreeEntry]: the row keyed by ``rel``, or empty when the
        path does not exist.

    Raises:
        HfHubError: the Hub refused, or answered rows for another path.
    """
    asked = accessor.repo_path(rel)
    rows = await hub_post(
        accessor.token,
        paths_info_url(accessor),
        {"paths": [asked], "expand": accessor.expand_commits is True},
        session=accessor.pool,
    )
    if not isinstance(rows, list):
        # Only an empty list says the path is missing; an answer of any
        # other shape is one the client cannot read, not an absence.
        raise HfHubError(
            f"paths-info answered no list for {asked}", 0, "InvalidResponse"
        )
    matching = [
        row
        for row in rows
        if isinstance(row, dict) and row.get("path") == asked
    ]
    if rows and not matching:
        raise HfHubError(
            f"paths-info answered no row for {asked}", 0, "PathMismatch"
        )
    into: dict[str, TreeEntry] = {}
    collect(matching, accessor.key_prefix, into)
    return into


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
    return HfHubError(
        f"hf: {repo_id}: listing exceeds {MAX_TREE_PAGES} pages", 0
    )


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
        HfHubError: the Hub refused for any reason but a missing subtree
            on the first page, including a repo the token cannot see.
    """
    for _ in range(limit):
        try:
            response = await hub_get_response(
                accessor.token, url, params, session=accessor.pool
            )
        except HfHubError as exc:
            # Only a request carrying first-page params can learn that the
            # subtree is missing; a cursor page failing means the listing
            # broke part way, and keeping what came before would pass a
            # partial tree off as the whole one.
            if (
                params is not None
                and exc.status == 404
                and exc.error_code == _MISSING_SUBTREE
            ):
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


async def fetch_tree(
    accessor: HfHubAccessor, revision: str | None = None
) -> dict[str, TreeEntry]:
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
        revision (str | None): the revision to walk at, the mount's own
            when None.

    Returns:
        dict[str, TreeEntry]: entries keyed by path relative to the
        mount's key_prefix, with the prefix stripped.

    Raises:
        HfHubError: the Hub refused for any reason but a missing subtree
            on the first page, or the listing ran past the page ceiling.
    """
    url = tree_url(accessor, revision)
    expand = accessor.expand_commits
    result: dict[str, TreeEntry] = {}
    if expand is not False:
        # One page, and no cursor followed: whether a second page exists
        # is exactly the question being asked.
        left = await walk_pages(
            accessor, url, page_params(True), result, limit=1
        )
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
    tree: dict[str, TreeEntry], prefix: str
) -> tuple[dict[str, IndexEntry], dict[str, list[str]]]:
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
            (
                name,
                IndexEntry(
                    id=entry.oid,
                    name=name,
                    resource_type=("folder" if entry.is_dir else "file"),
                    remote_time=entry.last_modified,
                    size=None if entry.is_dir else entry.size,
                    extra=extra,
                ),
            )
        )
        # A tree row names its parent directories implicitly. The Hub's
        # recursive listing does emit a row per directory, but a page
        # boundary can deliver a child before its parent, so the parent's
        # bucket is created here too and merged with its own row's.
        head = parts[0] if len(parts) == 2 else ""
        while head:
            dirs.setdefault(stem + "/" + head, [])
            head = head.rsplit("/", 1)[0] if "/" in head else ""
    _list_implied(dirs, stem or "/")
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


def _list_implied(
    dirs: dict[str, list[tuple[str, IndexEntry]]], root: str
) -> None:
    """Give every directory the tree only implies a row in its parent.

    A directory seen only as some path's parent has a listing of its own
    but no row naming it, so its parent would not list it and a stat of it
    would find no entry. Every listed path must have a row: a lookup that
    finds a listed name with none takes it as evicted and refills.

    Args:
        dirs (dict[str, list[tuple[str, IndexEntry]]]): each directory's
            rows, keyed by mount-absolute path; completed in place.
        root (str): the mount root's key, which no parent lists.
    """
    named = {
        parent.rstrip("/") + "/" + name
        for parent, rows in dirs.items()
        for name, _ in rows
    }
    for key in sorted(dirs):
        if key == root or key in named:
            continue
        parent, name = key.rsplit("/", 1)
        dirs[parent or "/"].append(
            (name, IndexEntry(id="", name=name, resource_type="folder"))
        )


def seed_index(
    tree: dict[str, TreeEntry],
    index: IndexCacheStore,
    prefix: str,
    version: str | None = None,
) -> IndexSnapshot:
    """Write one fetched tree into ``index`` under ``prefix``.

    The tree is the caller's own fetch, never ``accessor.tree`` re-read
    after an await: the watcher replaces that with no lock, and its rows
    may be at another head than the ``version`` stamped here.

    Args:
        tree (dict[str, TreeEntry]): the tree, walked at ``version``.
        index (IndexCacheStore): the index to seed.
        prefix (str): the mount prefix the keys are built against.
        version (str | None): the mount version of the head the tree was
            walked at (``mount_version``), stamped on every listing; None
            stores them unversioned.

    Returns:
        IndexSnapshot: the rows it wrote.
    """
    entries, children = index_rows(tree, prefix)
    index.seed(
        entries,
        children,
        datetime.now(timezone.utc) + timedelta(days=365),
        version=version,
    )
    return IndexSnapshot(entries=entries, children=children)


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
    return await refill_snapshot(accessor, index, prefix) is not None


async def refill_snapshot(
    accessor: HfHubAccessor,
    index: IndexCacheStore,
    prefix: str,
) -> IndexSnapshot | None:
    """``refill_index``, returning the rows it wrote.

    A reader answers from these when its re-read of the store has already
    expired (it waited on the mutation lock past the mount's ttl).

    Args:
        accessor (HfHubAccessor): the mount's accessor.
        index (IndexCacheStore): the index to re-seed.
        prefix (str): the mount prefix the index keys are built against.

    Returns:
        IndexSnapshot | None: the rows seeded; None when there is no index.
    """
    # The caller holds index_lock through replacement and its final lookup.
    if index is NULL_INDEX:
        return None
    previous = dict(accessor.tree) if accessor.tree_loaded else None
    # The head first, and the tree walked at the commit it names: the
    # version stored is then the one these rows are at, never a later one
    # a commit landing between the two requests would give. The head
    # failing is the refill failing. "" (a Hub that names none) walks the
    # branch and stores no version.
    head = await head_commit(accessor) or None
    tree = await fetch_tree(accessor, head)
    accessor.tree = tree
    accessor.tree_loaded = True
    accessor.rows_cache = None
    accessor.refills += 1
    # Refilling replaces the snapshot; merging would retain deleted paths.
    await index.invalidate_prefix(prefix.rstrip("/") or "/")
    snapshot = seed_index(
        tree, index, prefix, mount_version(head, accessor.key_prefix)
    )
    if previous is not None:
        await index.report_gone(
            departed(previous.items(), tree, prefix, _is_folder)
        )
    return snapshot


def _is_folder(entry: TreeEntry) -> bool:
    return entry.is_dir


async def ensure_live_snapshot(
    accessor: HfHubAccessor,
    index: IndexCacheStore,
    prefix: str,
) -> IndexSnapshot | None:
    """Refetch when the root listing is missing or expired.

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
        IndexSnapshot | None: the refill's rows, or None when none was
        needed or possible.
    """
    if index is NULL_INDEX:
        return None
    if (await index.list_dir(prefix.rstrip("/") or "/")).status not in (
        LookupStatus.NOT_FOUND,
        LookupStatus.EXPIRED,
    ):
        return None
    return await refill_snapshot(accessor, index, prefix)


async def ensure_tree(
    accessor: HfHubAccessor,
    index: IndexCacheStore = NULL_INDEX,
    prefix: str = "",
) -> None:
    """Fetch the tree if this mount has not got one yet.

    The mount is constructed without touching the network, so readers
    that consult ``accessor.tree`` directly rather than through the index
    -- find and du -- have to hydrate it first. Readers that go through
    the index do not call this; :func:`ensure_live_snapshot` refetches for
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
            async with index_lock(index, prefix.rstrip("/") or "/"):
                if not accessor.tree_loaded:
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


def repo_files(tree: dict[str, TreeEntry]) -> list[str]:
    """The file paths of a tree, sorted, its directories left out.

    Args:
        tree (dict[str, TreeEntry]): the repository listing.

    Returns:
        list[str]: repo-relative file paths.
    """
    return sorted(path for path, entry in tree.items() if not entry.is_dir)


def _folder_wildcard(pattern: str) -> str:
    return pattern + "*" if pattern.endswith("/") else pattern


def filter_repo_paths(
    paths: list[str],
    include: list[str],
    exclude: list[str] | None = None,
) -> list[str]:
    """Keep the repo paths an allowlist and a denylist of patterns admit.

    huggingface_hub's ``filter_repo_objects``, the one rule its
    ``--include``, ``--exclude`` and ``--delete`` share: a pattern is a
    CPython fnmatch glob over the whole path, so ``*`` crosses a ``/``
    (``data/*.json`` holds ``data/sub/x.json``), ``[^a]`` is ``^`` or
    ``a`` rather than bash's negation, and a pattern ending in ``/``
    names a folder and matches everything under it. An empty list puts
    no constraint on the paths.

    Args:
        paths (list[str]): repo-relative paths.
        include (list[str]): patterns a path must match one of.
        exclude (list[str] | None): patterns a path must match none of.

    Returns:
        list[str]: the admitted paths, in their given order.
    """
    allow = [_folder_wildcard(p) for p in include]
    deny = [_folder_wildcard(p) for p in exclude or []]
    return [
        path
        for path in paths
        if (not allow or any(fnmatchcase(path, p) for p in allow))
        and not any(fnmatchcase(path, p) for p in deny)
    ]


def deletions_for(
    files: list[str],
    patterns: list[str],
    path_in_repo: str = "",
) -> list[str]:
    """The repo files a set of deletion patterns names, as upstream does.

    huggingface_hub's ``_prepare_folder_deletions``: the patterns match
    the repository's listing, not paths of their own, so ``**`` or
    ``*.txt`` deletes the files it matches and a pattern matching nothing
    deletes nothing. They match relative to ``path_in_repo``, the folder
    an upload lands in, and ``.gitattributes`` always survives, because
    the Hub needs it to serve the repo.

    Args:
        files (list[str]): the repository's file paths.
        patterns (list[str]): the deletion globs; none deletes nothing.
        path_in_repo (str): the folder the patterns are relative to,
            normalized: no leading or trailing slash, "" for the root.

    Returns:
        list[str]: repo-relative paths to delete.
    """
    if not patterns:
        return []
    folder = f"{path_in_repo}/" if path_in_repo else ""
    relative = {
        file[len(folder) :]: file for file in files if file.startswith(folder)
    }
    return [
        relative[rel]
        for rel in filter_repo_paths(list(relative), patterns)
        if relative[rel] != GITATTRIBUTES
    ]

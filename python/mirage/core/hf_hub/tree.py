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

# Path filtering follows huggingface_hub 1.16.4 (Apache-2.0; see
# licenses/third_party/huggingface_hub.txt).

import logging
import re
from typing import Any

from mirage.accessor.hf_hub import HfHubAccessor
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
from mirage.core.hf_hub.tree_entry import TreeEntry
from mirage.errors.fs import enoent, enotdir
from mirage.types import DirListing, FileStat, FileType
from mirage.utils import key_prefix as kp
from mirage.utils.filetype import content_type_for_path
from mirage.utils.fnmatch import fnmatchcase

log = logging.getLogger(__name__)

# `Link: <url>; rel="next"`, which is how the tree endpoint hands back its
# cursor. Bounded repetition on the URL body so a pathological header
# cannot backtrack quadratically.
_NEXT_LINK = re.compile(r'<([^>]{1,4096})>\s*;\s*rel="next"')

# The one refusal that means "nothing to list": the mount's key_prefix names
# no folder. Every other refusal (401 for a bad token or an unknown repo, 403
# for a gated one, 404 for a missing repo or revision) is an error, because
# this listing is the mount's whole listing and an empty one would read
# every file as deleted.
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
        accessor.account,
        paths_info_url(accessor),
        {"paths": [asked], "expand": accessor.expand_commits is True},
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

    Raised rather than returned because this listing is the mount's whole
    listing: a partial one reads as a complete one, so every file past the
    ceiling becomes a confident false absence and `hf download` silently
    omits it. An error the caller can see is the lesser failure.

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
            response = await hub_get_response(accessor.account, url, params)
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


def row_of(entry: TreeEntry, name: str) -> FileStat:
    """The row for one tree row, the same from every route.

    Size is the row's, which is the Hub's *content* length even for an
    LFS file; the 135-byte pointer never reaches here. Reporting the
    pointer would make `wc -c` and `ls -l` lie and risk truncated copies
    over FUSE, which is the rule ``FileStat.size`` exists to keep.

    ``modified`` is None unless the mount asked for commit expansion:
    a Hub file's only mtime is the commit that last touched it, and
    stamping the repository's own lastModified onto every file would be
    a confident lie about files that commit never touched.

    Args:
        entry (TreeEntry): the tree row.
        name (str): the row's last path segment.
    """
    modified = entry.last_modified or None
    if entry.is_dir:
        return FileStat(name=name, type=FileType.DIRECTORY, modified=modified)
    extra: dict[str, Any] = {"oid": entry.oid}
    if entry.last_commit:
        extra["last_commit"] = entry.last_commit
    if entry.lfs_oid:
        extra["lfs_oid"] = entry.lfs_oid
    if entry.xet_hash:
        extra["xet_hash"] = entry.xet_hash
    return FileStat(
        name=name,
        size=entry.size,
        modified=modified,
        type=FileType.FILE,
        content=content_type_for_path(name),
        # git is content-addressed, so the object id is the strongest
        # fingerprint any backend here has: identical bytes carry an
        # identical oid, and a rewrite that changed nothing correctly
        # reports nothing.
        fingerprint=entry.oid or None,
        extra=extra,
    )


def tree_rows(tree: dict[str, TreeEntry]) -> dict[str, list[FileStat]]:
    """Each folder's rows, keyed by its mount-relative path ("" the root).

    The mount root always has a listing, even when the tree is empty, so
    an empty repository lists as empty rather than missing. A tree row
    names its parent folders implicitly, and a page boundary can deliver
    a child before its parent's own row, so every folder above a path
    gets a listing and a row in its parent; the folder's own row, when
    the tree has one, takes that place.

    Args:
        tree (dict[str, TreeEntry]): the recursive tree, keyed by
            mount-relative path.
    """
    folders: dict[str, dict[str, FileStat]] = {"": {}}
    for path, entry in tree.items():
        parent, _, name = path.rpartition("/")
        folders.setdefault(parent, {})[name] = row_of(entry, name)
        if entry.is_dir:
            folders.setdefault(path, {})
        while parent:
            above, _, folder = parent.rpartition("/")
            folders.setdefault(above, {}).setdefault(
                folder, FileStat(name=folder, type=FileType.DIRECTORY)
            )
            parent = above
    return {
        folder: sorted(rows.values(), key=lambda row: row.name)
        for folder, rows in folders.items()
    }


def tree_listing(
    tree: dict[str, TreeEntry], rel: str, version: str | None, virtual: str
) -> DirListing:
    """The listing of the folder ``rel`` out of the whole tree, with every
    folder below it as seeds, all at ``version``.

    Args:
        tree (dict[str, TreeEntry]): the recursive tree.
        rel (str): the folder, mount-relative ("" the root).
        version (str | None): the mount version the tree was walked at.
        virtual (str): the path asked, for the error.

    Raises:
        NotADirectoryError: a file is at ``rel`` or above it.
        FileNotFoundError: nothing is.
    """
    folders = tree_rows(tree)
    if rel not in folders:
        parts = rel.split("/")
        for depth in range(len(parts), 0, -1):
            found = tree.get("/".join(parts[:depth]))
            if found is not None and not found.is_dir:
                raise enotdir(virtual)
        raise enoent(virtual)
    lead = rel + "/" if rel else ""
    return DirListing(
        entries=folders[rel],
        seeds={
            folder[len(lead) :]: rows
            for folder, rows in folders.items()
            if folder != rel and folder.startswith(lead)
        },
        version=version,
    )


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

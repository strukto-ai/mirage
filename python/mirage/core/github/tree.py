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
from typing import Any
from urllib.parse import quote

import aiohttp

from mirage.accessor.github import GitHubAccessor
from mirage.core.api.client import SessionArg
from mirage.core.github.client import GitHubApiError, github_get
from mirage.core.github.config import GitHubConfig
from mirage.core.github.constants import DEFER_STATUSES
from mirage.core.github.repo import ensure_ref
from mirage.core.github.tree_entry import TreeEntry
from mirage.errors.fs import enoent, enotdir
from mirage.types import DirListing, FileStat, FileType
from mirage.utils.filetype import content_type_for_path

log = logging.getLogger(__name__)


def _head_of(data: dict[str, Any]) -> str | None:
    head = data.get("sha")
    return head if isinstance(head, str) and head else None


def _parse_tree_response(
    data: dict[str, Any],
    owner: str,
    repo: str,
    ref: str,
) -> tuple[dict[str, TreeEntry], bool, str | None]:
    truncated = bool(data.get("truncated"))
    if truncated:
        log.warning(
            "GitHub tree response truncated for %s/%s@%s", owner, repo, ref
        )
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
    return result, truncated, _head_of(data)


async def fetch_tree(
    config: GitHubConfig,
    owner: str,
    repo: str,
    ref: str,
    session: SessionArg = None,
) -> tuple[dict[str, TreeEntry], bool, str | None]:
    """Fetch the recursive tree of ``ref``, and the head it answered at.

    A tree asked by a branch, a tag or a commit sha names the commit it
    resolved to as its top-level ``sha`` (measured against GitHub,
    2026-09-30), so the rows and the version come from one response.

    Args:
        config (GitHubConfig): token and base URL.
        owner (str): repository owner.
        repo (str): repository name.
        ref (str): the ref the mount reads.
        session (SessionArg): pool or live session to ride.

    Returns:
        tuple[dict[str, TreeEntry], bool, str | None]: the rows keyed by
        repo-relative path, GitHub's ``truncated`` flag, and the head
        commit sha, or None when the response names none.
    """
    data = await github_get(
        config.token,
        "/repos/{owner}/{repo}/git/trees/{ref}",
        params={"recursive": "1"},
        base_url=config.base_url,
        session=session,
        owner=owner,
        repo=repo,
        ref=quote(ref, safe=""),
    )
    return _parse_tree_response(data, owner, repo, ref)


async def fetch_head(
    config: GitHubConfig,
    owner: str,
    repo: str,
    ref: str,
    session: SessionArg = None,
) -> str | None:
    """Ask which commit ``ref`` resolves to, with one shallow request.

    The shallow tree of the root answers the same top-level ``sha`` as the
    recursive one, at a fraction of the size.

    Args:
        config (GitHubConfig): token and base URL.
        owner (str): repository owner.
        repo (str): repository name.
        ref (str): the ref the mount reads.
        session (SessionArg): pool or live session to ride.

    Returns:
        str | None: the head commit sha, or None when the response names
        none.
    """
    data = await github_get(
        config.token,
        "/repos/{owner}/{repo}/git/trees/{ref}",
        base_url=config.base_url,
        session=session,
        owner=owner,
        repo=repo,
        ref=quote(ref, safe=""),
    )
    return _head_of(data)


async def fetch_dir_page(
    config: GitHubConfig,
    owner: str,
    repo: str,
    tree_sha: str,
    session: SessionArg = None,
) -> tuple[list[TreeEntry], bool]:
    """Fetch one directory's tree (non-recursive), and whether GitHub cut it.

    Args:
        config (GitHubConfig): token and base URL.
        owner (str): repository owner.
        repo (str): repository name.
        tree_sha (str): a raw tree sha, ref, or ``{ref}:{dir}`` expression.
        session (SessionArg): pool or live session to ride.

    Returns:
        tuple[list[TreeEntry], bool]: the rows, submodule gitlinks
        excluded, and GitHub's ``truncated`` flag.

    Raises:
        GitHubApiError: the response carries no tree, which must not read
            as an empty directory.
    """
    data = await github_get(
        config.token,
        "/repos/{owner}/{repo}/git/trees/{tree_sha}",
        base_url=config.base_url,
        session=session,
        owner=owner,
        repo=repo,
        tree_sha=quote(tree_sha, safe=""),
    )
    if "tree" not in data:
        raise GitHubApiError(
            f"GitHub tree response for {owner}/{repo} {tree_sha} carries "
            "no tree",
            0,
        )
    result: list[TreeEntry] = []
    for item in data["tree"]:
        if item["type"] == "commit":
            continue
        result.append(
            TreeEntry(
                path=item["path"],
                type=item["type"],
                sha=item["sha"],
                size=item.get("size"),
            )
        )
    return result, bool(data.get("truncated"))


async def fetch_dir_tree(
    config: GitHubConfig,
    owner: str,
    repo: str,
    tree_sha: str,
    session: SessionArg = None,
) -> list[TreeEntry]:
    """Fetch a single directory's whole tree (non-recursive).

    Used as fallback when the recursive tree was truncated, where the
    listing is cached as complete, so a directory GitHub cut short is
    refused rather than returned: a name past the cut would otherwise read
    as absent, which a ``read: fresh`` probe or a drift check takes as gone.

    Args:
        config (GitHubConfig): token and base URL.
        owner (str): repository owner.
        repo (str): repository name.
        tree_sha (str): the directory's tree sha, or a ref for the root.
        session (SessionArg): pool or live session to ride.

    Returns:
        list[TreeEntry]: the rows, submodule gitlinks excluded.

    Raises:
        GitHubApiError: GitHub truncated the listing, or sent no tree.
    """
    entries, truncated = await fetch_dir_page(
        config, owner, repo, tree_sha, session
    )
    if truncated:
        raise GitHubApiError(
            f"GitHub truncated the tree listing of {owner}/{repo} {tree_sha}",
            0,
        )
    return entries


async def point_row(
    accessor: GitHubAccessor, rel: str
) -> tuple[TreeEntry | None, bool] | None:
    """Look one path up in its parent directory's listing, with one request.

    Asks ``git/trees/{ref}:{parent}``, whose rows are exactly the recursive
    tree's for that directory: the same sha, and a symlink's own length
    rather than its target's, which the contents API reports instead. The
    expression is encoded as a single segment, so a ``/`` in the parent or
    the ref, or a ``:`` or ``#`` in a name, cannot change what is asked.

    Args:
        accessor (GitHubAccessor): the mount's accessor.
        rel (str): the path as the mount sees it.

    Returns:
        tuple[TreeEntry | None, bool] | None: the row (None when the
        listing has no such name) and whether GitHub truncated the
        listing, or None when the parent could not be seen and the whole
        tree has to answer.
    """
    ref = await ensure_ref(accessor)
    parent, _, name = rel.strip("/").rpartition("/")
    expression = f"{ref}:{parent}" if parent else ref
    try:
        rows, truncated = await fetch_dir_page(
            accessor.config,
            accessor.owner,
            accessor.repo,
            expression,
            accessor.pool,
        )
    except aiohttp.ClientResponseError as exc:
        if exc.status not in DEFER_STATUSES:
            raise
        log.debug("point lookup of %s deferred: %s", rel, exc)
        return None
    row = next((entry for entry in rows if entry.path == name), None)
    return row, truncated


def row_of(entry: TreeEntry, name: str) -> FileStat:
    """The row for one tree row, the same from every route: a file's carries
    its blob sha as its fingerprint, and every row its sha.

    Args:
        entry (TreeEntry): the git tree row.
        name (str): the row's last path segment.
    """
    if entry.type == "tree":
        return FileStat(
            name=name, type=FileType.DIRECTORY, extra={"sha": entry.sha}
        )
    return FileStat(
        name=name,
        size=entry.size,
        type=FileType.FILE,
        content=content_type_for_path(name),
        fingerprint=entry.sha,
        extra={"sha": entry.sha},
    )


def tree_rows(tree: dict[str, TreeEntry]) -> dict[str, list[FileStat]]:
    """Each folder's rows, keyed by its repo-relative path ("" the root).

    The repository root always has a listing, even when the tree is
    empty, so an empty repository lists as empty rather than missing.

    Args:
        tree (dict[str, TreeEntry]): the recursive tree, keyed by
            repo-relative path.
    """
    folders: dict[str, list[FileStat]] = defaultdict(list)
    folders[""] = []
    for path, entry in tree.items():
        if entry.type == "tree":
            folders.setdefault(path, [])
        parent, _, name = path.rpartition("/")
        folders[parent].append(row_of(entry, name))
    for rows in folders.values():
        rows.sort(key=lambda row: row.name)
    return dict(folders)


def tree_listing(
    tree: dict[str, TreeEntry], rel: str, version: str | None, virtual: str
) -> DirListing:
    """The listing of the folder ``rel`` out of the whole tree, with every
    folder below it as seeds, all at ``version``.

    Args:
        tree (dict[str, TreeEntry]): the recursive tree.
        rel (str): the folder, repo-relative ("" the root).
        version (str | None): the head the tree was fetched at.
        virtual (str): the path asked, for the error.

    Raises:
        NotADirectoryError: a file is at ``rel``.
        FileNotFoundError: nothing is.
    """
    folders = tree_rows(tree)
    if rel not in folders:
        if rel in tree:
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


def reseat_tree(
    accessor: GitHubAccessor,
    tree: dict[str, TreeEntry],
    truncated: bool,
    head: str | None,
) -> None:
    """Replace the accessor's tree with one response, and its version.

    Args:
        accessor (GitHubAccessor): the mount's accessor.
        tree (dict[str, TreeEntry]): the recursive tree just fetched.
        truncated (bool): whether GitHub truncated it.
        head (str | None): the head commit the response named.
    """
    accessor.truncated = truncated
    accessor.tree = tree
    accessor.tree_loaded = True
    # A truncated tree is not the whole listing at that head, so it is
    # versioned by nothing.
    accessor.tree_version = None if truncated else head


async def refresh_tree(
    accessor: GitHubAccessor,
) -> tuple[dict[str, TreeEntry], str | None] | None:
    """Fetch the ref's recursive tree and reseat the accessor on it.

    Args:
        accessor (GitHubAccessor): the mount's accessor.

    Returns:
        tuple[dict[str, TreeEntry], str | None] | None: the tree, keyed by
        repo-relative path, and the head it was read at, taken from this
        response rather than the accessor a concurrent refresh may have
        reseated since; None when GitHub truncated it, which then names
        only some paths.
    """
    ref = await ensure_ref(accessor)
    tree, truncated, head = await fetch_tree(
        accessor.config, accessor.owner, accessor.repo, ref, accessor.pool
    )
    reseat_tree(accessor, tree, truncated, head)
    return None if truncated else (tree, head)


async def ensure_tree(accessor: GitHubAccessor) -> None:
    """Fetch the recursive tree if this mount has not got one yet.

    The mount is constructed without touching the network, so readers
    that consult ``accessor.tree`` directly rather than through a listing
    (grep's scope counter and code search) hydrate it first. Every
    listing reseats it, so it is as current as the last listing.

    Hydration is tracked by ``tree_loaded``, never by whether the tree
    holds anything: an empty repository hydrates to ``{}``.

    Args:
        accessor (GitHubAccessor): the mount's accessor.
    """
    if accessor.tree_loaded:
        return
    async with accessor.tree_lock:
        if not accessor.tree_loaded:
            await refresh_tree(accessor)

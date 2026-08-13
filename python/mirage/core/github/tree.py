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

from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.core.github._client import github_get
from mirage.core.github.config import GitHubConfig
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
) -> tuple[dict[str, TreeEntry], bool]:
    data = await github_get(
        config.token,
        "/repos/{owner}/{repo}/git/trees/{ref}",
        params={"recursive": "1"},
        base_url=config.base_url,
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
) -> list[TreeEntry]:
    """Fetch a single directory's tree (non-recursive).

    Used as fallback when the recursive tree was truncated.
    """
    data = await github_get(
        config.token,
        "/repos/{owner}/{repo}/git/trees/{tree_sha}",
        base_url=config.base_url,
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
    tree: dict[str, TreeEntry]
) -> tuple[dict[str, IndexEntry], dict[str, list[str]]]:
    """Turn a git tree into the index's entry and children tables.

    Shared so the mount's initial seed and a later refill build the same
    rows; TypeScript keeps its twin in this module too (`populateIndex`).

    Args:
        tree (dict[str, TreeEntry]): the recursive tree, keyed by
            repo-relative path.

    Returns:
        tuple[dict[str, IndexEntry], dict[str, list[str]]]: entries keyed
        by absolute path, and each directory's sorted children.
    """
    dirs: dict[str, list[tuple[str, IndexEntry]]] = defaultdict(list)
    for path, entry in tree.items():
        parts = path.rsplit("/", 1)
        if len(parts) == 2:
            parent, name = "/" + parts[0], parts[1]
        else:
            parent, name = "/", parts[0]
        dirs[parent].append(
            (name,
             IndexEntry(
                 id=entry.sha,
                 name=name,
                 resource_type=("folder" if entry.type == "tree" else "file"),
                 size=entry.size,
             )))
    entries = {
        ("/" + parent.strip("/") + "/" + name).replace("//", "/"): entry
        for parent, rows in dirs.items()
        for name, entry in rows
    }
    children = {
        parent:
        sorted(("/" + parent.strip("/") + "/" + name).replace("//", "/")
               for name, _ in rows)
        for parent, rows in dirs.items()
    }
    return entries, children


async def refill_index(accessor, index: IndexCacheStore) -> bool:
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

    Returns:
        bool: whether a refill happened; False when there is no index to
        seed, so a caller does not retry a lookup that cannot change.
    """
    if index is NULL_INDEX:
        return False
    tree, truncated = await fetch_tree(accessor.config, accessor.owner,
                                       accessor.repo, accessor.ref)
    accessor.truncated = truncated
    entries, children = index_rows(tree)
    index.seed(entries, children,
               datetime.now(timezone.utc) + timedelta(days=365))
    return True

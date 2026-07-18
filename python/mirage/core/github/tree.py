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
from typing import Any

from mirage.core.github._client import github_get, github_get_sync
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
    """Fetch full recursive tree.

    Args:
        config (GitHubConfig): Auth + base config.
        owner (str): Repo owner.
        repo (str): Repo name.
        ref (str): Branch or sha.

    Returns:
        tuple: (tree_dict, truncated) where truncated is True when
            the repo has >100K entries and the API response is incomplete.
    """
    data = await github_get(
        config.token,
        "/repos/{owner}/{repo}/git/trees/{ref}",
        owner=owner,
        repo=repo,
        ref=ref,
        params={"recursive": "1"},
    )
    return _parse_tree_response(data, owner, repo, ref)


def fetch_tree_sync(
    config: GitHubConfig,
    owner: str,
    repo: str,
    ref: str,
) -> tuple[dict[str, TreeEntry], bool]:
    data = github_get_sync(
        config.token,
        "/repos/{owner}/{repo}/git/trees/{ref}",
        owner=owner,
        repo=repo,
        ref=ref,
        params={"recursive": "1"},
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
        owner=owner,
        repo=repo,
        tree_sha=tree_sha,
    )
    result: list[TreeEntry] = []
    for item in data.get("tree", []):
        result.append(
            TreeEntry(
                path=item["path"],
                type=item["type"],
                sha=item["sha"],
                size=item.get("size"),
            ))
    return result

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

from mirage.core.github._client import github_get
from mirage.core.github.config import GitHubConfig
from mirage.core.github.scope import scope_relative_key
from mirage.types import PathSpec

logger = logging.getLogger(__name__)


@dataclass
class SearchResult:
    path: str
    sha: str


async def search_code(
    config: GitHubConfig,
    owner: str,
    repo: str,
    query: str,
    path_filter: str | None = None,
) -> list[SearchResult]:
    q = f"{query} repo:{owner}/{repo}"
    if path_filter:
        q += f" path:{path_filter}"
    data = await github_get(config.token, "/search/code", params={"q": q})
    return [
        SearchResult(path=item["path"], sha=item["sha"])
        for item in data.get("items", [])
    ]


async def narrow_paths(
    config: GitHubConfig,
    owner: str,
    repo: str,
    pattern: str,
    paths: list[PathSpec],
) -> list[PathSpec]:
    """Use GitHub code search to narrow paths for grep/rg.

    Args:
        config (GitHubConfig): GitHub API config.
        owner (str): Repository owner.
        repo (str): Repository name.
        pattern (str): Literal search pattern.
        paths (list[PathSpec]): Scope paths, possibly mount-prefixed.

    Returns:
        list[PathSpec]: One PathSpec per matching file, repo-relative with a
        leading slash and the original mount prefix. Empty when search
        returned nothing.
    """
    mount_prefix = (paths[0].prefix
                    if paths and isinstance(paths[0], PathSpec) else "")
    narrowed: list[str] = []
    for p in paths:
        path_filter = scope_relative_key(p).strip("/")
        try:
            results = await search_code(
                config,
                owner,
                repo,
                query=pattern,
                path_filter=path_filter or None,
            )
        except Exception as exc:
            logger.warning(
                "github code search failed (%s); "
                "falling back to per-file scan", exc)
            continue
        scope_prefix = path_filter + "/" if path_filter else ""
        narrowed.extend(
            r.path for r in results
            if r.path == path_filter or r.path.startswith(scope_prefix))
    return [
        PathSpec(original=mount_prefix + "/" + n.lstrip("/"),
                 directory="",
                 prefix=mount_prefix,
                 resolved=True) for n in narrowed
    ]

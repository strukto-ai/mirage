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

import base64
from dataclasses import dataclass
from typing import Any

from mirage.accessor.github import GitHubAccessor
from mirage.core.api.client import SessionArg
from mirage.core.github.client import (GitHubApiError, github_get,
                                       github_request)
from mirage.core.github.config import GhConfig, GitHubConfig
from mirage.core.github.paginate import github_pages
from mirage.types import JsonValue


@dataclass(frozen=True, slots=True)
class RepoRef:
    owner: str
    repo: str


async def fetch_default_branch(config: GitHubConfig,
                               owner: str,
                               repo: str,
                               session: SessionArg = None) -> str:
    data = await github_get(config.token,
                            "/repos/{owner}/{repo}",
                            base_url=config.base_url,
                            owner=owner,
                            repo=repo,
                            session=session)
    return data["default_branch"]


async def ensure_default_branch(accessor: GitHubAccessor, ) -> str:
    """Fetch the repo's default branch once, on the first read needing it.

    The mount names a repository without contacting it, so this is the
    hydration point for the one caller that compares against the default
    branch (grep's code-search push-down, which GitHub only serves
    there).

    Args:
        accessor (GitHubAccessor): the mount's accessor.

    Returns:
        str: the repository's default branch.
    """
    if accessor.default_branch is not None:
        return accessor.default_branch
    async with accessor.branch_lock:
        if accessor.default_branch is None:
            accessor.default_branch = await fetch_default_branch(
                accessor.config, accessor.owner, accessor.repo, accessor.pool)
        return accessor.default_branch


async def ensure_ref(accessor: GitHubAccessor) -> str:
    """Settle which ref this mount reads, fetching the default branch once.

    A mount that named no ref follows the repository's default branch, and
    learning that costs a request the constructor cannot make. Every reader
    that needs a concrete ref -- the tree fetches, the watch walk, readdir's
    per-directory descent -- goes through here instead of reading
    ``accessor.ref`` directly, so an unpinned mount resolves exactly once and
    then behaves like a pinned one.

    Defaulting to the string ``"main"`` instead was the bug this replaces: a
    repository whose default branch is ``master`` (or anything else) 404s on
    every tree fetch, so the whole mount reads as empty.

    Args:
        accessor (GitHubAccessor): the mount's accessor.

    Returns:
        str: the ref to read, as named by the mount or as resolved from the
        repository's default branch.
    """
    if accessor.ref is not None:
        return accessor.ref
    resolved = await ensure_default_branch(accessor)
    accessor.ref = resolved
    return resolved


def parse_repo(spec: str) -> RepoRef:
    """Split gh's `[HOST/]OWNER/REPO`.

    The host is optional and leading, so the owner and the repository are
    always the last two segments. Taking the first two instead reads
    `github.com/acme/tools` as owner `github.com`, repo `acme` -- a
    different repository, reported as success.

    Args:
        spec (str): the repository as the line spelled it.

    Returns:
        RepoRef: the owner and repository names.

    Raises:
        ValueError: the spec is not one or two slashes of names.
    """
    parts = spec.split("/")
    # One extra segment is a host; two is not a repository any spelling
    # of gh's format reaches.
    if len(parts) not in (2, 3) or not all(parts[-2:]):
        raise ValueError(
            f'expected the "[HOST/]OWNER/REPO" format, got "{spec}"')
    return RepoRef(owner=parts[-2], repo=parts[-1])


async def login(config: GhConfig) -> str:
    """The authenticated account's login name.

    Args:
        config (GhConfig): the install's configuration.

    Returns:
        str: the login, empty when the account reports none.
    """
    me = await github_request(config.token,
                              "GET",
                              "/user",
                              base_url=config.base_url)
    name = me.get("login") if isinstance(me, dict) else None
    return name if isinstance(name, str) else ""


async def view_repo(config: GhConfig, ref: RepoRef) -> JsonValue:
    return await github_request(config.token,
                                "GET",
                                f"/repos/{ref.owner}/{ref.repo}",
                                base_url=config.base_url)


async def read_readme(config: GhConfig, ref: RepoRef) -> str | None:
    """The repository's README as text, or None when it has none.

    Args:
        config (GhConfig): the install's configuration.
        ref (RepoRef): the repository.

    Returns:
        str | None: the decoded README, None when the repo has none.
    """
    try:
        data = await github_request(config.token,
                                    "GET",
                                    f"/repos/{ref.owner}/{ref.repo}/readme",
                                    base_url=config.base_url)
    except GitHubApiError as exc:
        if exc.status == 404:
            return None
        raise
    if not isinstance(data, dict):
        return None
    content = data.get("content")
    if not isinstance(content, str):
        return None
    return base64.b64decode(content).decode("utf-8", "replace")


async def fork_repo(config: GhConfig,
                    ref: RepoRef,
                    name: str | None = None) -> JsonValue:
    body: JsonValue = {} if name is None else {"name": name}
    return await github_request(config.token,
                                "POST",
                                f"/repos/{ref.owner}/{ref.repo}/forks",
                                body,
                                base_url=config.base_url)


async def rename_repo(config: GhConfig, ref: RepoRef, name: str) -> JsonValue:
    return await github_request(config.token,
                                "PATCH",
                                f"/repos/{ref.owner}/{ref.repo}",
                                {"name": name},
                                base_url=config.base_url)


async def list_repos(config: GhConfig, owner: str | None,
                     limit: int) -> list[dict[str, Any]]:
    path = "/user/repos"
    if owner is not None:
        account = await github_request(config.token,
                                       "GET",
                                       f"/users/{owner}",
                                       base_url=config.base_url)
        kind = account.get("type") if isinstance(account, dict) else None
        prefix = "orgs" if kind == "Organization" else "users"
        path = f"/{prefix}/{owner}/repos"
    return await github_pages(config,
                              path,
                              params={"sort": "pushed"},
                              limit=limit)


async def create_repo(config: GhConfig, owner: str | None,
                      body: dict[str, JsonValue]) -> JsonValue:
    personal = owner is None
    if owner is not None:
        personal = owner.casefold() == (await login(config)).casefold()
    path = "/user/repos" if personal else f"/orgs/{owner}/repos"
    return await github_request(config.token,
                                "POST",
                                path,
                                body,
                                base_url=config.base_url)

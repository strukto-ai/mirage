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
from typing import Any, cast
from urllib.parse import urlsplit

from mirage.accessor.github import GitHubAccessor
from mirage.core.api.client import SessionArg
from mirage.core.github.client import (
    GitHubApiError,
    github_get,
    github_request,
)
from mirage.core.github.config import GhConfig, GitHubConfig
from mirage.core.github.constants import GRAPHQL_PATH
from mirage.core.github.paginate import github_pages
from mirage.types import JsonValue


@dataclass(frozen=True, slots=True)
class RepoRef:
    owner: str
    repo: str


async def fetch_default_branch(
    config: GitHubConfig, owner: str, repo: str, session: SessionArg = None
) -> str:
    data = await github_get(
        config.token,
        "/repos/{owner}/{repo}",
        base_url=config.base_url,
        owner=owner,
        repo=repo,
        session=session,
    )
    return data["default_branch"]


async def ensure_default_branch(
    accessor: GitHubAccessor,
) -> str:
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
                accessor.config, accessor.owner, accessor.repo, accessor.pool
            )
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


# go-gh's IsURL: a word that starts `git@` or with a scheme a git remote
# uses names a repository by URL rather than as `[HOST/]OWNER/REPO`.
URL_PREFIXES = (
    "git@",
    "ssh:",
    "git+ssh:",
    "git:",
    "http:",
    "git+https:",
    "https:",
)
# The schemes go-gh leaves alone before it reads an scp-style `host:path`.
PROTOCOLS = (*URL_PREFIXES[1:], "ftp:", "ftps:", "file:")


def _url_of(spec: str) -> tuple[str, str, str]:
    """A repository URL's scheme, host and path, as go-gh's ParseURL
    reads them: ``git@HOST:OWNER/REPO.git`` is scp syntax for ``ssh://``.

    Args:
        spec (str): the URL as the line spelled it.

    Raises:
        ValueError: the URL names no host.
    """
    raw = spec
    if not raw.startswith(PROTOCOLS) and ":" in raw and "\\" not in raw:
        raw = "ssh://" + raw.replace(":", "/", 1)
    try:
        url = urlsplit(raw)
        host = url.hostname
    except ValueError:
        host = None
    if not host:
        raise ValueError("no hostname detected")
    return url.scheme, host, url.path


def repo_host(spec: str) -> str | None:
    """The host a repository argument names, None for ``OWNER/REPO``.

    Args:
        spec (str): the repository as the line spelled it.
    """
    if spec.startswith(URL_PREFIXES):
        return _url_of(spec)[1]
    parts = spec.split("/")
    return parts[0].lower() if len(parts) == 3 else None


def _repo_from_url(spec: str) -> RepoRef:
    """A repository named by URL, as go-gh's ParseURL reads it.

    The path must be exactly two segments once its slashes are trimmed,
    and ``.git`` comes off the name.

    Args:
        spec (str): the URL as the line spelled it.
    """
    scheme, _host, path = _url_of(spec)
    if scheme == "ssh" and path.startswith("//"):
        path = path[1:]
    parts = path.strip("/").split("/")
    if len(parts) != 2:
        raise ValueError(f"invalid path: {path}")
    return RepoRef(owner=parts[0], repo=parts[1].removesuffix(".git"))


def parse_repo(spec: str) -> RepoRef:
    """Split gh's repository argument.

    A URL (``https://HOST/OWNER/REPO``, ``git@HOST:OWNER/REPO.git``) or
    ``[HOST/]OWNER/REPO``. The host is optional and leading, so the owner
    and the repository are always the last two segments. Taking the first
    two instead reads `github.com/acme/tools` as owner `github.com`, repo
    `acme` -- a different repository, reported as success.

    Args:
        spec (str): the repository as the line spelled it.

    Returns:
        RepoRef: the owner and repository names.

    Raises:
        ValueError: the spec is neither a URL nor one or two slashes of
            names.
    """
    if spec.startswith(URL_PREFIXES):
        return _repo_from_url(spec)
    parts = spec.split("/")
    # One extra segment is a host; two is not a repository any spelling
    # of gh's format reaches.
    if len(parts) not in (2, 3) or not all(parts):
        raise ValueError(
            f'expected the "[HOST/]OWNER/REPO" format, got "{spec}"'
        )
    return RepoRef(owner=parts[-2], repo=parts[-1])


async def login(config: GhConfig) -> str:
    """The authenticated account's login name.

    Args:
        config (GhConfig): the install's configuration.

    Returns:
        str: the login, empty when the account reports none.
    """
    me = await github_request(
        config.token, "GET", "/user", base_url=config.base_url
    )
    name = me.get("login") if isinstance(me, dict) else None
    return name if isinstance(name, str) else ""


async def view_repo(config: GhConfig, ref: RepoRef) -> JsonValue:
    return await github_request(
        config.token,
        "GET",
        f"/repos/{ref.owner}/{ref.repo}",
        base_url=config.base_url,
    )


async def graphql_data(
    config: GhConfig, query: str, variables: dict[str, JsonValue]
) -> dict[str, Any]:
    """Run one GraphQL query and return its data, refusing the way gh does.

    gh names each error with the path of the field that raised it and
    joins them: ``GraphQL: Could not resolve to a Repository with the
    name 'o/r'. (repository)``.

    Args:
        config (GhConfig): the install's configuration.
        query (str): the GraphQL document.
        variables (dict[str, JsonValue]): its variables.
    """
    response = await github_request(
        config.token,
        "POST",
        GRAPHQL_PATH,
        {"query": query, "variables": variables},
        base_url=config.base_url,
    )
    payload = (
        cast(dict[str, Any], response) if isinstance(response, dict) else {}
    )
    errors = cast(list[dict[str, Any]], payload.get("errors") or [])
    if errors:
        messages: list[str] = []
        for error in errors:
            path = ".".join(str(part) for part in error.get("path") or [])
            message = str(error.get("message") or "")
            messages.append(f"{message} ({path})" if path else message)
        raise ValueError(f"GraphQL: {', '.join(messages)}")
    data = payload.get("data")
    return data if isinstance(data, dict) else {}


async def repository_fields(
    config: GhConfig, ref: RepoRef, selection: str
) -> dict[str, Any]:
    """The selected fields of one repository, over GraphQL, as gh reads
    them for ``repo view --json``: one query naming only what was asked
    for.

    Args:
        config (GhConfig): the install's configuration.
        ref (RepoRef): the repository.
        selection (str): the GraphQL selection inside ``repository { }``.
    """
    data = await graphql_data(
        config,
        "query RepositoryInfo($owner: String!, $name: String!) {\n"
        f"    repository(owner: $owner, name: $name) {{{selection}}}\n  }}",
        {"owner": ref.owner, "name": ref.repo},
    )
    repository = data.get("repository")
    return repository if isinstance(repository, dict) else {}


async def list_repository_fields(
    config: GhConfig, owner: str | None, limit: int, selection: str
) -> list[dict[str, Any]]:
    """The selected fields of an owner's repositories, over GraphQL, as gh
    reads them for ``repo list --json``: the owner's own, most recently
    pushed first, a page of up to 100 at a time until ``limit``. No owner
    means the viewer.

    Args:
        config (GhConfig): the install's configuration.
        owner (str | None): the user or organization, or the viewer.
        limit (int): how many repositories at most.
        selection (str): the GraphQL selection for each repository.
    """
    if owner is None:
        head = (
            "query RepositoryList($perPage:Int!,$endCursor:String,"
            "$privacy:RepositoryPrivacy,$fork:Boolean) {\n"
            "    repositoryOwner: viewer {"
        )
    else:
        head = (
            "query RepositoryList($perPage:Int!,$endCursor:String,"
            "$privacy:RepositoryPrivacy,$fork:Boolean,$owner:String!) {\n"
            "    repositoryOwner(login: $owner) {"
        )
    query = (
        f"{head}\n      login\n      repositories(first: $perPage, "
        "after: $endCursor, privacy: $privacy, isFork: $fork, "
        "ownerAffiliations: OWNER, orderBy: { field: PUSHED_AT, "
        f"direction: DESC }}) {{\n        nodes{{{selection}}}\n"
        "        totalCount\n        pageInfo{hasNextPage,endCursor}\n"
        "      }\n    }\n  }"
    )
    rows: list[dict[str, Any]] = []
    cursor: str | None = None
    while len(rows) < limit:
        variables: dict[str, JsonValue] = {"perPage": min(limit, 100)}
        if owner is not None:
            variables["owner"] = owner
        if cursor is not None:
            variables["endCursor"] = cursor
        data = await graphql_data(config, query, variables)
        owner_node = data.get("repositoryOwner") or {}
        page = owner_node.get("repositories") or {}
        rows.extend(page.get("nodes") or [])
        info = page.get("pageInfo") or {}
        following = info.get("endCursor")
        if not info.get("hasNextPage") or following in (None, cursor):
            break
        cursor = following
    return rows[:limit]


async def read_readme(config: GhConfig, ref: RepoRef) -> str | None:
    """The repository's README as text, or None when it has none.

    Args:
        config (GhConfig): the install's configuration.
        ref (RepoRef): the repository.

    Returns:
        str | None: the decoded README, None when the repo has none.
    """
    try:
        data = await github_request(
            config.token,
            "GET",
            f"/repos/{ref.owner}/{ref.repo}/readme",
            base_url=config.base_url,
        )
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


async def fork_repo(
    config: GhConfig, ref: RepoRef, body: dict[str, JsonValue] | None = None
) -> JsonValue:
    """Fork a repository.

    Args:
        config (GhConfig): the install.
        ref (RepoRef): the repository to fork.
        body (dict[str, JsonValue] | None): the request's ``name``,
            ``organization`` and ``default_branch_only``.
    """
    return await github_request(
        config.token,
        "POST",
        f"/repos/{ref.owner}/{ref.repo}/forks",
        body or {},
        base_url=config.base_url,
    )


async def edit_repo(
    config: GhConfig, ref: RepoRef, body: dict[str, JsonValue]
) -> JsonValue:
    """Change a repository's settings: the one PATCH ``gh repo edit`` sends.

    Args:
        config (GhConfig): the install's configuration.
        ref (RepoRef): the repository.
        body (dict[str, JsonValue]): the settings to change.
    """
    return await github_request(
        config.token,
        "PATCH",
        f"/repos/{ref.owner}/{ref.repo}",
        body,
        base_url=config.base_url,
    )


async def repo_topics(config: GhConfig, ref: RepoRef) -> list[str]:
    """A repository's topics, which GitHub keeps and replaces as one list.

    Args:
        config (GhConfig): the install's configuration.
        ref (RepoRef): the repository.
    """
    data = await github_request(
        config.token,
        "GET",
        f"/repos/{ref.owner}/{ref.repo}/topics",
        base_url=config.base_url,
    )
    names = data.get("names") if isinstance(data, dict) else None
    return (
        [n for n in names if isinstance(n, str)]
        if isinstance(names, list)
        else []
    )


async def set_repo_topics(
    config: GhConfig, ref: RepoRef, names: list[str]
) -> JsonValue:
    return await github_request(
        config.token,
        "PUT",
        f"/repos/{ref.owner}/{ref.repo}/topics",
        {"names": cast(JsonValue, names)},
        base_url=config.base_url,
    )


async def delete_repo(config: GhConfig, ref: RepoRef) -> JsonValue:
    return await github_request(
        config.token,
        "DELETE",
        f"/repos/{ref.owner}/{ref.repo}",
        base_url=config.base_url,
    )


async def rename_repo(config: GhConfig, ref: RepoRef, name: str) -> JsonValue:
    return await github_request(
        config.token,
        "PATCH",
        f"/repos/{ref.owner}/{ref.repo}",
        {"name": name},
        base_url=config.base_url,
    )


async def list_repos(
    config: GhConfig, owner: str | None, limit: int
) -> list[dict[str, Any]]:
    path = "/user/repos"
    if owner is not None:
        account = await github_request(
            config.token, "GET", f"/users/{owner}", base_url=config.base_url
        )
        kind = account.get("type") if isinstance(account, dict) else None
        prefix = "orgs" if kind == "Organization" else "users"
        path = f"/{prefix}/{owner}/repos"
    return await github_pages(
        config, path, params={"sort": "pushed"}, limit=limit
    )


async def create_repo(
    config: GhConfig, owner: str | None, body: dict[str, JsonValue]
) -> JsonValue:
    personal = owner is None
    if owner is not None:
        personal = owner.casefold() == (await login(config)).casefold()
    path = "/user/repos" if personal else f"/orgs/{owner}/repos"
    return await github_request(
        config.token, "POST", path, body, base_url=config.base_url
    )

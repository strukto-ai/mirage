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

# Repository arguments are read as go-gh v2.13.0 reads them (MIT; see
# licenses/third_party/go-gh.txt).

from dataclasses import dataclass
from typing import Any, cast
from urllib.parse import urlsplit

from mirage.accessor.github import GitHubAccessor, GitHubAccount
from mirage.core.github.client import github_get, github_request
from mirage.core.github.constants import GRAPHQL_PATH
from mirage.types import JsonValue


@dataclass(frozen=True, slots=True)
class RepoRef:
    owner: str
    repo: str


async def fetch_default_branch(
    account: GitHubAccount, owner: str, repo: str
) -> str:
    data = await github_get(
        account, "/repos/{owner}/{repo}", owner=owner, repo=repo
    )
    return cast(str, data["default_branch"])


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
                accessor.account, accessor.owner, accessor.repo
            )
        return accessor.default_branch


async def ensure_ref(accessor: GitHubAccessor) -> str:
    """Settle which ref this mount reads, fetching the default branch once.

    A mount that named no ref follows the repository's default branch, and
    learning that costs a request the constructor cannot make. Every reader
    that needs a concrete ref -- the tree fetches, the delta walk, readdir's
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


async def login(account: GitHubAccount) -> str:
    """The authenticated account's login name.

    Args:
        account (GitHubAccount): the token, API base and pool to ride.

    Returns:
        str: the login, empty when the account reports none.
    """
    me = await github_request(account, "GET", "/user")
    name = me.get("login") if isinstance(me, dict) else None
    return name if isinstance(name, str) else ""


async def graphql_data(
    account: GitHubAccount, query: str, variables: dict[str, JsonValue]
) -> dict[str, Any]:
    """Run one GraphQL query and return its data, refusing the way gh does.

    gh names each error with the path of the field that raised it and
    joins them: ``GraphQL: Could not resolve to a Repository with the
    name 'o/r'. (repository)``.

    Args:
        account (GitHubAccount): the token, API base and pool to ride.
        query (str): the GraphQL document.
        variables (dict[str, JsonValue]): its variables.
    """
    response = await github_request(
        account, "POST", GRAPHQL_PATH, {"query": query, "variables": variables}
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

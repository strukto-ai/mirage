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

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from mirage.accessor.github import GitHubAccount
from mirage.core.github.client import github_request
from mirage.core.github.paginate import github_pages
from mirage.core.github.repo import RepoRef, graphql_data
from mirage.types import JsonValue

STATUS_CONCLUSIONS = ("error", "failure", "success")


def _path(ref: RepoRef, tail: str = "") -> str:
    return f"/repos/{ref.owner}/{ref.repo}/pulls{tail}"


async def list_pulls(
    account: GitHubAccount,
    ref: RepoRef,
    params: dict[str, str],
    limit: int,
    *,
    include: Callable[[dict[str, Any]], bool] | None = None,
) -> list[dict[str, Any]]:
    return await github_pages(
        account, _path(ref), params=params, limit=limit, include=include
    )


async def get_pull(
    account: GitHubAccount, ref: RepoRef, number: int
) -> JsonValue:
    return await github_request(account, "GET", _path(ref, f"/{number}"))


async def pull_request_fields(
    account: GitHubAccount,
    ref: RepoRef,
    number: int,
    selection: str,
    end_cursor: str | None = None,
) -> dict[str, Any]:
    """The selected fields of one pull request, over GraphQL, as gh's
    PullRequestByNumber asks for them for ``pr view --json``: one query
    naming only what was asked for. A selection that reads the page of a
    connection after ``$endCursor`` is given that cursor as
    ``end_cursor``.

    Args:
        account (GitHubAccount): the token, API base and pool to ride.
        ref (RepoRef): the repository.
        number (int): the pull request.
        selection (str): the GraphQL selection inside ``pullRequest { }``.
        end_cursor (str | None): the cursor ``$endCursor`` carries.
    """
    variables: dict[str, JsonValue] = {
        "owner": ref.owner,
        "repo": ref.repo,
        "pr_number": number,
    }
    if end_cursor is not None:
        variables["endCursor"] = end_cursor
    cursor = "" if end_cursor is None else ", $endCursor: String"
    data = await graphql_data(
        account,
        "query PullRequestByNumber($owner: String!, $repo: String!, "
        f"$pr_number: Int!{cursor}) {{\n"
        "    repository(owner: $owner, name: $repo) {\n"
        f"      pullRequest(number: $pr_number) {{{selection}}}\n"
        "    }\n  }",
        variables,
    )
    repository = data.get("repository")
    pull = (
        repository.get("pullRequest") if isinstance(repository, dict) else None
    )
    return pull if isinstance(pull, dict) else {}


@dataclass(frozen=True, slots=True)
class PullListFilter:
    """The narrowing ``gh pr list`` applies before it lists.

    Args:
        states (tuple[str, ...]): the pull request states to list.
        base (str | None): the base branch, or any.
        head (str | None): the head branch, or any.
    """

    states: tuple[str, ...]
    base: str | None = None
    head: str | None = None


_PULL_LIST = (
    "    query PullRequestList(\n      $owner: String!,\n"
    "      $repo: String!,\n      $limit: Int!,\n"
    "      $endCursor: String,\n      $baseBranch: String,\n"
    "      $headBranch: String,\n"
    "      $state: [PullRequestState!] = OPEN\n    ) {\n"
    "      repository(owner: $owner, name: $repo) {\n"
    "        pullRequests(\n          states: $state,\n"
    "          baseRefName: $baseBranch,\n"
    "          headRefName: $headBranch,\n          first: $limit,\n"
    "          after: $endCursor,\n"
    "          orderBy: {field: CREATED_AT, direction: DESC}\n"
    "        ) {\n          totalCount\n          nodes {\n"
    "            ...pr\n          }\n          pageInfo {\n"
    "            hasNextPage\n            endCursor\n          }\n"
    "        }\n      }\n    }"
)


async def list_pull_request_fields(
    account: GitHubAccount,
    ref: RepoRef,
    filter_: PullListFilter,
    limit: int,
    selection: str,
) -> list[dict[str, Any]]:
    """The selected fields of a repository's pull requests, over GraphQL,
    as gh's PullRequestList asks for them for ``pr list --json``: newest
    first, a page of up to 100 at a time until ``limit``. A pull request
    a later page repeats is listed once, which gh can only tell when the
    line asked for ``number``.

    Args:
        account (GitHubAccount): the token, API base and pool to ride.
        ref (RepoRef): the repository.
        filter_ (PullListFilter): the states and the base and head
            branches.
        limit (int): how many pull requests at most.
        selection (str): the GraphQL selection for each pull request.
    """
    query = f"fragment pr on PullRequest{{{selection}}}\n{_PULL_LIST}"
    rows: list[dict[str, Any]] = []
    seen: set[int] = set()
    cursor: str | None = None
    page_limit = min(limit, 100)
    while len(rows) < limit:
        variables: dict[str, JsonValue] = {
            "owner": ref.owner,
            "repo": ref.repo,
            "limit": page_limit,
            "state": list(filter_.states),
        }
        if filter_.base:
            variables["baseBranch"] = filter_.base
        if filter_.head:
            variables["headBranch"] = filter_.head
        if cursor is not None:
            variables["endCursor"] = cursor
        data = await graphql_data(account, query, variables)
        repository = data.get("repository") or {}
        page = repository.get("pullRequests") or {}
        for node in page.get("nodes") or []:
            number = node.get("number")
            if isinstance(number, int) and number > 0:
                if number in seen:
                    continue
                seen.add(number)
            rows.append(node)
            if len(rows) == limit:
                break
        info = page.get("pageInfo") or {}
        following = info.get("endCursor")
        if not info.get("hasNextPage") or following in (None, cursor):
            break
        cursor = following
        page_limit = min(page_limit, limit - len(rows))
    return rows


async def create_pull(
    account: GitHubAccount, ref: RepoRef, body: dict[str, JsonValue]
) -> JsonValue:
    return await github_request(account, "POST", _path(ref), body)


async def edit_pull(
    account: GitHubAccount,
    ref: RepoRef,
    number: int,
    body: dict[str, JsonValue],
) -> JsonValue:
    return await github_request(
        account, "PATCH", _path(ref, f"/{number}"), body
    )


async def merge_pull(
    account: GitHubAccount,
    ref: RepoRef,
    number: int,
    body: dict[str, JsonValue],
) -> JsonValue:
    if not body:
        return await github_request(
            account, "PUT", _path(ref, f"/{number}/merge")
        )
    return await github_request(
        account, "PUT", _path(ref, f"/{number}/merge"), body
    )


async def comment_pull(
    account: GitHubAccount, ref: RepoRef, number: int, body: str
) -> JsonValue:
    await get_pull(account, ref, number)
    path = f"/repos/{ref.owner}/{ref.repo}/issues/{number}/comments"
    return await github_request(account, "POST", path, {"body": body})


async def diff_pull(account: GitHubAccount, ref: RepoRef, number: int) -> str:
    value = await github_request(
        account,
        "GET",
        _path(ref, f"/{number}"),
        headers={"Accept": "application/vnd.github.v3.diff"},
    )
    return value if isinstance(value, str) else ""


def _status_check(row: dict[str, Any]) -> dict[str, Any]:
    state = str(row.get("state") or "")
    done = state in STATUS_CONCLUSIONS
    return {
        "name": row.get("context") or "",
        "status": "completed" if done else state,
        "conclusion": state if done else None,
        "details_url": row.get("target_url") or "",
        "output": {"summary": row.get("description") or ""},
        "started_at": row.get("created_at"),
        "completed_at": row.get("updated_at"),
    }


async def commit_statuses(
    account: GitHubAccount, ref: RepoRef, sha: str
) -> list[dict[str, Any]]:
    value = await github_request(
        account, "GET", f"/repos/{ref.owner}/{ref.repo}/commits/{sha}/status"
    )
    rows = value.get("statuses") if isinstance(value, dict) else None
    if not isinstance(rows, list):
        return []
    return [row for row in rows if isinstance(row, dict)]


async def pull_checks(
    account: GitHubAccount, ref: RepoRef, number: int, limit: int = 100
) -> list[dict[str, Any]]:
    pull = await get_pull(account, ref, number)
    head = pull.get("head") if isinstance(pull, dict) else None
    sha = head.get("sha") if isinstance(head, dict) else None
    if not isinstance(sha, str):
        return []
    path = f"/repos/{ref.owner}/{ref.repo}/commits/{sha}/check-runs"
    runs = await github_pages(account, path, limit=limit, key="check_runs")
    statuses = await commit_statuses(account, ref, sha)
    return runs + [_status_check(row) for row in statuses]

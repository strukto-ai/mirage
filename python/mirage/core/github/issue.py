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

from dataclasses import dataclass
from typing import Any, cast

from mirage.accessor.github import GitHubAccount
from mirage.core.github.client import github_request
from mirage.core.github.constants import GRAPHQL_PATH
from mirage.core.github.paginate import github_pages
from mirage.core.github.repo import RepoRef, graphql_data
from mirage.types import JsonValue


def _path(ref: RepoRef, tail: str = "") -> str:
    return f"/repos/{ref.owner}/{ref.repo}/issues{tail}"


def _only_issue(value: JsonValue, number: int) -> JsonValue:
    if isinstance(value, dict) and "pull_request" in value:
        raise ValueError(f"#{number} is a pull request, not an issue")
    return value


async def list_issues(
    account: GitHubAccount, ref: RepoRef, params: dict[str, str], limit: int
) -> list[dict[str, Any]]:
    return await github_pages(
        account,
        _path(ref),
        params=params,
        limit=limit,
        include=lambda row: "pull_request" not in row,
    )


async def get_issue(
    account: GitHubAccount, ref: RepoRef, number: int
) -> JsonValue:
    value = await github_request(account, "GET", _path(ref, f"/{number}"))
    return _only_issue(value, number)


async def create_issue(
    account: GitHubAccount, ref: RepoRef, body: dict[str, JsonValue]
) -> JsonValue:
    return await github_request(account, "POST", _path(ref), body)


async def edit_issue(
    account: GitHubAccount,
    ref: RepoRef,
    number: int,
    body: dict[str, JsonValue],
) -> JsonValue:
    await get_issue(account, ref, number)
    return await github_request(
        account, "PATCH", _path(ref, f"/{number}"), body
    )


async def comment_issue(
    account: GitHubAccount, ref: RepoRef, number: int, body: str
) -> JsonValue:
    await get_issue(account, ref, number)
    return await github_request(
        account, "POST", _path(ref, f"/{number}/comments"), {"body": body}
    )


COMMENTS_QUERY = """
query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    issueOrPullRequest(number: $number) {
      ... on Issue {
        comments(first: 100, after: $cursor) {
          nodes { ...CommentFields }
          pageInfo { hasNextPage endCursor }
        }
      }
      ... on PullRequest {
        comments(first: 100, after: $cursor) {
          nodes { ...CommentFields }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
}
fragment CommentFields on IssueComment {
  id
  author { login }
  authorAssociation
  body
  createdAt
  includesCreatedEdit
  isMinimized
  minimizedReason
  reactionGroups { content users { totalCount } }
  url
  viewerDidAuthor
}
"""


async def issue_comments(
    account: GitHubAccount, ref: RepoRef, number: int
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    cursor: str | None = None
    while True:
        response = await github_request(
            account,
            "POST",
            GRAPHQL_PATH,
            {
                "query": COMMENTS_QUERY,
                "variables": {
                    "owner": ref.owner,
                    "repo": ref.repo,
                    "number": number,
                    "cursor": cursor,
                },
            },
        )
        if not isinstance(response, dict):
            raise ValueError("Invalid GitHub comments response")
        payload = cast(dict[str, Any], response)
        if payload.get("errors"):
            raise ValueError(
                "; ".join(e["message"] for e in payload["errors"])
            )
        repo = (payload.get("data") or {}).get("repository") or {}
        comments = (repo.get("issueOrPullRequest") or {}).get("comments")
        if comments is None:
            raise ValueError(
                "Could not resolve comments for this issue or pull request"
            )
        rows.extend(comments["nodes"])
        page = comments["pageInfo"]
        if not page["hasNextPage"]:
            return rows
        next_cursor = page["endCursor"]
        if not next_cursor or next_cursor == cursor:
            raise ValueError("GitHub returned a non-advancing comments cursor")
        cursor = next_cursor


@dataclass(frozen=True, slots=True)
class IssueSelections:
    """The selection for each half of gh's IssueByNumber; an empty one is
    left out.

    Args:
        issue (str): what to read of an issue.
        pull (str): what to read of a pull request.
    """

    issue: str
    pull: str


async def issue_fields(
    account: GitHubAccount,
    ref: RepoRef,
    number: int,
    selections: IssueSelections,
    end_cursor: str | None = None,
) -> dict[str, Any]:
    """The selected fields of one issue, over GraphQL, as gh's
    IssueByNumber asks for them for ``issue view --json``: the number read
    as an issue or as a pull request, each half with its own selection. A
    selection that reads a later page of a connection is given that
    cursor as ``end_cursor``.

    Args:
        account (GitHubAccount): the token, API base and pool to ride.
        ref (RepoRef): the repository.
        number (int): the issue or pull request.
        selections (IssueSelections): what to read of each.
        end_cursor (str | None): the cursor ``$endCursor`` carries.

    Raises:
        ValueError: when the repository has issues disabled, or the
            answer carried no issue.
    """
    variables: dict[str, JsonValue] = {
        "owner": ref.owner,
        "repo": ref.repo,
        "number": number,
    }
    if end_cursor is not None:
        variables["endCursor"] = end_cursor
    cursor = "" if end_cursor is None else ", $endCursor: String"
    halves = (
        f"\n        ...on Issue{{{selections.issue}}}"
        if selections.issue
        else ""
    ) + (
        f"\n        ...on PullRequest{{{selections.pull}}}"
        if selections.pull
        else ""
    )
    data = await graphql_data(
        account,
        "query IssueByNumber($owner: String!, $repo: String!, "
        f"$number: Int!{cursor}) {{\n"
        "    repository(owner: $owner, name: $repo) {\n"
        "      hasIssuesEnabled\n"
        "      issue: issueOrPullRequest(number: $number) {\n"
        f"        __typename{halves}\n      }}\n    }}\n  }}",
        variables,
    )
    repository = data.get("repository")
    repository = repository if isinstance(repository, dict) else {}
    issue = repository.get("issue")
    if isinstance(issue, dict):
        return issue
    if repository.get("hasIssuesEnabled") is False:
        raise ValueError(
            f"the '{ref.owner}/{ref.repo}' repository has disabled issues"
        )
    raise ValueError("issue was not found but GraphQL reported no error")


@dataclass(frozen=True, slots=True)
class IssueListFilter:
    """The narrowing ``gh issue list`` applies before it lists.

    Args:
        states (tuple[str, ...]): the issue states to list.
        assignee (str | None): the assignee, or any.
        author (str | None): the author, or any.
        labels (tuple[str, ...]): labels an issue must all carry.
    """

    states: tuple[str, ...]
    assignee: str | None = None
    author: str | None = None
    labels: tuple[str, ...] = ()


_ISSUE_LIST = (
    "\tquery IssueList($owner: String!, $repo: String!, $limit: Int, "
    "$endCursor: String, $states: [IssueState!] = OPEN, $assignee: String, "
    "$author: String, $mention: String, $labels: [String!]) {\n"
    "\t\trepository(owner: $owner, name: $repo) {\n"
    "\t\t\thasIssuesEnabled\n\t\t\tissues(first: $limit, after: $endCursor, "
    "orderBy: {field: CREATED_AT, direction: DESC}, states: $states, "
    "filterBy: {assignee: $assignee, createdBy: $author, mentioned: $mention, "
    "labels: $labels}) {\n\t\t\t\ttotalCount\n\t\t\t\tnodes {\n"
    "\t\t\t\t\t...issue\n\t\t\t\t}\n\t\t\t\tpageInfo {\n"
    "\t\t\t\t\thasNextPage\n\t\t\t\t\tendCursor\n\t\t\t\t}\n"
    "\t\t\t}\n\t\t}\n\t}\n\t"
)


async def list_issue_fields(
    account: GitHubAccount,
    ref: RepoRef,
    filter_: IssueListFilter,
    limit: int,
    selection: str,
) -> list[dict[str, Any]]:
    """The selected fields of a repository's issues, over GraphQL, as gh's
    IssueList asks for them for ``issue list --json``: newest first, a
    page of up to 100 at a time until ``limit``. gh reaches for search to
    narrow by label; the connection's own ``labels`` filter narrows to the
    same issues.

    Args:
        account (GitHubAccount): the token, API base and pool to ride.
        ref (RepoRef): the repository.
        filter_ (IssueListFilter): the states, assignee, author and
            labels.
        limit (int): how many issues at most.
        selection (str): the GraphQL selection for each issue.

    Raises:
        ValueError: when the repository has issues disabled.
    """
    query = f"fragment issue on Issue {{{selection}}}\n{_ISSUE_LIST}"
    rows: list[dict[str, Any]] = []
    cursor: str | None = None
    page_limit = min(limit, 100)
    while len(rows) < limit:
        variables: dict[str, JsonValue] = {
            "owner": ref.owner,
            "repo": ref.repo,
            "states": list(filter_.states),
            "limit": page_limit,
        }
        if filter_.assignee:
            variables["assignee"] = filter_.assignee
        if filter_.author:
            variables["author"] = filter_.author
        if filter_.labels:
            variables["labels"] = list(filter_.labels)
        if cursor is not None:
            variables["endCursor"] = cursor
        data = await graphql_data(account, query, variables)
        repository = data.get("repository") or {}
        if repository.get("hasIssuesEnabled") is False:
            raise ValueError(
                f"the '{ref.owner}/{ref.repo}' repository has disabled issues"
            )
        page = repository.get("issues") or {}
        for node in page.get("nodes") or []:
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

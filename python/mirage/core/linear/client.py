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

import json
from typing import Any

import aiohttp

from mirage.accessor.linear import LinearAccessor
from mirage.core.api.client import api_request
from mirage.core.linear.config import LinearConfig
from mirage.core.linear.queries import (
    COMMENT_CREATE_MUTATION,
    COMMENT_UPDATE_MUTATION,
    ISSUE_COMMENTS_QUERY,
    ISSUE_CREATE_MUTATION,
    ISSUE_LOOKUP_QUERY,
    ISSUE_QUERY,
    ISSUE_SEARCH_QUERY,
    ISSUE_UPDATE_MUTATION,
    TEAM_CYCLES_QUERY,
    TEAM_DOCUMENTS_QUERY,
    TEAM_ISSUES_QUERY,
    TEAM_LABELS_QUERY,
    TEAM_LIST_QUERY,
    TEAM_MEMBERS_QUERY,
    TEAM_PROJECTS_QUERY,
    USER_LOOKUP_QUERY,
)
from mirage.errors.fs import enoent
from mirage.types import JsonValue
from mirage.vfs.secrets import reveal_secret


class LinearAPIError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        errors: list[dict[str, Any]] | None = None,
        status: int | None = None,
    ) -> None:
        super().__init__(message)
        self.errors = errors if errors is not None else []
        self.status = status


def linear_headers(config: LinearConfig) -> dict[str, str]:
    return {
        "Authorization": reveal_secret(config.api_key),
        "Content-Type": "application/json",
    }


def _error_of(resp: aiohttp.ClientResponse, text: str) -> Exception:
    try:
        data = json.loads(text)
    except ValueError:
        data = None
    errors = data.get("errors") if isinstance(data, dict) else None
    message = _error_message(errors) or f"Linear API error: HTTP {resp.status}"
    return LinearAPIError(message, errors=errors, status=resp.status)


async def graphql_request(
    accessor: LinearAccessor,
    query: str,
    variables: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "query": query,
        "variables": variables or {},
    }
    data: dict[str, Any] = await api_request(
        "POST",
        accessor.config.base_url,
        error_of=_error_of,
        headers=linear_headers(accessor.config),
        json_body=payload,
        session=accessor.pool,
    )
    # GraphQL reports failures in-band: a 200 whose body carries an
    # errors array is still a failed call.
    if data.get("errors"):
        message = _error_message(data["errors"]) or "Linear API error"
        raise LinearAPIError(message, errors=data["errors"])
    result: dict[str, Any] = data["data"]
    return result


def _error_message(errors: list[dict[str, Any]] | None) -> str | None:
    if not errors:
        return None
    first = errors[0]
    if isinstance(first, dict):
        msg = first.get("message")
        if isinstance(msg, str):
            return msg
    return None


async def paginate_connection(
    accessor: LinearAccessor,
    query: str,
    variables: dict[str, Any] | None,
    path: tuple[str, ...],
    limit: int | None = None,
) -> list[dict[str, Any]]:
    merged_vars = dict(variables or {})
    merged_vars.setdefault("first", 50)
    merged_vars["after"] = None
    nodes: list[dict[str, Any]] = []
    while True:
        data = await graphql_request(accessor, query, merged_vars)
        cursor = data
        for key in path:
            cursor = cursor[key]
        nodes.extend(cursor["nodes"])
        page_info = cursor["pageInfo"]
        if not page_info.get("hasNextPage"):
            break
        if limit is not None and len(nodes) >= limit:
            break
        merged_vars["after"] = page_info.get("endCursor")
    return nodes


async def list_teams(accessor: LinearAccessor) -> list[dict[str, Any]]:
    return await paginate_connection(
        accessor, TEAM_LIST_QUERY, None, ("teams",)
    )


async def list_team_members(
    accessor: LinearAccessor, team_id: str, limit: int | None = None
) -> list[dict[str, Any]]:
    return await paginate_connection(
        accessor,
        TEAM_MEMBERS_QUERY,
        {"teamId": team_id},
        ("team", "members"),
        limit,
    )


async def list_team_issues(
    accessor: LinearAccessor, team_id: str, limit: int | None = None
) -> list[dict[str, Any]]:
    return await paginate_connection(
        accessor,
        TEAM_ISSUES_QUERY,
        {"teamId": team_id},
        ("team", "issues"),
        limit,
    )


async def list_team_projects(
    accessor: LinearAccessor, team_id: str, limit: int | None = None
) -> list[dict[str, Any]]:
    return await paginate_connection(
        accessor,
        TEAM_PROJECTS_QUERY,
        {"teamId": team_id},
        ("team", "projects"),
        limit,
    )


async def list_team_cycles(
    accessor: LinearAccessor, team_id: str, limit: int | None = None
) -> list[dict[str, Any]]:
    return await paginate_connection(
        accessor,
        TEAM_CYCLES_QUERY,
        {"teamId": team_id},
        ("team", "cycles"),
        limit,
    )


async def list_team_labels(
    accessor: LinearAccessor, team_id: str
) -> list[dict[str, Any]]:
    return await paginate_connection(
        accessor, TEAM_LABELS_QUERY, {"teamId": team_id}, ("team", "labels")
    )


async def list_team_documents(
    accessor: LinearAccessor, team_id: str, limit: int | None = None
) -> list[dict[str, Any]]:
    return await paginate_connection(
        accessor,
        TEAM_DOCUMENTS_QUERY,
        {"teamId": team_id},
        ("documents",),
        limit,
    )


async def resolve_team(
    accessor: LinearAccessor, key_or_id: str
) -> dict[str, Any]:
    teams = await list_teams(accessor)
    for team in teams:
        if team.get("id") == key_or_id or team.get("key") == key_or_id:
            return team
    raise enoent(key_or_id)


async def get_issue(accessor: LinearAccessor, issue_id: str) -> dict[str, Any]:
    data = await graphql_request(accessor, ISSUE_QUERY, {"issueId": issue_id})
    issue: dict[str, Any] = data["issue"]
    return issue


async def list_issue_comments(
    accessor: LinearAccessor, issue_id: str
) -> list[dict[str, Any]]:
    return await paginate_connection(
        accessor,
        ISSUE_COMMENTS_QUERY,
        {"issueId": issue_id},
        ("issue", "comments"),
    )


async def resolve_issue_id(
    accessor: LinearAccessor,
    issue_id: str | None = None,
    issue_key: str | None = None,
) -> str:
    if issue_id:
        return issue_id
    if not issue_key:
        raise ValueError("issue id or issue key is required")
    team_key, _, number_str = issue_key.partition("-")
    if not team_key or not number_str.isdigit():
        raise ValueError(f"invalid issue key: {issue_key}")
    data = await graphql_request(
        accessor,
        ISSUE_LOOKUP_QUERY,
        {
            "teamKey": team_key,
            "number": float(number_str),
        },
    )
    nodes: list[dict[str, Any]] = data["issues"]["nodes"]
    if not nodes:
        raise enoent(issue_key)
    found: str = nodes[0]["id"]
    return found


async def resolve_user_id(
    accessor: LinearAccessor,
    assignee_id: str | None = None,
    assignee_email: str | None = None,
) -> str:
    if assignee_id:
        return assignee_id
    if not assignee_email:
        raise ValueError("assignee id or assignee email is required")
    data = await graphql_request(
        accessor, USER_LOOKUP_QUERY, {"email": assignee_email}
    )
    nodes: list[dict[str, Any]] = data["users"]["nodes"]
    if not nodes:
        raise enoent(assignee_email)
    found: str = nodes[0]["id"]
    return found


async def issue_create(
    accessor: LinearAccessor,
    *,
    team_id: str,
    title: str,
    description: str | None,
) -> dict[str, Any]:
    input_payload: dict[str, JsonValue] = {"title": title, "teamId": team_id}
    if description:
        input_payload["description"] = description
    data = await graphql_request(
        accessor, ISSUE_CREATE_MUTATION, {"input": input_payload}
    )
    issue = data["issueCreate"]["issue"]
    return await get_issue(accessor, issue["id"])


async def issue_update(
    accessor: LinearAccessor,
    *,
    issue_id: str,
    title: str | None,
    description: str | None,
    state_id: str | None = None,
    assignee_id: str | None = None,
    priority: int | None = None,
    project_id: str | None = None,
    label_ids: list[str] | None = None,
) -> dict[str, Any]:
    payload: dict[str, JsonValue] = {}
    if title is not None:
        payload["title"] = title
    if description is not None:
        payload["description"] = description
    if state_id is not None:
        payload["stateId"] = state_id
    if assignee_id is not None:
        payload["assigneeId"] = assignee_id
    if priority is not None:
        payload["priority"] = priority
    if project_id is not None:
        payload["projectId"] = project_id
    if label_ids is not None:
        payload["labelIds"] = list(label_ids)
    if not payload:
        raise ValueError("no updates provided")
    await graphql_request(
        accessor,
        ISSUE_UPDATE_MUTATION,
        {
            "id": issue_id,
            "input": payload,
        },
    )
    return await get_issue(accessor, issue_id)


async def comment_create(
    accessor: LinearAccessor, *, issue_id: str, body: str
) -> dict[str, Any]:
    await graphql_request(
        accessor,
        COMMENT_CREATE_MUTATION,
        {"input": {"issueId": issue_id, "body": body}},
    )
    comments = await list_issue_comments(accessor, issue_id)
    if not comments:
        raise RuntimeError("comment was created but no comments were returned")
    return comments[-1]


async def comment_update(
    accessor: LinearAccessor, *, comment_id: str, body: str
) -> dict[str, Any]:
    data = await graphql_request(
        accessor,
        COMMENT_UPDATE_MUTATION,
        {"id": comment_id, "input": {"body": body}},
    )
    comment: dict[str, Any] = data["commentUpdate"]["comment"]
    issue = comment.get("issue") or {}
    issue_id = issue.get("id")
    if issue_id:
        comments = await list_issue_comments(accessor, issue_id)
        for item in comments:
            if item.get("id") == comment_id:
                return item
    return comment


async def search_issues(
    accessor: LinearAccessor, query: str, limit: int = 50
) -> list[dict[str, Any]]:
    data = await graphql_request(
        accessor, ISSUE_SEARCH_QUERY, {"term": query, "first": limit}
    )
    search = data.get("searchIssues")
    nodes = search.get("nodes") if isinstance(search, dict) else None
    if not isinstance(nodes, list) or not all(
        isinstance(node, dict) and isinstance(node.get("id"), str)
        for node in nodes
    ):
        raise LinearAPIError("unexpected response from searchIssues")
    return nodes

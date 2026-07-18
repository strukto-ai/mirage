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

from typing import Any

import aiohttp

from mirage.resource.linear.config import LinearConfig
from mirage.resource.secrets import reveal_secret

from mirage.core.linear.queries import (  # isort: skip
    COMMENT_CREATE_MUTATION, COMMENT_UPDATE_MUTATION, ISSUE_COMMENTS_QUERY,
    ISSUE_CREATE_MUTATION, ISSUE_LOOKUP_QUERY, ISSUE_QUERY, ISSUE_SEARCH_QUERY,
    ISSUE_UPDATE_MUTATION, TEAM_CYCLES_QUERY, TEAM_ISSUES_QUERY,
    TEAM_LIST_QUERY, TEAM_MEMBERS_QUERY, TEAM_PROJECTS_QUERY,
    USER_LOOKUP_QUERY)


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


async def graphql_request(
    config: LinearConfig,
    query: str,
    variables: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload = {
        "query": query,
        "variables": variables or {},
    }
    async with aiohttp.ClientSession() as session:
        async with session.post(
                config.base_url,
                headers=linear_headers(config),
                json=payload,
        ) as resp:
            data = await resp.json()
            if resp.status >= 400:
                errors = data.get("errors") if isinstance(data, dict) else None
                message = _error_message(
                    errors) or f"Linear API error: HTTP {resp.status}"
                raise LinearAPIError(message,
                                     errors=errors,
                                     status=resp.status)
            if data.get("errors"):
                message = _error_message(data["errors"]) or "Linear API error"
                raise LinearAPIError(message, errors=data["errors"])
            return data["data"]


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
    config: LinearConfig,
    query: str,
    variables: dict[str, Any] | None,
    path: tuple[str, ...],
) -> list[dict[str, Any]]:
    merged_vars = dict(variables or {})
    merged_vars.setdefault("first", 50)
    merged_vars["after"] = None
    nodes: list[dict[str, Any]] = []
    while True:
        data = await graphql_request(config, query, merged_vars)
        cursor = data
        for key in path:
            cursor = cursor[key]
        nodes.extend(cursor["nodes"])
        page_info = cursor["pageInfo"]
        if not page_info.get("hasNextPage"):
            break
        merged_vars["after"] = page_info.get("endCursor")
    return nodes


async def list_teams(config: LinearConfig) -> list[dict[str, Any]]:
    return await paginate_connection(config, TEAM_LIST_QUERY, None,
                                     ("teams", ))


async def list_team_members(config: LinearConfig,
                            team_id: str) -> list[dict[str, Any]]:
    return await paginate_connection(
        config,
        TEAM_MEMBERS_QUERY,
        {"teamId": team_id},
        ("team", "members"),
    )


async def list_team_issues(config: LinearConfig,
                           team_id: str) -> list[dict[str, Any]]:
    return await paginate_connection(
        config,
        TEAM_ISSUES_QUERY,
        {"teamId": team_id},
        ("team", "issues"),
    )


async def list_team_projects(config: LinearConfig,
                             team_id: str) -> list[dict[str, Any]]:
    return await paginate_connection(
        config,
        TEAM_PROJECTS_QUERY,
        {"teamId": team_id},
        ("team", "projects"),
    )


async def list_team_cycles(config: LinearConfig,
                           team_id: str) -> list[dict[str, Any]]:
    return await paginate_connection(
        config,
        TEAM_CYCLES_QUERY,
        {"teamId": team_id},
        ("team", "cycles"),
    )


async def get_issue(config: LinearConfig, issue_id: str) -> dict[str, Any]:
    data = await graphql_request(config, ISSUE_QUERY, {"issueId": issue_id})
    return data["issue"]


async def list_issue_comments(config: LinearConfig,
                              issue_id: str) -> list[dict[str, Any]]:
    return await paginate_connection(
        config,
        ISSUE_COMMENTS_QUERY,
        {"issueId": issue_id},
        ("issue", "comments"),
    )


async def resolve_issue_id(
    config: LinearConfig,
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
        config,
        ISSUE_LOOKUP_QUERY,
        {
            "teamKey": team_key,
            "number": float(number_str),
        },
    )
    nodes = data["issues"]["nodes"]
    if not nodes:
        raise FileNotFoundError(issue_key)
    return nodes[0]["id"]


async def resolve_user_id(
    config: LinearConfig,
    assignee_id: str | None = None,
    assignee_email: str | None = None,
) -> str:
    if assignee_id:
        return assignee_id
    if not assignee_email:
        raise ValueError("assignee id or assignee email is required")
    data = await graphql_request(config, USER_LOOKUP_QUERY,
                                 {"email": assignee_email})
    nodes = data["users"]["nodes"]
    if not nodes:
        raise FileNotFoundError(assignee_email)
    return nodes[0]["id"]


async def issue_create(
    config: LinearConfig,
    *,
    team_id: str,
    title: str,
    description: str | None,
) -> dict[str, Any]:
    input_payload: dict[str, object] = {"title": title, "teamId": team_id}
    if description:
        input_payload["description"] = description
    data = await graphql_request(
        config,
        ISSUE_CREATE_MUTATION,
        {"input": input_payload},
    )
    issue = data["issueCreate"]["issue"]
    return await get_issue(config, issue["id"])


async def issue_update(
    config: LinearConfig,
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
    payload: dict[str, object] = {}
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
        payload["labelIds"] = label_ids
    if not payload:
        raise ValueError("no updates provided")
    await graphql_request(
        config,
        ISSUE_UPDATE_MUTATION,
        {
            "id": issue_id,
            "input": payload,
        },
    )
    return await get_issue(config, issue_id)


async def comment_create(
    config: LinearConfig,
    *,
    issue_id: str,
    body: str,
) -> dict[str, Any]:
    await graphql_request(
        config,
        COMMENT_CREATE_MUTATION,
        {"input": {
            "issueId": issue_id,
            "body": body
        }},
    )
    comments = await list_issue_comments(config, issue_id)
    if not comments:
        raise RuntimeError("comment was created but no comments were returned")
    return comments[-1]


async def comment_update(
    config: LinearConfig,
    *,
    comment_id: str,
    body: str,
) -> dict[str, Any]:
    data = await graphql_request(
        config,
        COMMENT_UPDATE_MUTATION,
        {
            "id": comment_id,
            "input": {
                "body": body
            }
        },
    )
    comment = data["commentUpdate"]["comment"]
    issue = comment.get("issue") or {}
    issue_id = issue.get("id")
    if issue_id:
        comments = await list_issue_comments(config, issue_id)
        for item in comments:
            if item.get("id") == comment_id:
                return item
    return comment


async def search_issues(
    config: LinearConfig,
    query: str,
    limit: int = 50,
) -> list[dict[str, Any]]:
    data = await graphql_request(
        config,
        ISSUE_SEARCH_QUERY,
        {
            "term": query,
            "first": limit
        },
    )
    return data.get("searchIssues", {}).get("nodes", [])

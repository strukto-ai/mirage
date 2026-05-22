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

import aiohttp

from mirage.resource.linear.config import LinearConfig
from mirage.resource.secrets import reveal_secret


class LinearAPIError(RuntimeError):

    def __init__(
        self,
        message: str,
        *,
        errors: list[dict] | None = None,
        status: int | None = None,
    ) -> None:
        super().__init__(message)
        self.errors = errors or []
        self.status = status


def linear_headers(config: LinearConfig) -> dict[str, str]:
    return {
        "Authorization": reveal_secret(config.api_key),
        "Content-Type": "application/json",
    }


async def graphql_request(
    config: LinearConfig,
    query: str,
    variables: dict | None = None,
) -> dict:
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


def _error_message(errors: list[dict] | None) -> str | None:
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
    variables: dict | None,
    path: tuple[str, ...],
) -> list[dict]:
    merged_vars = dict(variables or {})
    merged_vars.setdefault("first", 50)
    merged_vars["after"] = None
    nodes: list[dict] = []
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


TEAM_LIST_QUERY = """
query Teams($first: Int!, $after: String) {
  teams(first: $first, after: $after) {
    nodes {
      id
      key
      name
      description
      timezone
      updatedAt
      states {
        nodes {
          id
          name
          type
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
"""

TEAM_MEMBERS_QUERY = """
query TeamMembers($teamId: String!, $first: Int!, $after: String) {
  team(id: $teamId) {
    members(first: $first, after: $after) {
      nodes {
        id
        name
        displayName
        email
        active
        admin
        url
        updatedAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
"""

TEAM_ISSUES_QUERY = """
query TeamIssues($teamId: String!, $first: Int!, $after: String) {
  team(id: $teamId) {
    issues(first: $first, after: $after) {
      nodes {
        id
        identifier
        title
        description
        priority
        url
        createdAt
        updatedAt
        team {
          id
          key
          name
        }
        state {
          id
          name
        }
        project {
          id
          name
        }
        cycle {
          id
          name
          number
        }
        assignee {
          id
          name
          email
        }
        creator {
          id
          name
          email
        }
        labels {
          nodes {
            id
            name
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
"""

TEAM_PROJECTS_QUERY = """
query TeamProjects($teamId: String!, $first: Int!, $after: String) {
  team(id: $teamId) {
    projects(first: $first, after: $after) {
      nodes {
        id
        name
        description
        status {
          type
        }
        url
        updatedAt
        lead {
          id
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
"""

TEAM_CYCLES_QUERY = """
query TeamCycles($teamId: String!, $first: Int!, $after: String) {
  team(id: $teamId) {
    cycles(first: $first, after: $after) {
      nodes {
        id
        name
        number
        startsAt
        endsAt
        updatedAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
"""

ISSUE_QUERY = """
query Issue($issueId: String!) {
  issue(id: $issueId) {
    id
    identifier
    title
    description
    priority
    url
    createdAt
    updatedAt
    team {
      id
      key
      name
    }
    state {
      id
      name
    }
    project {
      id
      name
    }
    cycle {
      id
      name
      number
    }
    assignee {
      id
      name
      email
    }
    creator {
      id
      name
      email
    }
    labels {
      nodes {
        id
        name
      }
    }
  }
}
"""

ISSUE_COMMENTS_QUERY = """
query IssueComments($issueId: String!, $first: Int!, $after: String) {
  issue(id: $issueId) {
    comments(first: $first, after: $after) {
      nodes {
        id
        body
        url
        createdAt
        updatedAt
        user {
          id
          name
          displayName
          email
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
"""

ISSUE_LOOKUP_QUERY = """
query IssueLookup($teamKey: String!, $number: Float!) {
  issues(
    filter: {
      team: { key: { eq: $teamKey } }
      number: { eq: $number }
    }
    first: 1
  ) {
    nodes {
      id
      identifier
    }
  }
}
"""

USER_LOOKUP_QUERY = """
query UserLookup($email: String!) {
  users(filter: { email: { eq: $email } }, first: 1) {
    nodes {
      id
      email
      name
    }
  }
}
"""

ISSUE_CREATE_MUTATION = """
mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue {
      id
      identifier
    }
  }
}
"""

ISSUE_UPDATE_MUTATION = """
mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue {
      id
      identifier
    }
  }
}
"""

COMMENT_CREATE_MUTATION = """
mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment {
      id
      issue {
        id
        identifier
      }
    }
  }
}
"""

COMMENT_UPDATE_MUTATION = """
mutation CommentUpdate($id: String!, $input: CommentUpdateInput!) {
  commentUpdate(id: $id, input: $input) {
    success
    comment {
      id
      issue {
        id
        identifier
      }
    }
  }
}
"""


async def list_teams(config: LinearConfig) -> list[dict]:
    return await paginate_connection(config, TEAM_LIST_QUERY, None,
                                     ("teams", ))


async def list_team_members(config: LinearConfig, team_id: str) -> list[dict]:
    return await paginate_connection(
        config,
        TEAM_MEMBERS_QUERY,
        {"teamId": team_id},
        ("team", "members"),
    )


async def list_team_issues(config: LinearConfig, team_id: str) -> list[dict]:
    return await paginate_connection(
        config,
        TEAM_ISSUES_QUERY,
        {"teamId": team_id},
        ("team", "issues"),
    )


async def list_team_projects(config: LinearConfig, team_id: str) -> list[dict]:
    return await paginate_connection(
        config,
        TEAM_PROJECTS_QUERY,
        {"teamId": team_id},
        ("team", "projects"),
    )


async def list_team_cycles(config: LinearConfig, team_id: str) -> list[dict]:
    return await paginate_connection(
        config,
        TEAM_CYCLES_QUERY,
        {"teamId": team_id},
        ("team", "cycles"),
    )


async def get_issue(config: LinearConfig, issue_id: str) -> dict:
    data = await graphql_request(config, ISSUE_QUERY, {"issueId": issue_id})
    return data["issue"]


async def list_issue_comments(config: LinearConfig,
                              issue_id: str) -> list[dict]:
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
) -> dict:
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
) -> dict:
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
) -> dict:
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
) -> dict:
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


ISSUE_SEARCH_QUERY = """
query IssueSearch($term: String!, $first: Int) {
  searchIssues(term: $term, first: $first) {
    nodes {
      id
      identifier
      title
      state { id name }
      assignee { id displayName email }
      url
    }
  }
}
"""


async def search_issues(
    config: LinearConfig,
    query: str,
    limit: int = 50,
) -> list[dict]:
    data = await graphql_request(
        config,
        ISSUE_SEARCH_QUERY,
        {
            "term": query,
            "first": limit
        },
    )
    return data.get("searchIssues", {}).get("nodes", [])

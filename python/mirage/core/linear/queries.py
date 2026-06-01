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

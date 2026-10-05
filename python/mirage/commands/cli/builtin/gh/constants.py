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

import re

from mirage.commands.cli.builtin.gh.types import RepoEditField

SEARCH_FLAGS = {
    "issues": [
        "app",
        "archived",
        "assignee",
        "author",
        "closed",
        "commenter",
        "comments",
        "created",
        "interactions",
        "involves",
        "label",
        "language",
        "locked",
        "match",
        "mentions",
        "milestone",
        "no-assignee",
        "no-label",
        "no-milestone",
        "no-project",
        "owner",
        "project",
        "reactions",
        "repo",
        "state",
        "team-mentions",
        "updated",
        "visibility",
        "include-prs",
    ],
    "prs": [
        "app",
        "archived",
        "assignee",
        "author",
        "closed",
        "commenter",
        "comments",
        "created",
        "interactions",
        "involves",
        "label",
        "language",
        "locked",
        "match",
        "mentions",
        "milestone",
        "no-assignee",
        "no-label",
        "no-milestone",
        "no-project",
        "owner",
        "project",
        "reactions",
        "repo",
        "state",
        "team-mentions",
        "updated",
        "visibility",
        "base",
        "checks",
        "draft",
        "head",
        "merged",
        "merged-at",
        "review",
        "review-requested",
        "reviewed-by",
    ],
    "repos": [
        "archived",
        "created",
        "followers",
        "forks",
        "good-first-issues",
        "help-wanted-issues",
        "include-forks",
        "language",
        "license",
        "match",
        "number-topics",
        "owner",
        "size",
        "stars",
        "topic",
        "updated",
        "visibility",
    ],
    "code": [
        "extension",
        "filename",
        "language",
        "match",
        "owner",
        "repo",
        "size",
    ],
    "commits": [
        "author",
        "author-date",
        "author-email",
        "author-name",
        "committer",
        "committer-date",
        "committer-email",
        "committer-name",
        "hash",
        "merge",
        "owner",
        "parent",
        "repo",
        "tree",
        "visibility",
    ],
}
SEARCH_MULTIPLE = [
    "label",
    "match",
    "owner",
    "repo",
    "visibility",
    "license",
    "topic",
]
# The values a gh boolean flag takes after `=`.
BOOLEAN = ("true", "false")
SEARCH_BOOLEAN = [
    "archived",
    "draft",
    "merge",
    "locked",
    "merged",
    "include-prs",
    "no-assignee",
    "no-label",
    "no-milestone",
    "no-project",
]
SEARCH_ALIASES = {
    "owner": "user",
    "match": "in",
    "visibility": "is",
    "team-mentions": "team",
    "checks": "status",
    "merged-at": "merged",
    "number-topics": "topics",
    "include-forks": "fork",
}
SEARCH_SORTS = {
    "issues": [
        "comments",
        "created",
        "interactions",
        "reactions",
        "reactions-+1",
        "reactions--1",
        "reactions-heart",
        "reactions-smile",
        "reactions-tada",
        "reactions-thinking_face",
        "updated",
    ],
    "prs": [
        "comments",
        "created",
        "interactions",
        "reactions",
        "reactions-+1",
        "reactions--1",
        "reactions-heart",
        "reactions-smile",
        "reactions-tada",
        "reactions-thinking_face",
        "updated",
    ],
    "repos": ["forks", "help-wanted-issues", "stars", "updated"],
    "commits": ["author-date", "committer-date"],
}
SEARCH_FIELDS = {
    "issues": [
        "assignees",
        "author",
        "authorAssociation",
        "body",
        "closedAt",
        "commentsCount",
        "createdAt",
        "id",
        "isLocked",
        "isPullRequest",
        "labels",
        "number",
        "repository",
        "state",
        "title",
        "updatedAt",
        "url",
    ],
    "prs": [
        "assignees",
        "author",
        "authorAssociation",
        "body",
        "closedAt",
        "commentsCount",
        "createdAt",
        "id",
        "isLocked",
        "isPullRequest",
        "labels",
        "number",
        "repository",
        "state",
        "title",
        "updatedAt",
        "url",
        "isDraft",
    ],
    "repos": [
        "createdAt",
        "defaultBranch",
        "description",
        "forksCount",
        "fullName",
        "hasDownloads",
        "hasIssues",
        "hasPages",
        "hasProjects",
        "hasWiki",
        "homepage",
        "id",
        "isArchived",
        "isDisabled",
        "isFork",
        "isPrivate",
        "language",
        "license",
        "name",
        "openIssuesCount",
        "owner",
        "pushedAt",
        "size",
        "stargazersCount",
        "updatedAt",
        "url",
        "visibility",
        "watchersCount",
    ],
    "code": ["path", "repository", "sha", "textMatches", "url"],
    "commits": [
        "author",
        "commit",
        "committer",
        "sha",
        "id",
        "parents",
        "repository",
        "url",
    ],
}
SEARCH_SHAPES = {
    "Repository": [
        ["createdAt", "created_at", "time.Time"],
        ["defaultBranch", "default_branch", "string"],
        ["description", "description", "string"],
        ["forksCount", "forks_count", "int"],
        ["fullName", "full_name", "string"],
        ["hasDownloads", "has_downloads", "bool"],
        ["hasIssues", "has_issues", "bool"],
        ["hasPages", "has_pages", "bool"],
        ["hasProjects", "has_projects", "bool"],
        ["hasWiki", "has_wiki", "bool"],
        ["homepage", "homepage", "string"],
        ["id", "node_id", "string"],
        ["isArchived", "archived", "bool"],
        ["isDisabled", "disabled", "bool"],
        ["isFork", "fork", "bool"],
        ["isPrivate", "private", "bool"],
        ["language", "language", "string"],
        ["license", "license", "License"],
        ["masterBranch", "master_branch", "string"],
        ["name", "name", "string"],
        ["openIssuesCount", "open_issues_count", "int"],
        ["owner", "owner", "User"],
        ["pushedAt", "pushed_at", "time.Time"],
        ["size", "size", "int"],
        ["stargazersCount", "stargazers_count", "int"],
        ["url", "html_url", "string"],
        ["updatedAt", "updated_at", "time.Time"],
        ["visibility", "visibility", "string"],
        ["watchersCount", "watchers_count", "int"],
    ],
    "User": [
        ["gravatarID", "gravatar_id", "string"],
        ["id", "node_id", "string"],
        ["login", "login", "string"],
        ["siteAdmin", "site_admin", "bool"],
        ["type", "type", "string"],
        ["url", "html_url", "string"],
    ],
    "CommitInfo": [
        ["author", "author", "CommitUser"],
        ["commentCount", "comment_count", "int"],
        ["committer", "committer", "CommitUser"],
        ["message", "message", "string"],
        ["tree", "tree", "Tree"],
    ],
    "CommitUser": [
        ["date", "date", "time.Time"],
        ["email", "email", "string"],
        ["name", "name", "string"],
    ],
    "Tree": [["sha", "sha", "string"]],
    "Parent": [["sha", "sha", "string"], ["url", "html_url", "string"]],
    "License": [
        ["key", "key", "string"],
        ["name", "name", "string"],
        ["url", "url", "string"],
    ],
    "Label": [
        ["color", "color", "string"],
        ["description", "description", "string"],
        ["id", "node_id", "string"],
        ["name", "name", "string"],
    ],
    "Issue": [
        ["assignees", "assignees", "[]User"],
        ["author", "user", "User"],
        ["authorAssociation", "author_association", "string"],
        ["body", "body", "string"],
        ["closedAt", "closed_at", "time.Time"],
        ["commentsCount", "comments", "int"],
        ["createdAt", "created_at", "time.Time"],
        ["id", "node_id", "string"],
        ["labels", "labels", "[]Label"],
        ["isDraft", "draft", "*bool"],
        ["isLocked", "locked", "bool"],
        ["number", "number", "int"],
        ["pullRequest", "pull_request", "PullRequest"],
        ["repositoryURL", "repository_url", "string"],
        ["stateInternal", "state", "string"],
        ["stateReason", "state_reason", "string"],
        ["title", "title", "string"],
        ["url", "html_url", "string"],
        ["updatedAt", "updated_at", "time.Time"],
    ],
    "Code": [
        ["name", "name", "string"],
        ["path", "path", "string"],
        ["repository", "repository", "Repository"],
        ["sha", "sha", "string"],
        ["textMatches", "text_matches", "[]TextMatch"],
        ["url", "html_url", "string"],
    ],
    "Commit": [
        ["author", "author", "User"],
        ["committer", "committer", "User"],
        ["id", "node_id", "string"],
        ["info", "commit", "CommitInfo"],
        ["parents", "parents", "[]Parent"],
        ["repo", "repository", "Repository"],
        ["sha", "sha", "string"],
        ["url", "html_url", "string"],
    ],
}

# gh 2.85's `diffHeaderRegexp`, the `diff --git` header `--name-only`
# reads a name from, with Go's `\s` and `.` spelled out so no host widens them.
DIFF_HEADER = re.compile(
    r'(?:^|\n)diff[\t\n\f\r ]--git[^\n]*[\t\n\f\r ](["]?)b/([^\n]*)'
)

TEMPLATE_TOKEN = re.compile(r'"(?:\\.|[^"\\])*"|`[^`]*`|[^\s|]+|\|')
TEMPLATE_ACTION = re.compile(r"{{(-?)\s*(.*?)\s*(-?)}}", re.S)
TEMPLATE_DECLARATION = re.compile(
    r"(\$\w+)\s*(?:,\s*(\$\w+)\s*)?(:?=)\s*(.*)", re.S
)

# The builtins gojq writes in jq, so each fails through `error` itself,
# where jq 1.8.2's fail as builtins do: jq's message for each, and the one
# gojq raises (gojq v0.12.17 builtin.jq).
GOJQ_RAISED = {
    "limit doesn't support negative count": "limit doesn't support negative count",
    "skip doesn't support negative count": "skip doesn't support negative count",
    "nth doesn't support negative indices": "nth doesn't support negative index",
}

# The reason phrase `gh api -i` prints after a status code: Go's
# http.StatusText, which is what gh reports for a response that carries none.
HTTP_REASONS: dict[int, str] = {
    100: "Continue",
    101: "Switching Protocols",
    102: "Processing",
    103: "Early Hints",
    200: "OK",
    201: "Created",
    202: "Accepted",
    203: "Non-Authoritative Information",
    204: "No Content",
    205: "Reset Content",
    206: "Partial Content",
    207: "Multi-Status",
    208: "Already Reported",
    226: "IM Used",
    300: "Multiple Choices",
    301: "Moved Permanently",
    302: "Found",
    303: "See Other",
    304: "Not Modified",
    305: "Use Proxy",
    307: "Temporary Redirect",
    308: "Permanent Redirect",
    400: "Bad Request",
    401: "Unauthorized",
    402: "Payment Required",
    403: "Forbidden",
    404: "Not Found",
    405: "Method Not Allowed",
    406: "Not Acceptable",
    407: "Proxy Authentication Required",
    408: "Request Timeout",
    409: "Conflict",
    410: "Gone",
    411: "Length Required",
    412: "Precondition Failed",
    413: "Request Entity Too Large",
    414: "Request URI Too Long",
    415: "Unsupported Media Type",
    416: "Requested Range Not Satisfiable",
    417: "Expectation Failed",
    418: "I'm a teapot",
    421: "Misdirected Request",
    422: "Unprocessable Entity",
    423: "Locked",
    424: "Failed Dependency",
    425: "Too Early",
    426: "Upgrade Required",
    428: "Precondition Required",
    429: "Too Many Requests",
    431: "Request Header Fields Too Large",
    451: "Unavailable For Legal Reasons",
    500: "Internal Server Error",
    501: "Not Implemented",
    502: "Bad Gateway",
    503: "Service Unavailable",
    504: "Gateway Timeout",
    505: "HTTP Version Not Supported",
    506: "Variant Also Negotiates",
    507: "Insufficient Storage",
    508: "Loop Detected",
    510: "Not Extended",
    511: "Network Authentication Required",
}

REPO_EDIT_FIELDS = (
    RepoEditField(
        flag="--description",
        field="description",
        kind="value",
        description="Description of the repository",
        short="-d",
    ),
    RepoEditField(
        flag="--homepage",
        field="homepage",
        kind="value",
        description="Repository home page URL",
        short="-h",
    ),
    RepoEditField(
        flag="--default-branch",
        field="default_branch",
        kind="value",
        description="Set the default branch name for the repository",
    ),
    RepoEditField(
        flag="--visibility",
        field="visibility",
        kind="value",
        description=(
            "Change the visibility of the repository to "
            "{public,private,internal}"
        ),
        choices=("public", "private", "internal"),
    ),
    RepoEditField(
        flag="--template",
        field="is_template",
        kind="toggle",
        description="Make the repository available as a template repository",
    ),
    RepoEditField(
        flag="--enable-issues",
        field="has_issues",
        kind="toggle",
        description="Enable issues in the repository",
    ),
    RepoEditField(
        flag="--enable-projects",
        field="has_projects",
        kind="toggle",
        description="Enable projects in the repository",
    ),
    RepoEditField(
        flag="--enable-wiki",
        field="has_wiki",
        kind="toggle",
        description="Enable wiki in the repository",
    ),
    RepoEditField(
        flag="--enable-discussions",
        field="has_discussions",
        kind="toggle",
        description="Enable discussions in the repository",
    ),
    RepoEditField(
        flag="--enable-merge-commit",
        field="allow_merge_commit",
        kind="toggle",
        description="Enable merging pull requests via merge commit",
    ),
    RepoEditField(
        flag="--enable-squash-merge",
        field="allow_squash_merge",
        kind="toggle",
        description="Enable merging pull requests via squashed commit",
    ),
    RepoEditField(
        flag="--enable-rebase-merge",
        field="allow_rebase_merge",
        kind="toggle",
        description="Enable merging pull requests via rebase",
    ),
    RepoEditField(
        flag="--enable-auto-merge",
        field="allow_auto_merge",
        kind="toggle",
        description="Enable auto-merge functionality",
    ),
    RepoEditField(
        flag="--enable-advanced-security",
        field="advanced_security",
        kind="security",
        description="Enable advanced security in the repository",
    ),
    RepoEditField(
        flag="--enable-secret-scanning",
        field="secret_scanning",
        kind="security",
        description="Enable secret scanning in the repository",
    ),
    RepoEditField(
        flag="--enable-secret-scanning-push-protection",
        field="secret_scanning_push_protection",
        kind="security",
        description="Enable secret scanning push protection in the repository",
    ),
    RepoEditField(
        flag="--delete-branch-on-merge",
        field="delete_branch_on_merge",
        kind="toggle",
        description="Delete head branch when pull requests are merged",
    ),
    RepoEditField(
        flag="--allow-forking",
        field="allow_forking",
        kind="toggle",
        description="Allow forking of an organization repository",
    ),
    RepoEditField(
        flag="--allow-update-branch",
        field="allow_update_branch",
        kind="toggle",
        description="Allow a pull request head branch that is behind its "
        "base branch to be updated",
    ),
)

# The help topics `gh help` answers, in this gh's own terms. gh's other
# topics (formatting, mintty, reference, telemetry) describe a terminal, a
# config directory or a manual a workspace does not have, so they are
# unknown here.
HELP_TOPICS: dict[str, str] = {
    "environment": (
        "This gh reads no environment variables: `GH_TOKEN`, "
        "`GITHUB_TOKEN`, `GH_HOST`, `GH_REPO`\n"
        "and the rest of gh's list have no effect here.\n\n"
        "The token, the API base URL, the default repository and the "
        "default branch come from the\n"
        "workspace's gh configuration: `token`, `base_url`, `repo` and "
        "`branch`.\n"
    ),
    "exit-codes": (
        "gh follows normal conventions regarding exit codes.\n\n"
        "- If a command completes successfully, the exit code will be 0\n\n"
        "- If a command fails for any reason, the exit code will be 1\n\n"
        "- If the command line is refused before the command runs, such as "
        "for an unknown flag,\n"
        "  the exit code will be 2\n"
    ),
}

GITHUB_HOST = "github.com"
CONNECT_HINT = "check your internet connection or https://githubstatus.com"

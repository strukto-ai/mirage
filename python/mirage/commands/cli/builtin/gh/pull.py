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

from dataclasses import replace
from typing import Any

from mirage.commands.cli.builtin.gh.accessor import (
    body_value,
    camel,
    gh_bool,
    json_fields,
    list_limit,
    repo_for,
    repo_number,
    text_out,
    typed_out,
)
from mirage.commands.cli.builtin.gh.constants import DIFF_HEADER
from mirage.commands.cli.builtin.gh.fields import (
    LOGIN,
    SHARED_FIELDS,
    Field,
    Node,
    Pages,
    exported_node,
    nodes,
    nodes_of,
    paged,
    plain,
    read_rest,
    record,
    references,
    selection,
)
from mirage.commands.cli.builtin.gh.issue import comments_for, comments_text
from mirage.commands.cli.builtin.gh.shape import (
    OrNull,
    exported,
    pointer,
    struct,
)
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.spec.flag_view import FlagView
from mirage.core.github.config import GhConfig
from mirage.core.github.pull import (
    PullListFilter,
    comment_pull,
    create_pull,
    diff_pull,
    edit_pull,
    get_pull,
    list_pull_request_fields,
    list_pulls,
    merge_pull,
    pull_checks,
    pull_request_fields,
)
from mirage.core.github.repo import RepoRef
from mirage.io.types import ByteSource, IOResult
from mirage.types import JsonValue

_OID = pointer(("oid", "string"))
# Its url is omitempty, and gh never asks for it, so it never prints.
_REVIEW = struct(
    ("id", "string"),
    ("author", LOGIN),
    ("authorAssociation", "string"),
    ("body", "string"),
    ("submittedAt", "raw"),
    ("includesCreatedEdit", "bool"),
    ("reactionGroups", "reactions"),
    ("state", "string"),
    ("commit", struct(("oid", "string"))),
)
_FILE = struct(("path", "string"), ("additions", "int"), ("deletions", "int"))


def _text(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _reviews(after: str) -> str:
    return (
        f"reviews(first: 100{after}) {{nodes {{id,author{{login}},"
        "authorAssociation,submittedAt,body,state,commit{oid},"
        "reactionGroups{content,users{totalCount}}}"
        "pageInfo{hasNextPage,endCursor}totalCount}"
    )


def _checks(after: str) -> str:
    return (
        "statusCheckRollup: commits(last: 1) {nodes {commit "
        f"{{statusCheckRollup {{contexts(first:100{after}) {{nodes "
        "{__typename...on StatusContext {context,state,targetUrl,"
        "createdAt,description},...on CheckRun {name,checkSuite"
        "{workflowRun{workflow{name}}},status,conclusion,startedAt,"
        "completedAt,detailsUrl}},pageInfo{hasNextPage,endCursor}}}}}}"
    )


def _contexts(node: Node) -> Node:
    """The context connection of the one commit a status rollup reads.

    Args:
        node (Node): the pull request answer.
    """
    commits = nodes_of(node.get("statusCheckRollup"))
    commit = record(record(commits[0] if commits else None).get("commit"))
    return record(record(commit.get("statusCheckRollup")).get("contexts"))


def _commits_of(node: Node) -> list[Any]:
    rows: list[Any] = []
    for item in nodes_of(node.get("commits")):
        commit = record(record(item).get("commit"))
        authors = []
        for author in nodes_of(commit.get("authors")):
            row = record(author)
            user = record(row.get("user"))
            authors.append(
                {
                    "email": exported(row.get("email"), "string"),
                    "id": exported(user.get("id"), "string"),
                    "login": exported(user.get("login"), "string"),
                    "name": exported(row.get("name"), "string"),
                }
            )
        rows.append(
            {
                "authoredDate": exported(commit.get("authoredDate"), "time"),
                "authors": authors,
                "committedDate": exported(commit.get("committedDate"), "time"),
                "messageBody": exported(commit.get("messageBody"), "string"),
                "messageHeadline": exported(
                    commit.get("messageHeadline"), "string"
                ),
                "oid": exported(commit.get("oid"), "string"),
            }
        )
    return rows


def _checks_of(node: Node) -> list[Any] | None:
    """gh's status rollup: null with no commit behind it, and an empty
    list for a commit that carries no rollup, since gh builds that list
    before reading it.

    Args:
        node (Node): the pull request answer.
    """
    if not nodes_of(node.get("statusCheckRollup")):
        return None
    rows: list[Any] = []
    for item in nodes_of(_contexts(node)):
        row = record(item)
        if row.get("__typename") == "CheckRun":
            workflow = record(
                record(record(row.get("checkSuite")).get("workflowRun")).get(
                    "workflow"
                )
            )
            rows.append(
                {
                    "__typename": "CheckRun",
                    "completedAt": exported(row.get("completedAt"), "time"),
                    "conclusion": exported(row.get("conclusion"), "string"),
                    "detailsUrl": exported(row.get("detailsUrl"), "string"),
                    "name": exported(row.get("name"), "string"),
                    "startedAt": exported(row.get("startedAt"), "time"),
                    "status": exported(row.get("status"), "string"),
                    "workflowName": exported(workflow.get("name"), "string"),
                }
            )
        else:
            rows.append(
                {
                    "__typename": exported(row.get("__typename"), "string"),
                    "context": exported(row.get("context"), "string"),
                    "startedAt": exported(row.get("createdAt"), "time"),
                    "state": exported(row.get("state"), "string"),
                    "targetUrl": exported(row.get("targetUrl"), "string"),
                }
            )
    return rows


def _requests_of(node: Node) -> list[Any]:
    """gh's review requests: users and teams only, a team as org/slug.

    Args:
        node (Node): the pull request answer.
    """
    rows: list[Any] = []
    for item in nodes_of(node.get("reviewRequests")):
        reviewer = record(record(item).get("requestedReviewer"))
        if reviewer.get("__typename") == "User":
            rows.append(
                {
                    "__typename": "User",
                    "login": exported(reviewer.get("login"), "string"),
                }
            )
        elif reviewer.get("__typename") == "Team":
            org = _text(record(reviewer.get("organization")).get("login"))
            rows.append(
                {
                    "__typename": "Team",
                    "name": exported(reviewer.get("name"), "string"),
                    "slug": f"{org}/{_text(reviewer.get('slug'))}",
                }
            )
    return rows


# Every field `gh pr view --json` and `gh pr list --json` accept in gh
# 2.85: the ones issues share, and the ones only a pull request has.
# `pr view` never asks github.com for `projectCards`, which is gone
# there, so the field prints null.
PULL_FIELD_TABLE: dict[str, Field] = dict(
    [
        *(
            (name, replace(spec, view="never"))
            if name == "projectCards"
            else (name, spec)
            for name, spec in SHARED_FIELDS
        ),
        plain("additions", "int"),
        plain(
            "autoMergeRequest",
            pointer(
                ("authorEmail", "raw"),
                ("commitBody", "raw"),
                ("commitHeadline", "raw"),
                ("mergeMethod", "string"),
                ("enabledAt", "time"),
                ("enabledBy", "author"),
            ),
            "autoMergeRequest {authorEmail,commitBody,commitHeadline,"
            "mergeMethod,enabledAt,enabledBy{login,...on User{id,name}}}",
        ),
        plain("baseRefName", "string"),
        plain("baseRefOid", "string"),
        plain("changedFiles", "int"),
        references("closingIssuesReferences"),
        (
            "commits",
            Field(
                "commits(first: 100) {nodes {commit {authors(first:100) {nodes "
                "{name,email,user{id,login}}},messageHeadline,messageBody,oid,"
                "committedDate,authoredDate}}}",
                _commits_of,
            ),
        ),
        plain("deletions", "int"),
        nodes(
            "files",
            "files(first: 100) {nodes {additions,deletions,path}}",
            _FILE,
        ),
        plain("fullDatabaseId", "string"),
        plain("headRefName", "string"),
        plain("headRefOid", "string"),
        plain(
            "headRepository",
            pointer(
                ("id", "string"),
                ("name", "string"),
                ("nameWithOwner", "string"),
            ),
            "headRepository{id,name}",
        ),
        plain(
            "headRepositoryOwner",
            "owner",
            "headRepositoryOwner{id,login,...on User{name}}",
        ),
        plain("isCrossRepository", "bool"),
        plain("isDraft", "bool"),
        nodes(
            "latestReviews",
            "latestReviews(first: 100) {nodes {author{login},"
            "authorAssociation,submittedAt,body,state}}",
            _REVIEW,
        ),
        plain("maintainerCanModify", "bool"),
        plain("mergeCommit", _OID, "mergeCommit{oid}"),
        plain("mergeStateStatus", "string"),
        plain("mergeable", "string"),
        plain("mergedAt", "raw"),
        plain(
            "mergedBy", OrNull("author"), "mergedBy{login,...on User{id,name}}"
        ),
        plain("potentialMergeCommit", _OID, "potentialMergeCommit{oid}"),
        plain("reviewDecision", "string"),
        (
            "reviewRequests",
            Field(
                "reviewRequests(first: 100) {nodes {requestedReviewer {__typename,"
                "...on User{login},...on Team{organization{login}name,slug}}}}",
                _requests_of,
            ),
        ),
        nodes("reviews", _reviews(""), _REVIEW, paged("reviews", _reviews)),
        (
            "statusCheckRollup",
            Field(_checks(""), _checks_of, pages=Pages(_checks, _contexts)),
        ),
    ]
)

PR_FIELDS = tuple(PULL_FIELD_TABLE)

# The --state spellings as the pull request states gh lists for each.
_STATES = {
    "open": ("OPEN",),
    "closed": ("CLOSED", "MERGED"),
    "merged": ("MERGED",),
    "all": ("OPEN", "CLOSED", "MERGED"),
}


async def _viewed_pull(
    config: GhConfig, ref: RepoRef, number: int, fields: list[str]
) -> Node:
    """One pull request as ``gh pr view --json`` reads it: the fields
    asked for in one query, plus the ``id`` and ``number`` gh adds for its
    own follow-ups, every connection it pages read to its end, and
    project items in a query of their own. A line that asks for
    ``number`` alone is answered from the line itself, which is gh's own
    shortcut.

    Args:
        config (GhConfig): the install's configuration.
        ref (RepoRef): the repository.
        number (int): the pull request.
        fields (list[str]): the ``--json`` fields.
    """
    if all(field == "number" for field in fields):
        return {"number": number}
    node = await pull_request_fields(
        config,
        ref,
        number,
        selection(PULL_FIELD_TABLE, [*fields, "id", "number"], True),
    )

    async def fetch(select: str, cursor: str | None) -> Node:
        return await pull_request_fields(config, ref, number, select, cursor)

    return await read_rest(PULL_FIELD_TABLE, node, fields, fetch)


CHECK_FIELDS = (
    "bucket",
    "completedAt",
    "description",
    "event",
    "link",
    "name",
    "startedAt",
    "state",
    "workflow",
)
BUCKETS = {
    "success": "pass",
    "neutral": "skipping",
    "skipped": "skipping",
    "action_required": "fail",
    "error": "fail",
    "failure": "fail",
    "timed_out": "fail",
    "cancelled": "cancel",
}


def _pull(value: JsonValue) -> dict[str, Any]:
    row = camel(value)
    result = row if isinstance(row, dict) else {}
    base = result.pop("base", None)
    head = result.pop("head", None)
    if isinstance(base, dict):
        result["baseRefName"] = base.get("ref")
    if isinstance(head, dict):
        result["headRefName"] = head.get("ref")
        result["headRefOid"] = head.get("sha")
    if "draft" in result:
        result["isDraft"] = result.pop("draft")
    result["closed"] = str(result.get("state", "")).lower() == "closed"
    return result


def _list_text(rows: list[dict[str, Any]]) -> str:
    return "".join(
        f"{row.get('number', '')}\t"
        f"{str(row.get('state', '')).upper()}\t"
        f"{row.get('title', '')}\t"
        f"{row.get('headRefName', '')}\n"
        for row in rows
    )


def _view_text(row: dict[str, Any]) -> str:
    author = row.get("author")
    login = author.get("login", "") if isinstance(author, dict) else ""
    return (
        f"title:\t{row.get('title', '')}\n"
        f"state:\t{str(row.get('state', '')).upper()}\n"
        f"author:\t{login}\nbase:\t{row.get('baseRefName', '')}\n"
        f"head:\t{row.get('headRefName', '')}\n--\n"
        f"{row.get('body', '')}\n"
    )


def _target(inv: CLIInvocation[GhConfig], fl: FlagView) -> tuple[RepoRef, int]:
    return repo_number(
        inv, fl, inv.texts[0] if inv.texts else None, "pull request", "pull"
    )


async def list_cmd(
    inv: CLIInvocation[GhConfig],
) -> tuple[ByteSource | None, IOResult]:
    """``gh pr list``. With ``--json`` it asks GraphQL for exactly the
    fields named, the way gh's PullRequestList does, so every field gh
    accepts is answered in gh's own shape; the text view reads the REST
    listing.

    Args:
        inv (CLIInvocation[GhConfig]): the parsed invocation.
    """
    fl = FlagView(inv.flags)
    wanted = fl.as_str("state") or "open"
    fields = json_fields(fl, PR_FIELDS)
    if fields is not None:
        answers = await list_pull_request_fields(
            inv.config,
            repo_for(inv, fl),
            PullListFilter(
                _STATES.get(wanted, ("OPEN",)),
                fl.as_str("base"),
                fl.as_str("head"),
            ),
            list_limit(fl, 30),
            selection(PULL_FIELD_TABLE, fields, False),
        )
        return await typed_out(
            [
                exported_node(PULL_FIELD_TABLE, node, fields)
                for node in answers
            ],
            fl,
            "",
            PR_FIELDS,
        )
    params: dict[str, str] = {
        "state": "closed" if wanted == "merged" else wanted
    }
    for name in ("base", "head"):
        value = fl.as_str(name)
        if value:
            params[name] = value
    include = (
        (lambda row: row.get("merged_at") is not None)
        if wanted == "merged"
        else None
    )
    values = await list_pulls(
        inv.config,
        repo_for(inv, fl),
        params,
        list_limit(fl, 30),
        include=include,
    )
    rows = [_pull(value) for value in values]
    return await typed_out(rows, fl, _list_text(rows), PR_FIELDS)


async def view_cmd(
    inv: CLIInvocation[GhConfig],
) -> tuple[ByteSource | None, IOResult]:
    """``gh pr view``. With ``--json`` it reads the fields named over
    GraphQL, as gh does (see _viewed_pull); the text view reads the REST
    object, and ``-c`` its comments.

    Args:
        inv (CLIInvocation[GhConfig]): the parsed invocation.
    """
    fl = FlagView(inv.flags)
    ref, number = _target(inv, fl)
    fields = json_fields(fl, PR_FIELDS)
    if fields is not None:
        node = await _viewed_pull(inv.config, ref, number, fields)
        return await typed_out(
            exported_node(PULL_FIELD_TABLE, node, fields), fl, "", PR_FIELDS
        )
    row = _pull(await get_pull(inv.config, ref, number))
    comments = await comments_for(inv, fl, ref, number)
    return await typed_out(
        row,
        fl,
        comments_text(comments or [])
        if gh_bool(fl, "comments")
        else _view_text(row),
        PR_FIELDS,
    )


async def create_cmd(
    inv: CLIInvocation[GhConfig],
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    required = {name: fl.as_str(name) for name in ("title", "head", "base")}
    missing = next(
        (name for name, value in required.items() if not value), None
    )
    if missing:
        raise ValueError(f"--{missing} is required in noninteractive mode")
    body_text = await body_value(inv, fl, required=True)
    body: dict[str, JsonValue] = {
        "title": required["title"] or "",
        "head": required["head"] or "",
        "base": required["base"] or "",
        "body": body_text or "",
        "draft": gh_bool(fl, "draft"),
        "maintainer_can_modify": not gh_bool(fl, "no_maintainer_edit"),
    }
    created = _pull(await create_pull(inv.config, repo_for(inv, fl), body))
    return text_out(f"{created.get('url', '')}\n")


async def edit_cmd(
    inv: CLIInvocation[GhConfig],
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    body: dict[str, JsonValue] = {}
    for name in ("title", "base"):
        value = fl.as_str(name)
        if value is not None:
            body[name] = value
    text = await body_value(inv, fl)
    if text is not None:
        body["body"] = text
    if not body:
        raise ValueError("no pull request fields to edit")
    ref, number = _target(inv, fl)
    edited = _pull(await edit_pull(inv.config, ref, number, body))
    return text_out(f"{edited.get('url', '')}\n")


async def merge_cmd(
    inv: CLIInvocation[GhConfig],
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    methods = [
        name for name in ("merge", "rebase", "squash") if gh_bool(fl, name)
    ]
    if len(methods) > 1:
        raise ValueError("choose only one merge strategy")
    body: dict[str, JsonValue] = {
        "merge_method": methods[0] if methods else "merge"
    }
    if fl.as_str("subject") is not None:
        body["commit_title"] = fl.as_str("subject") or ""
    message = await body_value(inv, fl)
    if message is not None:
        body["commit_message"] = message
    if fl.as_str("match_head_commit") is not None:
        body["sha"] = fl.as_str("match_head_commit") or ""
    ref, number = _target(inv, fl)
    await merge_pull(inv.config, ref, number, body)
    return text_out(f"✓ Merged pull request {ref.owner}/{ref.repo}#{number}\n")


async def close_cmd(
    inv: CLIInvocation[GhConfig],
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    ref, number = _target(inv, fl)
    edited = _pull(
        await edit_pull(inv.config, ref, number, {"state": "closed"})
    )
    return text_out(
        f"✓ Closed pull request {ref.owner}/{ref.repo}#{number} "
        f"({edited.get('title', '')})\n"
    )


async def comment_cmd(
    inv: CLIInvocation[GhConfig],
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    body = await body_value(inv, fl, required=True)
    ref, number = _target(inv, fl)
    comment = _pull(await comment_pull(inv.config, ref, number, body or ""))
    return text_out(f"{comment.get('url', '')}\n")


async def diff_cmd(
    inv: CLIInvocation[GhConfig],
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    ref, number = _target(inv, fl)
    value = await diff_pull(inv.config, ref, number)
    if gh_bool(fl, "name_only"):
        return text_out("".join(f"{name}\n" for name in _changed_names(value)))
    return text_out(value if value.endswith("\n") else f"{value}\n")


def _changed_names(diff: str) -> list[str]:
    """The files a diff changes, as ``gh pr diff --name-only`` reads them:
    the ``b/`` side of each ``diff --git`` header, quotes and all.

    Args:
        diff (str): the unified diff.
    """
    return [
        (quote + name).strip() for quote, name in DIFF_HEADER.findall(diff)
    ]


def _check(value: dict[str, Any]) -> dict[str, Any]:
    row = camel(value)
    result = row if isinstance(row, dict) else {}
    result["link"] = result.pop("detailsUrl", "")
    result["description"] = (
        result.get("output", {}).get("summary", "")
        if isinstance(result.get("output"), dict)
        else ""
    )
    conclusion = str(result.get("conclusion") or "")
    state = conclusion or str(result.get("status") or "")
    result["state"] = state
    result["bucket"] = BUCKETS.get(state, "pending")
    app = result.get("app")
    result["workflow"] = app.get("name", "") if isinstance(app, dict) else ""
    return result


async def checks_cmd(
    inv: CLIInvocation[GhConfig],
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    ref, number = _target(inv, fl)
    rows = [
        _check(value) for value in await pull_checks(inv.config, ref, number)
    ]
    human = "".join(
        f"{row.get('name', '')}\t{row.get('state', '')}\t"
        f"{row.get('link', '')}\n"
        for row in rows
    )
    out, io = await typed_out(rows, fl, human, CHECK_FIELDS)
    buckets = {row.get("bucket") for row in rows}
    if "fail" in buckets:
        io.exit_code = 1
    elif "pending" in buckets:
        io.exit_code = 8
    return out, io

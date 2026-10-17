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

from typing import Any, cast

from mirage.accessor.github import GitHubAccount
from mirage.commands.cli.builtin.gh.accessor import (
    body_value,
    camel,
    csv_values,
    gh_bool,
    json_fields,
    list_limit,
    repo_for,
    repo_number,
    text_out,
    typed_out,
)
from mirage.commands.cli.builtin.gh.fields import (
    SHARED_FIELDS,
    Field,
    Node,
    exported_node,
    plain,
    read_rest,
    references,
    selection,
)
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.core.github.issue import (
    IssueListFilter,
    IssueSelections,
    comment_issue,
    create_issue,
    edit_issue,
    get_issue,
    issue_comments,
    issue_fields,
    list_issue_fields,
    list_issues,
)
from mirage.core.github.repo import RepoRef
from mirage.io.types import ByteSource, IOResult
from mirage.types import JsonValue, PathSpec

# Every field `gh issue view --json` and `gh issue list --json` accept in
# gh 2.85: the ones pull requests share, and the ones only an issue has.
ISSUE_FIELD_TABLE: dict[str, Field] = dict(
    [
        *SHARED_FIELDS,
        plain("isPinned", "bool"),
        plain("stateReason", "string"),
        references("closedByPullRequestsReferences"),
    ]
)

ISSUE_FIELDS = tuple(ISSUE_FIELD_TABLE)

# The fields a pull request has no answer for, which gh leaves out of the
# pull request half of its query, so they print at their zero for one.
_ISSUE_ONLY = frozenset(
    {"isPinned", "stateReason", "closedByPullRequestsReferences"}
)

# The --state spellings as the issue states gh lists for each.
_STATES = {
    "open": ("OPEN",),
    "closed": ("CLOSED",),
    "all": ("OPEN", "CLOSED"),
}


async def _viewed_issue(
    accessor: GitHubAccount, ref: RepoRef, number: int, fields: list[str]
) -> Node:
    """One issue as ``gh issue view --json`` reads it.

    gh asks for the number as an issue or a pull request, so a pull
    request's number answers too. It adds the ``id`` its follow-ups read,
    and the ``number`` when it reads project items apart; every
    connection it pages is then read to its end, through the half of the
    query that matches what the number turned out to be.

    Args:
        accessor (GitHubAccount): the install's account.
        ref (RepoRef): the repository.
        number (int): the issue or pull request.
        fields (list[str]): the ``--json`` fields.
    """
    names = [*fields, "id", *(["number"] if "projectItems" in fields else [])]
    node = await issue_fields(
        accessor,
        ref,
        number,
        IssueSelections(
            selection(ISSUE_FIELD_TABLE, names, True),
            selection(
                ISSUE_FIELD_TABLE,
                [name for name in names if name not in _ISSUE_ONLY],
                True,
            ),
        ),
    )
    pull = node.get("__typename") == "PullRequest"

    async def fetch(select: str, cursor: str | None) -> Node:
        halves = (
            IssueSelections("", select)
            if pull
            else IssueSelections(select, "")
        )
        return await issue_fields(accessor, ref, number, halves, cursor)

    return await read_rest(ISSUE_FIELD_TABLE, node, fields, fetch)


def _issue(value: JsonValue) -> dict[str, Any]:
    row = camel(value)
    result = row if isinstance(row, dict) else {}
    result["closed"] = str(result.get("state", "")).lower() == "closed"
    return result


def _labels(row: dict[str, Any]) -> str:
    labels = row.get("labels")
    if not isinstance(labels, list):
        return ""
    return ", ".join(
        str(item.get("name", "")) for item in labels if isinstance(item, dict)
    )


def _list_text(rows: list[dict[str, Any]]) -> str:
    return "".join(
        f"{row.get('number', '')}\t"
        f"{str(row.get('state', '')).upper()}\t"
        f"{row.get('title', '')}\t{_labels(row)}\n"
        for row in rows
    )


def _view_text(row: dict[str, Any]) -> str:
    author = row.get("author")
    login = author.get("login", "") if isinstance(author, dict) else ""
    return (
        f"title:\t{row.get('title', '')}\n"
        f"state:\t{str(row.get('state', '')).upper()}\n"
        f"author:\t{login}\nlabels:\t{_labels(row)}\n--\n"
        f"{row.get('body', '')}\n"
    )


def _target(
    accessor: GitHubAccount, texts: list[str], fl: FlagView
) -> tuple[RepoRef, int]:
    return repo_number(
        accessor, fl, texts[0] if texts else None, "issue", "issues"
    )


async def list_cmd(
    accessor: GitHubAccount,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    """``gh issue list``. With ``--json`` it asks GraphQL for exactly the
    fields named, the way gh's IssueList does, so every field gh accepts is
    answered in gh's own shape; the text view reads the REST listing.

    Args:
        accessor (GitHubAccount): the install's account.
        paths (list[PathSpec]): the path operands.
        texts (list[str]): the text operands.
        ctx (Context): the parsed flags and context.
    """
    fl = FlagView(ctx.flags)
    state = fl.as_str("state") or "open"
    fields = json_fields(fl, ISSUE_FIELDS)
    if fields is not None:
        answers = await list_issue_fields(
            accessor,
            repo_for(accessor, fl),
            IssueListFilter(
                _STATES.get(state, ("OPEN",)),
                fl.as_nonempty("assignee"),
                fl.as_nonempty("author"),
                tuple(csv_values(fl.as_list("label"))),
            ),
            list_limit(fl, 30),
            selection(ISSUE_FIELD_TABLE, fields, False),
        )
        return await typed_out(
            [
                exported_node(ISSUE_FIELD_TABLE, node, fields)
                for node in answers
            ],
            fl,
            "",
            ISSUE_FIELDS,
        )
    params = {"state": state}
    assignee = fl.as_nonempty("assignee")
    if assignee is not None:
        params["assignee"] = assignee
    author = fl.as_nonempty("author")
    if author is not None:
        params["creator"] = author
    labels = csv_values(fl.as_list("label"))
    if labels:
        params["labels"] = ",".join(labels)
    values = await list_issues(
        accessor, repo_for(accessor, fl), params, list_limit(fl, 30)
    )
    rows = [_issue(value) for value in values]
    return await typed_out(rows, fl, _list_text(rows), ISSUE_FIELDS)


async def view_cmd(
    accessor: GitHubAccount,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    """``gh issue view``. With ``--json`` it reads the fields named over
    GraphQL, as gh does (see _viewed_issue); the text view reads the REST
    object, and ``-c`` its comments.

    Args:
        accessor (GitHubAccount): the install's account.
        paths (list[PathSpec]): the path operands.
        texts (list[str]): the text operands.
        ctx (Context): the parsed flags and context.
    """
    fl = FlagView(ctx.flags)
    ref, number = _target(accessor, texts, fl)
    fields = json_fields(fl, ISSUE_FIELDS)
    if fields is not None:
        node = await _viewed_issue(accessor, ref, number, fields)
        return await typed_out(
            exported_node(ISSUE_FIELD_TABLE, node, fields),
            fl,
            "",
            ISSUE_FIELDS,
        )
    row = _issue(await get_issue(accessor, ref, number))
    comments = await comments_for(accessor, fl, ref, number)
    return await typed_out(
        row,
        fl,
        comments_text(comments or [])
        if gh_bool(fl, "comments")
        else _view_text(row),
        ISSUE_FIELDS,
    )


async def create_cmd(
    accessor: GitHubAccount,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags)
    title = fl.as_str("title")
    if not title:
        raise ValueError("--title is required in noninteractive mode")
    body: dict[str, JsonValue] = {
        "title": title,
        "body": await body_value(ctx, fl) or "",
    }
    labels = csv_values(fl.as_list("label"))
    assignees = csv_values(fl.as_list("assignee"))
    if labels:
        body["labels"] = cast(JsonValue, labels)
    if assignees:
        body["assignees"] = cast(JsonValue, assignees)
    ref = repo_for(accessor, fl)
    created = _issue(await create_issue(accessor, ref, body))
    return text_out(f"{created.get('url', '')}\n")


def _names(value: Any) -> list[str]:
    return (
        [
            str(item.get("login", item.get("name", "")))
            for item in value
            if isinstance(item, dict)
        ]
        if isinstance(value, list)
        else []
    )


async def edit_cmd(
    accessor: GitHubAccount,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags)
    ref, number = _target(accessor, texts, fl)
    body: dict[str, JsonValue] = {}
    if fl.as_str("title") is not None:
        body["title"] = fl.as_str("title") or ""
    body_text = await body_value(ctx, fl)
    if body_text is not None:
        body["body"] = body_text
    additions = csv_values(fl.as_list("add_label"))
    removals = set(csv_values(fl.as_list("remove_label")))
    add_assignees = csv_values(fl.as_list("add_assignee"))
    remove_assignees = set(csv_values(fl.as_list("remove_assignee")))
    if additions or removals or add_assignees or remove_assignees:
        current = _issue(await get_issue(accessor, ref, number))
        if additions or removals:
            names = _names(current.get("labels"))
            body["labels"] = list(
                dict.fromkeys(
                    [name for name in names if name not in removals]
                    + additions
                )
            )
        if add_assignees or remove_assignees:
            names = _names(current.get("assignees"))
            body["assignees"] = list(
                dict.fromkeys(
                    [name for name in names if name not in remove_assignees]
                    + add_assignees
                )
            )
    if not body:
        raise ValueError("no issue fields to edit")
    edited = _issue(await edit_issue(accessor, ref, number, body))
    return text_out(f"{edited.get('url', '')}\n")


async def _state(
    accessor: GitHubAccount, texts: list[str], ctx: Context, state: str
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags)
    ref, number = _target(accessor, texts, fl)
    edited = _issue(await edit_issue(accessor, ref, number, {"state": state}))
    verb = "Closed" if state == "closed" else "Reopened"
    return text_out(
        f"✓ {verb} issue {ref.owner}/{ref.repo}#{number} "
        f"({edited.get('title', '')})\n"
    )


async def close_cmd(
    accessor: GitHubAccount,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    return await _state(accessor, texts, ctx, "closed")


async def reopen_cmd(
    accessor: GitHubAccount,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    return await _state(accessor, texts, ctx, "open")


async def comment_cmd(
    accessor: GitHubAccount,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags)
    body = await body_value(ctx, fl, required=True)
    ref, number = _target(accessor, texts, fl)
    comment = _issue(await comment_issue(accessor, ref, number, body or ""))
    return text_out(f"{comment.get('url', '')}\n")


async def comments_for(
    accessor: GitHubAccount, fl: FlagView, ref: RepoRef, number: int
) -> list[dict[str, Any]] | None:
    if not gh_bool(fl, "comments"):
        return None
    rows = await issue_comments(accessor, ref, number)
    for row in rows:
        row["author"] = row.get("author") or {"login": ""}
        row["minimizedReason"] = row.get("minimizedReason") or ""
        row["reactionGroups"] = [
            group
            for group in row["reactionGroups"]
            if group["users"]["totalCount"] > 0
        ]
    return rows


def comments_text(rows: list[dict[str, Any]]) -> str:
    parts = []
    for row in rows:
        author = (row.get("author") or {}).get("login", "")
        status = (
            row["minimizedReason"].lower() if row["isMinimized"] else "none"
        )
        parts.append(
            f"author:\t{author}\n"
            f"association:\t{row['authorAssociation'].lower()}\n"
            f"edited:\t{str(row['includesCreatedEdit']).lower()}\n"
            f"status:\t{status}\n--\n{row['body']}\n--\n"
        )
    return "".join(parts)

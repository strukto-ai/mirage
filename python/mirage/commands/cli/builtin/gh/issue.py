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
    subject_number,
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
from mirage.commands.errors import UsageError
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
    update_issue,
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


def _targets(
    accessor: GitHubAccount, texts: list[str], fl: FlagView
) -> tuple[RepoRef, list[int]]:
    """The issues ``gh issue edit`` names, read as gh's
    ParseIssuesFromArgs reads them: at least one, each parsed before
    anything is asked, and the repository a URL names the one every
    issue is in.
    """
    if not texts:
        raise ValueError("requires at least 1 arg(s), only received 0")
    named: RepoRef | None = None
    numbers: list[int] = []
    for text in texts:
        number = subject_number(text)
        if number is not None:
            numbers.append(number)
            continue
        ref, found = repo_number(accessor, fl, text, "issue", "issues")
        name = f"{ref.owner}/{ref.repo}"
        if named is not None:
            expected = f"{named.owner}/{named.repo}"
            if name.lower() != expected.lower():
                raise ValueError(
                    "multiple issues must be in same repo: found "
                    f"{json.dumps(name)}, expected {json.dumps(expected)}"
                )
        named = named or ref
        numbers.append(found)
    return named or repo_for(accessor, fl), numbers


def _target(
    accessor: GitHubAccount, texts: list[str], fl: FlagView
) -> tuple[RepoRef, int]:
    """The issue a line names: one, as cobra's ExactArgs(1) holds gh's
    verbs to.
    """
    if len(texts) != 1:
        raise ValueError(f"accepts 1 arg(s), received {len(texts)}")
    return repo_number(accessor, fl, texts[0], "issue", "issues")


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
            ctx,
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
    return await typed_out(rows, fl, _list_text(rows), ISSUE_FIELDS, ctx)


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
            ctx,
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
        ctx,
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
    """``gh issue edit``: every issue named, as gh edits them. Each is
    read first, which ends the line at the first one missing; each is
    then edited, the URLs of those edited printed in order, and any that
    failed named on standard error with the count.
    """
    fl = FlagView(ctx.flags)
    ref, numbers = _targets(accessor, texts, fl)
    title = fl.as_str("title")
    body_text = await body_value(ctx, fl)
    additions = csv_values(fl.as_list("add_label"))
    removals = set(csv_values(fl.as_list("remove_label")))
    add_assignees = csv_values(fl.as_list("add_assignee"))
    remove_assignees = set(csv_values(fl.as_list("remove_assignee")))
    relabel = bool(additions or removals)
    reassign = bool(add_assignees or remove_assignees)
    if title is None and body_text is None and not relabel and not reassign:
        raise UsageError(
            "field to edit flag required when not running interactively", 1
        )
    rows = [
        _issue(await get_issue(accessor, ref, number)) for number in numbers
    ]
    edited: list[str] = []
    failed: list[str] = []
    for number, current in zip(numbers, rows, strict=True):
        body: dict[str, JsonValue] = {}
        if title is not None:
            body["title"] = title
        if body_text is not None:
            body["body"] = body_text
        if relabel:
            names = _names(current.get("labels"))
            body["labels"] = list(
                dict.fromkeys(
                    [name for name in names if name not in removals]
                    + additions
                )
            )
        if reassign:
            names = _names(current.get("assignees"))
            body["assignees"] = list(
                dict.fromkeys(
                    [name for name in names if name not in remove_assignees]
                    + add_assignees
                )
            )
        try:
            row = _issue(await update_issue(accessor, ref, number, body))
        except Exception as exc:
            failed.append(f"failed to update {current.get('url', '')}: {exc}")
            continue
        edited.append(str(row.get("url", "")))
    out, io = text_out("".join(f"{url}\n" for url in sorted(edited)))
    if not failed:
        return out, io
    count = "1 issue" if len(failed) == 1 else f"{len(failed)} issues"
    lines = [*sorted(failed), f"gh issue edit: failed to update {count}"]
    return out, IOResult(
        exit_code=1, stderr="".join(f"{line}\n" for line in lines).encode()
    )


async def close_cmd(
    accessor: GitHubAccount,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags)
    ref, number = _target(accessor, texts, fl)
    edited = _issue(
        await edit_issue(accessor, ref, number, {"state": "closed"})
    )
    return text_out(
        f"✓ Closed issue {ref.owner}/{ref.repo}#{number} "
        f"({edited.get('title', '')})\n"
    )


async def reopen_cmd(
    accessor: GitHubAccount,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags)
    ref, number = _target(accessor, texts, fl)
    row = _issue(await get_issue(accessor, ref, number))
    name = f"{ref.owner}/{ref.repo}#{number} ({row.get('title', '')})"
    if not row["closed"]:
        return b"", IOResult(
            stderr=f"! Issue {name} is already open\n".encode()
        )
    comment = fl.as_str("comment")
    if comment:
        await comment_issue(accessor, ref, number, comment)
    await edit_issue(accessor, ref, number, {"state": "open"})
    return text_out(f"✓ Reopened issue {name}\n")


async def comment_cmd(
    accessor: GitHubAccount,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags)
    ref, number = _target(accessor, texts, fl)
    body = await body_value(ctx, fl, required=True)
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

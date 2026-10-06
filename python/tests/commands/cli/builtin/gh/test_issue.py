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

import pytest

from mirage.commands.cli.builtin.gh.issue import (
    ISSUE_FIELDS,
    list_cmd,
    view_cmd,
)
from mirage.commands.cli.types import CLIInvocation
from mirage.core.github.config import GhConfig
from mirage.core.github.issue import IssueListFilter, IssueSelections
from mirage.io.types import materialize

CONFIG = GhConfig(token="t")

# Every field `gh issue view --json` and `gh issue list --json` accept in
# gh 2.85.
GH_FIELDS = [
    "assignees",
    "author",
    "body",
    "closed",
    "closedAt",
    "closedByPullRequestsReferences",
    "comments",
    "createdAt",
    "id",
    "isPinned",
    "labels",
    "milestone",
    "number",
    "projectCards",
    "projectItems",
    "reactionGroups",
    "state",
    "stateReason",
    "title",
    "updatedAt",
    "url",
]


def _inv(flags) -> CLIInvocation:
    return CLIInvocation(
        CONFIG,
        argv=(),
        texts=("4",),
        flags={"repo": "o/r", **flags},
        stdin=None,
        doors=None,
    )


class Answers:
    """Canned issue_fields answers, in order, and the calls made."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.calls: list[tuple] = []

    async def __call__(self, config, ref, number, selections, end_cursor=None):
        self.calls.append((number, selections, end_cursor))
        return self.answers.pop(0)


async def _json(result) -> object:
    out, _ = result
    return json.loads(await materialize(out))


def test_every_field_gh_offers_is_offered():
    assert sorted(ISSUE_FIELDS) == GH_FIELDS


@pytest.mark.asyncio
async def test_the_number_is_asked_for_as_an_issue_or_a_pull(monkeypatch):
    answers = Answers(
        {"__typename": "Issue", "title": "bug", "isPinned": True, "id": "I_1"}
    )
    monkeypatch.setitem(view_cmd.__globals__, "issue_fields", answers)

    assert await _json(await view_cmd(_inv({"json": "title,isPinned"}))) == {
        "isPinned": True,
        "title": "bug",
    }
    assert answers.calls == [
        (4, IssueSelections("title,isPinned,id", "title,id"), None)
    ]


@pytest.mark.asyncio
async def test_a_pull_prints_the_fields_only_an_issue_has_at_their_zero(
    monkeypatch,
):
    answers = Answers({"__typename": "PullRequest", "title": "docs"})
    monkeypatch.setitem(view_cmd.__globals__, "issue_fields", answers)

    out = await _json(
        await view_cmd(
            _inv(
                {
                    "json": "title,isPinned,stateReason,closedByPullRequestsReferences"
                }
            )
        )
    )

    assert out == {
        "closedByPullRequestsReferences": [],
        "isPinned": False,
        "stateReason": "",
        "title": "docs",
    }


@pytest.mark.asyncio
async def test_comments_page_through_the_half_the_number_turned_out_to_be(
    monkeypatch,
):
    def page(body, following):
        return {
            "__typename": "PullRequest",
            "comments": {
                "nodes": [{"body": body}],
                "pageInfo": {
                    "hasNextPage": following is not None,
                    "endCursor": following,
                },
            },
        }

    answers = Answers(page("first", "c1"), page("second", None))
    monkeypatch.setitem(view_cmd.__globals__, "issue_fields", answers)

    out = await _json(await view_cmd(_inv({"json": "comments"})))

    assert [comment["body"] for comment in out["comments"]] == [
        "first",
        "second",
    ]
    _, selections, cursor = answers.calls[1]
    assert selections.issue == ""
    assert "comments(first: 100, after: $endCursor)" in selections.pull
    assert cursor == "c1"


@pytest.mark.asyncio
async def test_project_items_add_the_number_and_are_read_apart(monkeypatch):
    answers = Answers(
        {"__typename": "Issue", "id": "I_1", "number": 4},
        {
            "__typename": "Issue",
            "projectItems": {
                "nodes": [],
                "pageInfo": {"hasNextPage": False, "endCursor": None},
            },
        },
    )
    monkeypatch.setitem(view_cmd.__globals__, "issue_fields", answers)

    assert await _json(await view_cmd(_inv({"json": "projectItems"}))) == {
        "projectItems": []
    }
    assert answers.calls[0][1] == IssueSelections("id,number", "id,number")
    assert answers.calls[1][1].issue.startswith("projectItems(first: 100)")


@pytest.mark.asyncio
async def test_list_asks_graphql_with_the_narrowing_gh_sends(monkeypatch):
    calls = []

    async def listed(config, ref, filter_, limit, selection):
        calls.append((filter_, limit, selection))
        return [{"number": 3, "stateReason": "COMPLETED"}]

    monkeypatch.setitem(list_cmd.__globals__, "list_issue_fields", listed)

    out = await _json(
        await list_cmd(
            _inv(
                {
                    "json": "number,stateReason",
                    "state": "all",
                    "author": "me",
                    "label": ["bug"],
                }
            )
        )
    )

    assert out == [{"number": 3, "stateReason": "COMPLETED"}]
    assert calls == [
        (
            IssueListFilter(("OPEN", "CLOSED"), None, "me", ("bug",)),
            30,
            "number,stateReason",
        )
    ]

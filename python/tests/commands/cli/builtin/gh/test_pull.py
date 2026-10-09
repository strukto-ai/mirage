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

from mirage.commands.cli.builtin.gh.pull import (
    PR_FIELDS,
    _check,
    checks_cmd,
    diff_cmd,
    list_cmd,
    view_cmd,
)
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.errors import UsageError
from mirage.core.github.config import GhConfig
from mirage.io.types import materialize

CONFIG = GhConfig(token="t")


def _inv(texts=(), flags=None) -> CLIInvocation:
    return CLIInvocation(
        CONFIG,
        argv=(),
        texts=tuple(texts),
        flags=flags or {},
        stdin=None,
        view=None,
    )


@pytest.mark.parametrize(
    "conclusion,bucket",
    [
        ("success", "pass"),
        ("neutral", "skipping"),
        ("skipped", "skipping"),
        ("failure", "fail"),
        ("error", "fail"),
        ("timed_out", "fail"),
        ("action_required", "fail"),
        ("cancelled", "cancel"),
        ("stale", "pending"),
    ],
)
def test_conclusions_bucket_the_way_gh_buckets_them(conclusion, bucket):
    assert _check({"name": "t", "conclusion": conclusion})["bucket"] == bucket


@pytest.mark.parametrize(
    "status", ["queued", "in_progress", "pending", "requested", "waiting"]
)
def test_an_unfinished_run_is_pending(status):
    assert _check({"name": "t", "status": status})["bucket"] == "pending"


def test_an_unknown_state_is_pending_rather_than_failed():
    assert (
        _check({"name": "t", "conclusion": "invented"})["bucket"] == "pending"
    )


@pytest.mark.asyncio
async def test_a_cancelled_check_does_not_fail_the_command(monkeypatch):
    async def checks(config, ref, number):
        return [{"name": "t", "conclusion": "cancelled"}]

    monkeypatch.setitem(checks_cmd.__globals__, "pull_checks", checks)

    _, io = await checks_cmd(_inv(texts=["5"], flags={"repo": "o/r"}))

    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_a_failing_check_still_exits_one(monkeypatch):
    async def checks(config, ref, number):
        return [{"name": "t", "conclusion": "failure"}]

    monkeypatch.setitem(checks_cmd.__globals__, "pull_checks", checks)

    _, io = await checks_cmd(_inv(texts=["5"], flags={"repo": "o/r"}))

    assert io.exit_code == 1


# What real gh 2.85 printed for `gh pr diff --name-only` over this diff:
# the `b/` side of each header, a quoted name kept quoted, a rename by its
# new name.
NAME_ONLY_DIFF = (
    "diff --git a/README.md b/README.md\n"
    "deleted file mode 100644\n"
    "--- a/README.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n"
    'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"\n'
    "new file mode 100644\n"
    "diff --git a/docs/contributing.md b/moved/contributing.md\n"
    "similarity index 100%\n"
    'diff --git "a/q\\"t.txt" "b/q\\"t.txt"\n'
    "diff --git a/sub dir/x y.txt b/sub dir/x y.txt\n"
    "+++ b/sub dir/x y.txt\t\n"
)


@pytest.mark.asyncio
async def test_name_only_prints_the_b_side_of_each_header(monkeypatch):
    async def diff(config, ref, number):
        return NAME_ONLY_DIFF

    monkeypatch.setitem(diff_cmd.__globals__, "diff_pull", diff)

    out, io = await diff_cmd(
        _inv(texts=["5"], flags={"repo": "o/r", "name_only": True})
    )

    assert io.exit_code == 0
    assert (await materialize(out)).decode() == (
        'README.md\n"caf\\303\\251.txt"\nmoved/contributing.md\n'
        '"q\\"t.txt"\nsub dir/x y.txt\n'
    )


# Every field `gh pr view --json` and `gh pr list --json` accept in gh 2.85.
GH_FIELDS = [
    "additions",
    "assignees",
    "author",
    "autoMergeRequest",
    "baseRefName",
    "baseRefOid",
    "body",
    "changedFiles",
    "closed",
    "closedAt",
    "closingIssuesReferences",
    "comments",
    "commits",
    "createdAt",
    "deletions",
    "files",
    "fullDatabaseId",
    "headRefName",
    "headRefOid",
    "headRepository",
    "headRepositoryOwner",
    "id",
    "isCrossRepository",
    "isDraft",
    "labels",
    "latestReviews",
    "maintainerCanModify",
    "mergeCommit",
    "mergeStateStatus",
    "mergeable",
    "mergedAt",
    "mergedBy",
    "milestone",
    "number",
    "potentialMergeCommit",
    "projectCards",
    "projectItems",
    "reactionGroups",
    "reviewDecision",
    "reviewRequests",
    "reviews",
    "state",
    "statusCheckRollup",
    "title",
    "updatedAt",
    "url",
]


class Answers:
    """Canned pull_request_fields answers, in order, and the calls made."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.calls: list[tuple] = []

    async def __call__(self, config, ref, number, selection, end_cursor=None):
        self.calls.append((number, selection, end_cursor))
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


async def _json(result) -> object:
    out, _ = result
    return json.loads(await materialize(out))


def _view(fields: str):
    return view_cmd(_inv(texts=["5"], flags={"repo": "o/r", "json": fields}))


def test_every_field_gh_offers_is_offered():
    assert sorted(PR_FIELDS) == GH_FIELDS


@pytest.mark.asyncio
async def test_one_query_names_the_fields_and_the_id_and_number(monkeypatch):
    answers = Answers({"title": "DOC", "changedFiles": 8})
    monkeypatch.setitem(view_cmd.__globals__, "pull_request_fields", answers)

    assert await _json(await _view("title,changedFiles")) == {
        "changedFiles": 8,
        "title": "DOC",
    }
    assert answers.calls == [(5, "title,changedFiles,id,number", None)]


@pytest.mark.asyncio
async def test_number_alone_is_answered_from_the_line(monkeypatch):
    answers = Answers()
    monkeypatch.setitem(view_cmd.__globals__, "pull_request_fields", answers)

    assert await _json(await _view("number")) == {"number": 5}
    assert answers.calls == []


@pytest.mark.asyncio
async def test_files_commits_and_reviews_print_as_gh_prints_them(monkeypatch):
    answers = Answers(
        {
            "files": {
                "nodes": [
                    {"additions": 6, "deletions": 6, "path": "README.md"}
                ]
            },
            "commits": {
                "nodes": [
                    {
                        "commit": {
                            "authors": {
                                "nodes": [
                                    {
                                        "name": "Work",
                                        "email": "w@example.test",
                                        "user": None,
                                    }
                                ]
                            },
                            "messageHeadline": "DOC: fix typos",
                            "messageBody": "and terms",
                            "oid": "abc",
                            "committedDate": "2025-08-12T03:37:28Z",
                            "authoredDate": "2025-08-12T03:37:28Z",
                        }
                    }
                ]
            },
            "reviews": {
                "nodes": [
                    {
                        "id": "PRR_1",
                        "author": {"login": "me"},
                        "authorAssociation": "CONTRIBUTOR",
                        "submittedAt": "2025-08-17T20:15:50Z",
                        "body": "please review",
                        "state": "COMMENTED",
                        "commit": {"oid": "abc"},
                        "reactionGroups": [
                            {"content": "EYES", "users": {"totalCount": 0}}
                        ],
                    }
                ],
                "pageInfo": {"hasNextPage": False, "endCursor": "c"},
            },
        }
    )
    monkeypatch.setitem(view_cmd.__globals__, "pull_request_fields", answers)

    out = await _json(await _view("files,commits,reviews"))

    assert out["files"] == [
        {"path": "README.md", "additions": 6, "deletions": 6}
    ]
    assert list(out["files"][0]) == ["path", "additions", "deletions"]
    assert out["commits"] == [
        {
            "authoredDate": "2025-08-12T03:37:28Z",
            "authors": [
                {
                    "email": "w@example.test",
                    "id": "",
                    "login": "",
                    "name": "Work",
                }
            ],
            "committedDate": "2025-08-12T03:37:28Z",
            "messageBody": "and terms",
            "messageHeadline": "DOC: fix typos",
            "oid": "abc",
        }
    ]
    assert out["reviews"] == [
        {
            "id": "PRR_1",
            "author": {"login": "me"},
            "authorAssociation": "CONTRIBUTOR",
            "body": "please review",
            "submittedAt": "2025-08-17T20:15:50Z",
            "includesCreatedEdit": False,
            "reactionGroups": [],
            "state": "COMMENTED",
            "commit": {"oid": "abc"},
        }
    ]


@pytest.mark.asyncio
async def test_a_paged_connection_is_read_to_its_end(monkeypatch):
    answers = Answers(
        {
            "reviews": {
                "nodes": [{"id": "R1"}],
                "pageInfo": {"hasNextPage": True, "endCursor": "c1"},
            }
        },
        {
            "reviews": {
                "nodes": [{"id": "R2"}],
                "pageInfo": {"hasNextPage": False, "endCursor": "c2"},
            }
        },
    )
    monkeypatch.setitem(view_cmd.__globals__, "pull_request_fields", answers)

    out = await _json(await _view("reviews"))

    assert [review["id"] for review in out["reviews"]] == ["R1", "R2"]
    assert "reviews(first: 100, after: $endCursor)" in answers.calls[1][1]
    assert answers.calls[1][2] == "c1"


@pytest.mark.asyncio
async def test_status_checks_come_from_the_one_commit_gh_rolls_up(monkeypatch):
    def rollup(nodes, following):
        return {
            "statusCheckRollup": {
                "nodes": [
                    {
                        "commit": {
                            "statusCheckRollup": {
                                "contexts": {
                                    "nodes": nodes,
                                    "pageInfo": {
                                        "hasNextPage": following is not None,
                                        "endCursor": following,
                                    },
                                }
                            }
                        }
                    }
                ]
            }
        }

    answers = Answers(
        rollup(
            [
                {
                    "__typename": "CheckRun",
                    "name": "test",
                    "conclusion": "SUCCESS",
                    "status": "COMPLETED",
                }
            ],
            "c1",
        ),
        rollup(
            [
                {
                    "__typename": "StatusContext",
                    "context": "ci",
                    "state": "PENDING",
                    "createdAt": "t",
                }
            ],
            None,
        ),
    )
    monkeypatch.setitem(view_cmd.__globals__, "pull_request_fields", answers)

    out = await _json(await _view("statusCheckRollup"))

    assert out["statusCheckRollup"] == [
        {
            "__typename": "CheckRun",
            "completedAt": "0001-01-01T00:00:00Z",
            "conclusion": "SUCCESS",
            "detailsUrl": "",
            "name": "test",
            "startedAt": "0001-01-01T00:00:00Z",
            "status": "COMPLETED",
            "workflowName": "",
        },
        {
            "__typename": "StatusContext",
            "context": "ci",
            "startedAt": "t",
            "state": "PENDING",
            "targetUrl": "",
        },
    ]
    assert "contexts(first:100, after: $endCursor)" in answers.calls[1][1]


@pytest.mark.asyncio
async def test_no_commit_behind_the_rollup_prints_null(monkeypatch):
    answers = Answers({"statusCheckRollup": {"nodes": []}})
    monkeypatch.setitem(view_cmd.__globals__, "pull_request_fields", answers)

    assert await _json(await _view("statusCheckRollup")) == {
        "statusCheckRollup": None
    }


@pytest.mark.asyncio
async def test_project_cards_are_never_asked_for_and_print_null(monkeypatch):
    answers = Answers({"id": "PR_1", "number": 5})
    monkeypatch.setitem(view_cmd.__globals__, "pull_request_fields", answers)

    assert await _json(await _view("projectCards")) == {"projectCards": None}
    assert answers.calls[0][1] == "id,number"


@pytest.mark.asyncio
async def test_project_items_read_apart_take_a_missing_scope_as_none(
    monkeypatch,
):
    answers = Answers(
        {"id": "PR_1", "number": 5},
        ValueError(
            "GraphQL: Your token has not been granted the required scopes "
            "to execute this query. The 'id' field requires one of the "
            "following scopes: ['read:project'], but your token has only "
            "been granted the: ['repo'] scopes."
        ),
    )
    monkeypatch.setitem(view_cmd.__globals__, "pull_request_fields", answers)

    assert await _json(await _view("projectItems")) == {"projectItems": []}
    assert answers.calls[1][1].startswith("projectItems(first: 100)")


@pytest.mark.asyncio
async def test_any_other_project_items_failure_stands(monkeypatch):
    answers = Answers(
        {"id": "PR_1", "number": 5}, ValueError("GraphQL: something else")
    )
    monkeypatch.setitem(view_cmd.__globals__, "pull_request_fields", answers)

    with pytest.raises(ValueError, match="something else"):
        await _view("projectItems")


@pytest.mark.asyncio
async def test_an_unknown_field_is_refused_before_any_request(monkeypatch):
    answers = Answers()
    monkeypatch.setitem(view_cmd.__globals__, "pull_request_fields", answers)

    with pytest.raises(UsageError, match='Unknown JSON field: "nosuch"'):
        await _view("nosuch")
    assert answers.calls == []


@pytest.mark.asyncio
async def test_pr_list_json_lists_over_graphql_with_ghs_states(monkeypatch):
    calls = []

    async def listing(config, ref, filter_, limit, selection):
        calls.append((filter_, limit, selection))
        return [{"number": 3, "files": {"nodes": []}}]

    monkeypatch.setitem(
        list_cmd.__globals__, "list_pull_request_fields", listing
    )

    out = await _json(
        await list_cmd(
            _inv(
                flags={
                    "repo": "o/r",
                    "json": "number,files",
                    "state": "closed",
                }
            )
        )
    )

    assert out == [{"files": [], "number": 3}]
    filter_, limit, selection = calls[0]
    assert (filter_.states, filter_.base, filter_.head) == (
        ("CLOSED", "MERGED"),
        None,
        None,
    )
    assert limit == 30
    assert selection == (
        "number,files(first: 100) {nodes {additions,deletions,path}}"
    )

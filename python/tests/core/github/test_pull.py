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

import pytest

from mirage.core.github.config import GhConfig
from mirage.core.github.pull import (
    PullListFilter,
    comment_pull,
    commit_statuses,
    list_pull_request_fields,
    list_pulls,
    pull_checks,
    pull_request_fields,
)
from mirage.core.github.repo import RepoRef


@pytest.mark.asyncio
async def test_pull_checks_follow_the_head_sha(monkeypatch):
    async def get_pull(config, ref, number):
        return {"head": {"sha": "abc"}}

    async def pages(config, path, *, limit, key):
        assert (path, limit, key) == (
            "/repos/o/r/commits/abc/check-runs",
            100,
            "check_runs",
        )
        return [{"name": "test"}]

    async def statuses(config, ref, sha):
        assert sha == "abc"
        return []

    monkeypatch.setitem(pull_checks.__globals__, "get_pull", get_pull)
    monkeypatch.setitem(pull_checks.__globals__, "github_pages", pages)
    monkeypatch.setitem(pull_checks.__globals__, "commit_statuses", statuses)

    assert await pull_checks(GhConfig(token="t"), RepoRef("o", "r"), 3) == [
        {"name": "test"}
    ]


@pytest.mark.asyncio
async def test_pull_checks_merge_commit_status_contexts(monkeypatch):
    async def get_pull(config, ref, number):
        return {"head": {"sha": "abc"}}

    async def pages(config, path, *, limit, key):
        return []

    async def statuses(config, ref, sha):
        return [
            {
                "context": "ci/legacy",
                "state": "failure",
                "target_url": "https://ci.test/1",
                "description": "boom",
                "created_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-01-01T00:01:00Z",
            },
            {
                "context": "ci/slow",
                "state": "pending",
            },
        ]

    monkeypatch.setitem(pull_checks.__globals__, "get_pull", get_pull)
    monkeypatch.setitem(pull_checks.__globals__, "github_pages", pages)
    monkeypatch.setitem(pull_checks.__globals__, "commit_statuses", statuses)

    rows = await pull_checks(GhConfig(token="t"), RepoRef("o", "r"), 3)

    assert rows == [
        {
            "name": "ci/legacy",
            "status": "completed",
            "conclusion": "failure",
            "details_url": "https://ci.test/1",
            "output": {"summary": "boom"},
            "started_at": "2026-01-01T00:00:00Z",
            "completed_at": "2026-01-01T00:01:00Z",
        },
        {
            "name": "ci/slow",
            "status": "pending",
            "conclusion": None,
            "details_url": "",
            "output": {"summary": ""},
            "started_at": None,
            "completed_at": None,
        },
    ]


@pytest.mark.asyncio
async def test_commit_statuses_read_the_combined_endpoint(monkeypatch):
    calls = []

    async def request(token, method, path, *args, **kwargs):
        calls.append((method, path))
        return {"state": "success", "statuses": [{"context": "ci"}, "junk"]}

    monkeypatch.setitem(commit_statuses.__globals__, "github_request", request)

    rows = await commit_statuses(GhConfig(token="t"), RepoRef("o", "r"), "abc")

    assert calls == [("GET", "/repos/o/r/commits/abc/status")]
    assert rows == [{"context": "ci"}]


@pytest.mark.asyncio
async def test_comment_pull_preflights_the_pull_number(monkeypatch):
    calls = []

    async def get(config, ref, number):
        calls.append(("GET", number))
        raise ValueError("not a pull request")

    async def request(*args, **kwargs):
        calls.append(("POST", 4))

    monkeypatch.setitem(comment_pull.__globals__, "get_pull", get)
    monkeypatch.setitem(comment_pull.__globals__, "github_request", request)

    with pytest.raises(ValueError, match="not a pull request"):
        await comment_pull(GhConfig(token="t"), RepoRef("o", "r"), 4, "no")
    assert calls == [("GET", 4)]


@pytest.mark.asyncio
async def test_list_pulls_filters_before_applying_the_limit(monkeypatch):
    seen = []

    async def pages(config, path, *, params, limit, include):
        seen.append((path, params, limit))
        rows = [
            {"number": 2, "merged_at": None},
            {"number": 1, "merged_at": "now"},
        ]
        return [row for row in rows if include(row)][:limit]

    monkeypatch.setitem(list_pulls.__globals__, "github_pages", pages)

    rows = await list_pulls(
        GhConfig(token="t"),
        RepoRef("o", "r"),
        {"state": "closed"},
        1,
        include=lambda row: row["merged_at"] is not None,
    )

    assert rows == [{"number": 1, "merged_at": "now"}]
    assert seen == [("/repos/o/r/pulls", {"state": "closed"}, 1)]


class GraphQL:
    """Canned graphql_data answers, in order, and the requests sent."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.sent: list[tuple[str, dict]] = []

    async def __call__(self, config, query, variables):
        self.sent.append((query, dict(variables)))
        return self.answers.pop(0)


@pytest.mark.asyncio
async def test_pull_request_fields_ask_for_one_pull_by_number(monkeypatch):
    graphql = GraphQL({"repository": {"pullRequest": {"title": "t"}}})
    monkeypatch.setitem(
        pull_request_fields.__globals__, "graphql_data", graphql
    )

    node = await pull_request_fields(
        GhConfig(token="t"), RepoRef("o", "r"), 7, "title"
    )

    assert node == {"title": "t"}
    query, variables = graphql.sent[0]
    assert variables == {"owner": "o", "repo": "r", "pr_number": 7}
    assert "pullRequest(number: $pr_number) {title}" in query
    assert "$endCursor" not in query


@pytest.mark.asyncio
async def test_pull_request_fields_declare_the_cursor_only_for_a_page(
    monkeypatch,
):
    graphql = GraphQL({"repository": {"pullRequest": {}}})
    monkeypatch.setitem(
        pull_request_fields.__globals__, "graphql_data", graphql
    )

    await pull_request_fields(
        GhConfig(token="t"),
        RepoRef("o", "r"),
        7,
        "reviews(first: 100, after: $endCursor) {nodes {id}}",
        "c1",
    )

    query, variables = graphql.sent[0]
    assert "$pr_number: Int!, $endCursor: String)" in query
    assert variables["endCursor"] == "c1"


def _page(numbers, following):
    return {
        "repository": {
            "pullRequests": {
                "nodes": [{"number": number} for number in numbers],
                "pageInfo": {
                    "hasNextPage": following is not None,
                    "endCursor": following,
                },
            }
        }
    }


@pytest.mark.asyncio
async def test_pull_listing_pages_to_the_limit_and_lists_a_repeat_once(
    monkeypatch,
):
    graphql = GraphQL(_page([9, 8], "c1"), _page([8, 7, 6], None))
    monkeypatch.setitem(
        list_pull_request_fields.__globals__, "graphql_data", graphql
    )

    rows = await list_pull_request_fields(
        GhConfig(token="t"),
        RepoRef("o", "r"),
        PullListFilter(("OPEN",), "main"),
        3,
        "number",
    )

    assert rows == [{"number": 9}, {"number": 8}, {"number": 7}]
    assert graphql.sent[0][1] == {
        "owner": "o",
        "repo": "r",
        "limit": 3,
        "state": ["OPEN"],
        "baseBranch": "main",
    }
    assert graphql.sent[1][1]["endCursor"] == "c1"
    assert graphql.sent[1][1]["limit"] == 1
    assert "fragment pr on PullRequest{number}" in graphql.sent[0][0]


@pytest.mark.asyncio
async def test_pull_listing_asks_nothing_for_a_zero_limit(monkeypatch):
    graphql = GraphQL()
    monkeypatch.setitem(
        list_pull_request_fields.__globals__, "graphql_data", graphql
    )

    rows = await list_pull_request_fields(
        GhConfig(token="t"),
        RepoRef("o", "r"),
        PullListFilter(("OPEN",)),
        0,
        "number",
    )

    assert rows == []
    assert graphql.sent == []

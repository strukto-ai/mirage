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

from mirage.accessor.github import GitHubAccount
from mirage.core.github.config import GhConfig
from mirage.core.github.issue import (
    IssueListFilter,
    IssueSelections,
    comment_issue,
    edit_issue,
    get_issue,
    issue_comments,
    issue_fields,
    list_issue_fields,
    list_issues,
)
from mirage.core.github.repo import RepoRef

ACCOUNT = GitHubAccount(GhConfig(token="t"))


@pytest.mark.asyncio
async def test_list_issues_filters_pull_requests(monkeypatch):
    calls = []

    async def pages(config, path, *, params, limit, include):
        calls.append((path, params, limit, include))
        return [
            row
            for row in [{"number": 1}, {"number": 2, "pull_request": {}}]
            if include(row)
        ]

    monkeypatch.setitem(list_issues.__globals__, "github_pages", pages)
    rows = await list_issues(ACCOUNT, RepoRef("o", "r"), {"state": "all"}, 7)

    assert rows == [{"number": 1}]
    path, params, limit, include = calls[0]
    assert (path, params, limit) == ("/repos/o/r/issues", {"state": "all"}, 7)
    assert include({"number": 1}) is True
    assert include({"pull_request": {}}) is False


@pytest.mark.asyncio
@pytest.mark.parametrize("verb", ["get", "edit", "comment"])
async def test_direct_issue_verbs_reject_pull_request_numbers(
    monkeypatch, verb
):
    calls = []

    async def request(account, method, path, *args):
        calls.append((method, path))
        return {"number": 4, "pull_request": {"url": "x"}}

    monkeypatch.setitem(get_issue.__globals__, "github_request", request)
    config = ACCOUNT
    ref = RepoRef("o", "r")

    with pytest.raises(ValueError, match="pull request, not an issue"):
        if verb == "get":
            await get_issue(config, ref, 4)
        elif verb == "edit":
            await edit_issue(config, ref, 4, {"state": "closed"})
        else:
            await comment_issue(config, ref, 4, "no")

    assert calls == [("GET", "/repos/o/r/issues/4")]


@pytest.mark.asyncio
async def test_comments_follow_graphql_cursors(monkeypatch):
    cursors = []

    async def request(account, method, path, body):
        cursor = body["variables"]["cursor"]
        cursors.append(cursor)
        assert (method, path) == ("POST", "graphql")
        return {
            "data": {
                "repository": {
                    "issueOrPullRequest": {
                        "comments": {
                            "nodes": [
                                {
                                    "body": "first"
                                    if cursor is None
                                    else "second"
                                }
                            ],
                            "pageInfo": {
                                "hasNextPage": cursor is None,
                                "endCursor": "next",
                            },
                        }
                    }
                }
            }
        }

    monkeypatch.setitem(issue_comments.__globals__, "github_request", request)
    rows = await issue_comments(ACCOUNT, RepoRef("o", "r"), 1)
    assert rows == [{"body": "first"}, {"body": "second"}]
    assert cursors == [None, "next"]


@pytest.mark.asyncio
async def test_comments_report_graphql_errors(monkeypatch):
    message = "Could not resolve repository"

    async def request(*args, **kwargs):
        assert args[1] == "POST"
        return {"errors": [{"message": message}]}

    monkeypatch.setitem(issue_comments.__globals__, "github_request", request)
    with pytest.raises(ValueError, match="Could not resolve repository"):
        await issue_comments(ACCOUNT, RepoRef("o", "r"), 1)


class GraphQL:
    """Canned graphql_data answers, in order, and the requests sent."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.sent: list[tuple[str, dict]] = []

    async def __call__(self, config, query, variables):
        self.sent.append((query, dict(variables)))
        return self.answers.pop(0)


@pytest.mark.asyncio
async def test_issue_fields_ask_for_the_number_as_an_issue_or_a_pull(
    monkeypatch,
):
    graphql = GraphQL(
        {
            "repository": {
                "hasIssuesEnabled": True,
                "issue": {"__typename": "Issue", "title": "t"},
            }
        }
    )
    monkeypatch.setitem(issue_fields.__globals__, "graphql_data", graphql)

    node = await issue_fields(
        ACCOUNT,
        RepoRef("o", "r"),
        4,
        IssueSelections("title,isPinned", "title"),
    )

    assert node == {"__typename": "Issue", "title": "t"}
    query, variables = graphql.sent[0]
    assert variables == {"owner": "o", "repo": "r", "number": 4}
    assert "issue: issueOrPullRequest(number: $number)" in query
    assert "...on Issue{title,isPinned}" in query
    assert "...on PullRequest{title}" in query
    assert "$endCursor" not in query


@pytest.mark.asyncio
async def test_issue_fields_leave_an_empty_half_out_and_page_by_cursor(
    monkeypatch,
):
    graphql = GraphQL({"repository": {"issue": {"__typename": "PullRequest"}}})
    monkeypatch.setitem(issue_fields.__globals__, "graphql_data", graphql)

    await issue_fields(
        ACCOUNT,
        RepoRef("o", "r"),
        4,
        IssueSelections(
            "", "comments(first: 100, after: $endCursor) {nodes {id}}"
        ),
        "c1",
    )

    query, variables = graphql.sent[0]
    assert "$number: Int!, $endCursor: String)" in query
    assert "...on Issue" not in query
    assert variables["endCursor"] == "c1"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "enabled, message",
    [
        (False, "the 'o/r' repository has disabled issues"),
        (True, "issue was not found but GraphQL reported no error"),
    ],
)
async def test_issue_fields_refuse_an_answer_with_no_issue(
    monkeypatch, enabled, message
):
    graphql = GraphQL(
        {"repository": {"hasIssuesEnabled": enabled, "issue": None}}
    )
    monkeypatch.setitem(issue_fields.__globals__, "graphql_data", graphql)

    with pytest.raises(ValueError, match=message):
        await issue_fields(
            ACCOUNT,
            RepoRef("o", "r"),
            4,
            IssueSelections("title", "title"),
        )


def _page(numbers, following):
    return {
        "repository": {
            "hasIssuesEnabled": True,
            "issues": {
                "nodes": [{"number": number} for number in numbers],
                "pageInfo": {
                    "hasNextPage": following is not None,
                    "endCursor": following,
                },
            },
        }
    }


@pytest.mark.asyncio
async def test_issue_listing_pages_newest_first_to_the_limit(monkeypatch):
    graphql = GraphQL(_page([9, 8], "c1"), _page([7, 6], None))
    monkeypatch.setitem(list_issue_fields.__globals__, "graphql_data", graphql)

    rows = await list_issue_fields(
        ACCOUNT,
        RepoRef("o", "r"),
        IssueListFilter(("OPEN", "CLOSED"), author="me", labels=("bug",)),
        3,
        "number",
    )

    assert rows == [{"number": 9}, {"number": 8}, {"number": 7}]
    assert graphql.sent[0][1] == {
        "owner": "o",
        "repo": "r",
        "states": ["OPEN", "CLOSED"],
        "limit": 3,
        "author": "me",
        "labels": ["bug"],
    }
    assert graphql.sent[1][1]["endCursor"] == "c1"
    assert graphql.sent[1][1]["limit"] == 1
    assert "fragment issue on Issue {number}" in graphql.sent[0][0]
    assert (
        "orderBy: {field: CREATED_AT, direction: DESC}" in graphql.sent[0][0]
    )


@pytest.mark.asyncio
async def test_issue_listing_refuses_disabled_issues(monkeypatch):
    graphql = GraphQL(
        {"repository": {"hasIssuesEnabled": False, "issues": None}}
    )
    monkeypatch.setitem(list_issue_fields.__globals__, "graphql_data", graphql)

    with pytest.raises(
        ValueError, match="the 'o/r' repository has disabled issues"
    ):
        await list_issue_fields(
            ACCOUNT,
            RepoRef("o", "r"),
            IssueListFilter(("OPEN",)),
            30,
            "number",
        )


@pytest.mark.asyncio
async def test_issue_listing_asks_nothing_for_a_zero_limit(monkeypatch):
    graphql = GraphQL()
    monkeypatch.setitem(list_issue_fields.__globals__, "graphql_data", graphql)

    rows = await list_issue_fields(
        ACCOUNT,
        RepoRef("o", "r"),
        IssueListFilter(("OPEN",)),
        0,
        "number",
    )

    assert rows == []
    assert graphql.sent == []

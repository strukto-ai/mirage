from unittest.mock import AsyncMock, patch

import pytest

from mirage.core.linear.client import LinearAPIError, list_team_issues


def test_linear_api_error_preserves_explicit_empty_error_list():
    errors: list[dict] = []
    exc = LinearAPIError("failed", errors=errors)

    assert exc.errors is errors


def _issues_page(n: int) -> dict:
    return {
        "team": {
            "issues": {
                "nodes": [{"id": f"i{n}"}],
                "pageInfo": {"hasNextPage": True, "endCursor": f"c{n}"},
            }
        }
    }


# A walk's limit stops the paging at the page that brings that many.
@pytest.mark.asyncio
async def test_a_team_listing_pages_no_further_than_a_walks_limit():
    asked = AsyncMock(side_effect=[_issues_page(0), _issues_page(1)])
    with patch("mirage.core.linear.client.graphql_request", asked):
        issues = await list_team_issues(None, "T1", 1)
    assert [issue["id"] for issue in issues] == ["i0"]
    assert asked.await_count == 1


# Linear filters a team's issues to the projects named, so a project
# listing reads no issue outside them; no project asks nothing.
@pytest.mark.asyncio
async def test_a_project_scoped_listing_asks_only_for_those_projects():
    page = _issues_page(0)
    page["team"]["issues"]["pageInfo"]["hasNextPage"] = False
    asked = AsyncMock(return_value=page)
    with patch("mirage.core.linear.client.graphql_request", asked):
        await list_team_issues(None, "T1", projects=["P1", "P2"])
        assert await list_team_issues(None, "T1", projects=[]) == []
    assert asked.await_count == 1
    assert asked.await_args.args[2]["filter"] == {
        "project": {"id": {"in": ["P1", "P2"]}}
    }

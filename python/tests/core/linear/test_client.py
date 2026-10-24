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

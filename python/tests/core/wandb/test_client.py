import json
from unittest.mock import AsyncMock

import pytest
from aioresponses import aioresponses
from pydantic import SecretStr

from mirage.core.api.client import SessionPool
from mirage.core.wandb.client import WandbClient
from mirage.core.wandb.config import WandbConfig
from mirage.core.wandb.errors import WandbAPIError


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("base", "target", "authenticated"),
    [
        ("https://api.test:443", "https://api.test/file", True),
        ("https://API.TEST", "https://api.test/file", True),
        ("https://api.test", "https://API.TEST:443/file", True),
        ("http://API.TEST:80", "http://api.test/file", True),
        ("https://API.TEST:8443", "https://api.test:8443/file", True),
        ("https://api.test", "/files/a", True),
        ("https://api.test", "https://storage.test/file", False),
        ("https://api.test", "http://api.test/file", False),
        ("https://api.test", "https://api.test:8443/file", False),
        ("https://api.test:8443", "https://api.test/file", False),
    ],
)
async def test_download_auth_uses_normalized_origin(
    base: str, target: str, authenticated: bool
) -> None:
    pool = SessionPool()
    client = WandbClient(
        WandbConfig(
            entities=["lab"], base_url=base, api_key=SecretStr("fixture-key")
        ),
        pool,
    )
    try:
        with aioresponses() as mocked:
            mocked.get(
                base + target if target.startswith("/") else target,
                body=b"file bytes",
            )
            assert (
                b"".join([chunk async for chunk in client.download(target)])
                == b"file bytes"
            )
            call = next(iter(mocked.requests.values()))[0]
            assert call.kwargs["headers"] == (
                client.headers() if authenticated else {}
            )
    finally:
        await pool.close()


def connection(cursor: str | None, more: bool) -> dict:
    return {
        "models": {
            "edges": [{"node": {"name": "one"}}],
            "pageInfo": {"endCursor": cursor, "hasNextPage": more},
        }
    }


@pytest.mark.asyncio
async def test_pagination_and_no_shared_cursor() -> None:
    client = WandbClient(
        WandbConfig(entities=["lab"], page_size=1), SessionPool()
    )
    client.request = AsyncMock(
        side_effect=[
            connection("next", True),
            connection(None, False),
            connection(None, False),
        ]
    )
    assert len(await client.projects("lab")) == 2
    assert len(await client.projects("other")) == 1
    assert [
        call.args[1]["cursor"] for call in client.request.call_args_list
    ] == [None, "next", None]


# A walk's limit stops the paging at the page that brings that many, even
# under a page budget the whole listing would pass.
@pytest.mark.asyncio
async def test_a_walks_limit_pages_no_further() -> None:
    client = WandbClient(
        WandbConfig(entities=["lab"], page_size=1, max_pages=1), SessionPool()
    )
    client.request = AsyncMock(return_value=connection("next", True))
    assert len(await client.projects("lab", 1)) == 1
    assert client.request.call_count == 1


@pytest.mark.asyncio
async def test_repeated_cursor_fails() -> None:
    client = WandbClient(WandbConfig(entities=["lab"]), SessionPool())
    client.request = AsyncMock(return_value=connection("same", True))
    with pytest.raises(WandbAPIError, match="did not advance"):
        await client.projects("lab")
    assert client.request.call_count == 2


@pytest.mark.asyncio
async def test_page_budget_fails_loudly() -> None:
    client = WandbClient(
        WandbConfig(entities=["lab"], max_pages=1), SessionPool()
    )
    client.request = AsyncMock(return_value=connection("next", True))
    with pytest.raises(WandbAPIError, match="limit exceeded"):
        await client.projects("lab")


@pytest.mark.asyncio
async def test_history_empty_window_and_missing_metric() -> None:
    client = WandbClient(
        WandbConfig(entities=["lab"], page_size=2), SessionPool()
    )
    rows = [
        {"_step": 0, "train_step": 100, "score": 0.8},
        {"_step": 5, "loss": None},
    ]
    client.request = AsyncMock(
        side_effect=[
            {"project": {"run": {"historyKeys": {"lastStep": 5}}}},
            {"project": {"run": {"history": [json.dumps(rows[0])]}}},
            {"project": {"run": {"history": []}}},
            {"project": {"run": {"history": [json.dumps(rows[1])]}}},
        ]
    )
    assert [
        row
        async for row in client.history(
            {"entity": "lab", "project": "p", "run": "id"}
        )
    ] == rows
    assert [
        call.args[1]["minStep"] for call in client.request.call_args_list[1:]
    ] == [0, 2, 4]


@pytest.mark.asyncio
async def test_graphql_errors_do_not_become_empty_data(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request = AsyncMock(
        return_value={
            "data": {"models": None},
            "errors": [{"message": "secret-value"}],
        }
    )
    monkeypatch.setattr("mirage.core.wandb.client.api_request", request)
    client = WandbClient(WandbConfig(entities=["lab"]), SessionPool())
    with pytest.raises(WandbAPIError, match="^W&B GraphQL request failed$"):
        await client.projects("lab")


@pytest.mark.asyncio
@pytest.mark.parametrize(("size", "last"), [(1, 0), (1, 3), (3, 3)])
async def test_single_step_windows_preserve_snapshot(
    size: int, last: int
) -> None:
    client = WandbClient(
        WandbConfig(entities=["lab"], page_size=size), SessionPool()
    )
    rows = [{"_step": step} for step in range(last + 2)]

    async def request(query: str, variables: dict) -> dict:
        if "query HistoryKeys" in query:
            return {"project": {"run": {"historyKeys": {"lastStep": last}}}}
        start, stop = variables["minStep"], variables["maxStep"]
        assert stop - start >= 2
        selected = [
            json.dumps(row) for row in rows if start <= row["_step"] < stop
        ]
        return {"project": {"run": {"history": selected}}}

    client.request = AsyncMock(side_effect=request)
    result = [
        row
        async for row in client.history(
            {"entity": "lab", "project": "p", "run": "id"}
        )
    ]
    assert result == rows[:-1]

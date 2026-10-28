import pytest
from mem0.exceptions import NetworkError, RateLimitError

from mirage.accessor.mem0 import Mem0Error
from mirage.core.mem0.client import get_all_memories, search_memories


class FakeClient:
    def __init__(self, pages):
        self.pages = pages
        self.calls = []

    async def get_all(self, options=None):
        self.calls.append(options.model_dump(exclude_unset=True))
        page = options.page or 1
        return self.pages[page - 1]

    async def search(self, query, options=None):
        self.calls.append(
            {"query": query, **options.model_dump(exclude_unset=True)}
        )
        return {"results": [{"id": "1", "memory": "m", "score": 0.9}]}


@pytest.mark.asyncio
async def test_get_all_paginates():
    pages = [
        {"count": 3, "next": "x", "results": [{"id": "a"}, {"id": "b"}]},
        {"count": 3, "next": None, "results": [{"id": "c"}]},
    ]
    client = FakeClient(pages)
    out = await get_all_memories(client, {"user_id": "alex"}, page_size=2)
    assert [m["id"] for m in out] == ["a", "b", "c"]
    assert client.calls[0]["filters"] == {"user_id": "alex"}
    assert client.calls[0]["page"] == 1
    assert client.calls[1]["page"] == 2


@pytest.mark.asyncio
async def test_search():
    client = FakeClient([])
    out = await search_memories(
        client, "morning", {"agent_id": "a"}, top_k=5, threshold=0.0
    )
    assert out[0]["score"] == 0.9
    assert client.calls[0]["query"] == "morning"
    assert client.calls[0]["filters"] == {"agent_id": "a"}
    assert client.calls[0]["top_k"] == 5


class FailingClient:
    def __init__(self, error):
        self.error = error

    async def search(self, query, options=None):
        raise self.error


@pytest.mark.asyncio
async def test_an_sdk_failure_with_a_status_is_a_mem0_error():
    limited = RateLimitError(
        "slow down", "HTTP_429", debug_info={"status_code": 429}
    )
    with pytest.raises(Mem0Error) as caught:
        await search_memories(FailingClient(limited), "q", {"user_id": "a"})
    assert caught.value.status == 429
    assert caught.value.__cause__ is limited
    offline = NetworkError("no route", "NET_001")
    with pytest.raises(NetworkError):
        await search_memories(FailingClient(offline), "q", {"user_id": "a"})

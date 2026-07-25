import pytest
from mem0.exceptions import MemoryNotFoundError, RateLimitError

from mirage.core.mem0._client import (get_all_memories, get_memory,
                                      search_memories)
from mirage.types import PathSpec


class FakeClient:

    def __init__(self, pages, error=None):
        self.pages = pages
        self.error = error
        self.calls = []

    async def get_all(self, options=None):
        self.calls.append(options.model_dump(exclude_unset=True))
        page = options.page or 1
        return self.pages[page - 1]

    async def get(self, memory_id):
        if self.error is not None:
            raise self.error
        return {"id": memory_id, "memory": "hi"}

    async def search(self, query, options=None):
        self.calls.append({
            "query": query,
            **options.model_dump(exclude_unset=True)
        })
        return {"results": [{"id": "1", "memory": "m", "score": 0.9}]}


@pytest.mark.asyncio
async def test_get_all_paginates():
    pages = [
        {
            "count": 3,
            "next": "x",
            "results": [{
                "id": "a"
            }, {
                "id": "b"
            }]
        },
        {
            "count": 3,
            "next": None,
            "results": [{
                "id": "c"
            }]
        },
    ]
    client = FakeClient(pages)
    out = await get_all_memories(client, {"user_id": "alex"}, page_size=2)
    assert [m["id"] for m in out] == ["a", "b", "c"]
    assert client.calls[0]["filters"] == {"user_id": "alex"}
    assert client.calls[0]["page"] == 1
    assert client.calls[1]["page"] == 2


@pytest.mark.asyncio
async def test_get_memory():
    client = FakeClient([])
    path = PathSpec.from_str_path("/memories/xyz.json", "xyz.json")
    assert await get_memory(client, "xyz", path) == {
        "id": "xyz",
        "memory": "hi"
    }


@pytest.mark.asyncio
async def test_get_memory_missing_is_enoent():
    client = FakeClient([],
                        error=MemoryNotFoundError(message="Memory not found",
                                                  error_code="HTTP_404"))
    path = PathSpec.from_str_path("/memories/gone.json", "gone.json")
    with pytest.raises(FileNotFoundError):
        await get_memory(client, "gone", path)


@pytest.mark.asyncio
async def test_get_memory_other_provider_error_propagates():
    client = FakeClient([],
                        error=RateLimitError(message="slow down",
                                             error_code="HTTP_429"))
    path = PathSpec.from_str_path("/memories/gone.json", "gone.json")
    with pytest.raises(RateLimitError):
        await get_memory(client, "gone", path)


@pytest.mark.asyncio
async def test_search():
    client = FakeClient([])
    out = await search_memories(client,
                                "morning", {"agent_id": "a"},
                                top_k=5,
                                threshold=0.0)
    assert out[0]["score"] == 0.9
    assert client.calls[0]["query"] == "morning"
    assert client.calls[0]["filters"] == {"agent_id": "a"}
    assert client.calls[0]["top_k"] == 5

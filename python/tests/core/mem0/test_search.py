import pytest
from pydantic import SecretStr

from mirage.accessor.mem0 import Mem0Accessor
from mirage.commands.builtin.utils.output import format_records
from mirage.core.mem0.search import search_results
from mirage.vfs.mem0.config import Mem0Config


class FakeClient:
    def __init__(self):
        self.calls = []

    async def search(self, query, options=None):
        self.calls.append((query, options.model_dump(exclude_unset=True)))
        return {
            "results": [
                {"id": "aaa", "memory": "eats banana", "score": 0.91},
                {"id": "bbb", "memory": "likes sci-fi", "score": 0.70},
            ]
        }


class EmptyClient:
    async def search(self, query, options=None):
        return {"results": []}


def _accessor():
    cfg = Mem0Config(api_key=SecretStr("k"), agent_id="routine_agent")
    acc = Mem0Accessor(cfg)
    acc._client = FakeClient()
    return acc


@pytest.mark.asyncio
async def test_search_renders_ranked():
    acc = _accessor()
    out = await search_results(
        acc, "morning", mount_prefix="/mem", top_k=5, threshold=0.0
    )
    text = format_records([text for _, text in out]).decode()
    assert "/mem/aaa.json:0.91" in text
    assert "eats banana" in text
    assert acc._client.calls[0][1]["filters"] == {"agent_id": "routine_agent"}
    assert acc._client.calls[0][1]["top_k"] == 5


@pytest.mark.asyncio
async def test_search_empty():
    acc = _accessor()
    acc._client = EmptyClient()
    out = await search_results(
        acc, "nope", mount_prefix="/mem", top_k=5, threshold=0.0
    )
    assert format_records([text for _, text in out]) == b""


@pytest.mark.asyncio
async def test_search_filters_memory_ids():
    acc = _accessor()
    out = await search_results(
        acc,
        "morning",
        mount_prefix="/mem",
        top_k=5,
        threshold=0.0,
        memory_ids={"bbb"},
    )
    assert b"/mem/bbb.json" in format_records([text for _, text in out])
    assert b"/mem/aaa.json" not in format_records([text for _, text in out])


@pytest.mark.asyncio
@pytest.mark.parametrize("threshold", [-0.1, 1.1, float("nan")])
async def test_search_rejects_invalid_threshold(threshold):
    with pytest.raises(ValueError, match="threshold"):
        await search_results(
            _accessor(),
            "morning",
            mount_prefix="/mem",
            top_k=5,
            threshold=threshold,
        )


@pytest.mark.asyncio
async def test_search_rejects_non_positive_top_k():
    with pytest.raises(ValueError, match="top-k"):
        await search_results(
            _accessor(), "morning", mount_prefix="/mem", top_k=0, threshold=0.0
        )

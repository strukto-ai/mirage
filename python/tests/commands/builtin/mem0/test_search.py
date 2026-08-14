import pytest
from pydantic import SecretStr

from mirage.commands.builtin.mem0.search import search
from mirage.commands.config import CommandOpts
from mirage.resource.mem0 import Mem0Config
from mirage.resource.mem0.mem0 import Mem0Resource
from mirage.types import PathSpec


class FakeClient:

    async def search(self, query, options=None):
        return {
            "results": [{
                "id": "aaa",
                "memory": "eats banana",
                "score": 0.9
            }]
        }


def _res():
    res = Mem0Resource(Mem0Config(api_key=SecretStr("k"), agent_id="ra"))
    res.accessor._client = FakeClient()
    return res


@pytest.mark.asyncio
async def test_search_command():
    res = _res()
    p = PathSpec(virtual="/mem", directory="/mem", resource_path="")
    out, _io = await search.__wrapped__(res.accessor, [p], ["morning"],
                                        CommandOpts(index=res.index))
    assert b"aaa.json" in out
    assert b"eats banana" in out


@pytest.mark.asyncio
async def test_search_requires_query():
    res = _res()
    p = PathSpec(virtual="/mem", directory="/mem", resource_path="")
    with pytest.raises(ValueError):
        await search.__wrapped__(res.accessor, [p], [],
                                 CommandOpts(index=res.index))


@pytest.mark.asyncio
async def test_search_rejects_non_semantic_method():
    res = _res()
    p = PathSpec(virtual="/mem", directory="/mem", resource_path="")
    with pytest.raises(ValueError, match="only the 'semantic' method"):
        await search.__wrapped__(
            res.accessor, [p], ["morning"],
            CommandOpts(index=res.index, flags={"method": "keyword"}))

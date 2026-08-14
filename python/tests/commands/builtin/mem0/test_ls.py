import pytest
from pydantic import SecretStr

from mirage.commands.config import CommandOpts
from mirage.resource.mem0 import Mem0Config
from mirage.resource.mem0.mem0 import Mem0Resource
from mirage.types import PathSpec


class FakeClient:

    async def get_all(self, options=None):
        return {
            "count": 2,
            "next": None,
            "results": [{
                "id": "aaa",
                "memory": "x"
            }, {
                "id": "bbb",
                "memory": "y"
            }]
        }


def _res():
    res = Mem0Resource(Mem0Config(api_key=SecretStr("k"), user_id="alex"))
    res.accessor._client = FakeClient()
    return res


def _command(resource: Mem0Resource, name: str):
    return next(command.fn for command in resource.commands()
                if command.name == name and command.filetype is None)


@pytest.mark.asyncio
async def test_ls_lists_memories():
    res = _res()
    p = PathSpec(virtual="/mem", directory="/mem", resource_path="")
    source, _io = await _command(res, "ls")(res.accessor, [p], [],
                                            CommandOpts(index=res.index,
                                                        cwd=p))
    out = b"".join([chunk async for chunk in source]) if hasattr(
        source, "__aiter__") else source
    text = out.decode()
    assert "aaa.json" in text and "bbb.json" in text

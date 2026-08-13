import pytest
from pydantic import SecretStr

from mirage.commands.config import CommandOpts
from mirage.resource.mem0 import Mem0Config
from mirage.resource.mem0.mem0 import Mem0Resource
from mirage.types import PathSpec


class FakeClient:

    async def get_all(self, options=None):
        return {
            "count":
            2,
            "next":
            None,
            "results": [
                {
                    "id": "aaa",
                    "memory": "loves bananas",
                    "categories": ["food"]
                },
                {
                    "id": "bbb",
                    "memory": "likes sci-fi",
                    "categories": ["movies"]
                },
            ]
        }


def _res():
    res = Mem0Resource(Mem0Config(api_key=SecretStr("k"), user_id="alex"))
    res.accessor._client = FakeClient()
    return res


def _command(resource: Mem0Resource, name: str):
    return next(command.fn for command in resource.commands()
                if command.name == name and command.filetype is None)


async def _bytes(source):
    if isinstance(source, bytes):
        return source
    return b"".join([chunk async for chunk in source])


@pytest.mark.asyncio
async def test_rg_recursive_by_default_matches_content():
    res = _res()
    p = PathSpec(virtual="/mem", directory="/mem", resource_path="")
    source, _io = await _command(res, "rg")(res.accessor, [p], ["bananas"],
                                            CommandOpts(index=res.index))
    out = await _bytes(source)
    assert b"bananas" in out
    assert b"sci-fi" not in out

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
    if source is None or isinstance(source, bytes):
        return source or b""
    return b"".join([chunk async for chunk in source])


@pytest.mark.asyncio
async def test_grep_recursive_matches_content():
    res = _res()
    p = PathSpec(virtual="/mem", directory="/mem", resource_path="")
    source, _io = await _command(res, "grep")(res.accessor, [p], ["bananas"],
                                              CommandOpts(index=res.index,
                                                          flags={"r": True}))
    out = await _bytes(source)
    assert b"bananas" in out


@pytest.mark.asyncio
async def test_grep_matches_the_json_file_contents():
    res = _res()
    p = PathSpec(virtual="/mem", directory="/mem", resource_path="")
    source, _io = await _command(res, "grep")(res.accessor, [p], ["food"],
                                              CommandOpts(index=res.index,
                                                          flags={"r": True}))
    assert b"food" in await _bytes(source)


@pytest.mark.asyncio
async def test_grep_bare_directory_is_a_directory():
    res = _res()
    p = PathSpec(virtual="/mem", directory="/mem", resource_path="")
    source, io = await _command(res, "grep")(res.accessor, [p], ["bananas"],
                                             CommandOpts(index=res.index))
    assert io.exit_code == 2
    assert b"Is a directory" in (io.stderr or b"")

import pytest
from pydantic import SecretStr

from mirage.commands.builtin.backends import commands_for
from mirage.commands.builtin.generic_bind import generic
from mirage.commands.builtin.generic_bind.adapter import command_io
from mirage.commands.config import CommandOpts
from mirage.types import PathSpec
from mirage.vfs.mem0 import Mem0Config
from mirage.vfs.mem0.mem0 import Mem0VFS
from tests.fixtures.driver_ops import ops


class FakeClient:
    async def get_all(self, options=None):
        return {
            "count": 2,
            "next": None,
            "results": [
                {
                    "id": "aaa",
                    "memory": "loves bananas",
                    "categories": ["food"],
                },
                {
                    "id": "bbb",
                    "memory": "likes sci-fi",
                    "categories": ["movies"],
                },
            ],
        }


def _res():
    res = Mem0VFS(Mem0Config(api_key=SecretStr("k"), user_id="alex"))
    res.accessor._client = FakeClient()
    return res


def _command(vfs: Mem0VFS, name: str):
    own = [
        command.fn
        for command in commands_for(vfs)
        if command.name == name and command.filetype is None
    ]
    return own[-1] if own else generic(name).fn


async def _bytes(source):
    if isinstance(source, bytes):
        return source
    return b"".join([chunk async for chunk in source])


@pytest.mark.asyncio
async def test_rg_recursive_by_default_matches_content():
    res = _res()
    p = PathSpec(virtual="/mem", directory="/mem", vfs_path="")
    source, _io = await _command(res, "rg")(
        res.accessor,
        [p],
        ["bananas"],
        CommandOpts(io=command_io(res), index=ops(res).index),
    )
    out = await _bytes(source)
    assert b"bananas" in out
    assert b"sci-fi" not in out

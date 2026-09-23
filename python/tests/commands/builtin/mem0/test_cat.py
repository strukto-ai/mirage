import json

import pytest
from pydantic import SecretStr

from mirage.commands.config import CommandOpts
from mirage.types import PathSpec
from mirage.vfs.mem0 import Mem0Config
from mirage.vfs.mem0.mem0 import Mem0VFS


class FakeClient:

    async def get_all(self, options=None):
        return {
            "count": 1,
            "next": None,
            "results": [{
                "id": "aaa",
                "memory": "loves bananas"
            }]
        }

    async def get(self, memory_id):
        return {"id": memory_id, "memory": "loves bananas"}


def _res():
    res = Mem0VFS(Mem0Config(api_key=SecretStr("k"), user_id="alex"))
    res.accessor._client = FakeClient()
    return res


def _command(vfs: Mem0VFS, name: str):
    return next(command.fn for command in vfs.commands()
                if command.name == name and command.filetype is None)


async def _bytes(source):
    if isinstance(source, bytes):
        return source
    return b"".join([chunk async for chunk in source])


@pytest.mark.asyncio
async def test_cat_returns_full_json():
    res = _res()
    p = PathSpec(virtual="/mem/aaa.json",
                 directory="/mem",
                 vfs_path="aaa.json",
                 resolved=True)
    out, _io = await _command(res, "cat")(res.accessor, [p], [],
                                          CommandOpts(index=res.index))
    data = json.loads(await _bytes(out))
    assert data["memory"] == "loves bananas"

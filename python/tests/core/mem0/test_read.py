import json

import pytest
from pydantic import SecretStr

from mirage.accessor.mem0 import Mem0Accessor
from mirage.cache.index import RAMIndexCacheStore
from mirage.core.mem0.read import read
from mirage.core.mem0.readdir import readdir
from mirage.types import PathSpec
from mirage.vfs.mem0.config import Mem0Config


class FakeClient:

    def __init__(self):
        self.get_calls = 0

    async def get_all(self, options=None):
        return {
            "count":
            1,
            "next":
            None,
            "results": [{
                "id": "aaa",
                "memory": "loves bananas",
                "categories": ["food"]
            }]
        }

    async def get(self, memory_id):
        self.get_calls += 1
        return {
            "id": memory_id,
            "memory": "loves bananas",
            "categories": ["food"]
        }


def _accessor():
    cfg = Mem0Config(api_key=SecretStr("k"), user_id="alex")
    acc = Mem0Accessor(cfg)
    acc._client = FakeClient()
    return acc


@pytest.mark.asyncio
async def test_read_full_json_from_cache_no_get():
    acc = _accessor()
    index = RAMIndexCacheStore()
    root = PathSpec(virtual="/mem", directory="/mem", vfs_path="")
    await readdir(acc, root, index)
    fpath = PathSpec(virtual="/mem/aaa.json",
                     directory="/mem",
                     vfs_path="aaa.json")
    data = json.loads(await read(acc, fpath, index))
    assert data["categories"] == ["food"]
    assert acc._client.get_calls == 0


@pytest.mark.asyncio
async def test_read_falls_back_to_get_when_no_cache():
    acc = _accessor()
    index = RAMIndexCacheStore()
    fpath = PathSpec(virtual="/mem/zzz.json",
                     directory="/mem",
                     vfs_path="zzz.json")
    data = json.loads(await read(acc, fpath, index))
    assert data["id"] == "zzz"
    assert acc._client.get_calls == 1


@pytest.mark.asyncio
async def test_read_root_is_eisdir():
    # A matched directory kind is a real node being read as a file.
    acc = _accessor()
    with pytest.raises(IsADirectoryError):
        await read(acc, PathSpec(virtual="/mem", directory="/mem",
                                 vfs_path=""), RAMIndexCacheStore())

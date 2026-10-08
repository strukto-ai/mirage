import pytest
from pydantic import SecretStr

from mirage.accessor.mem0 import Mem0Accessor
from mirage.cache.index import RAMIndexCacheStore
from mirage.types import PathSpec
from mirage.vfs.mem0.config import Mem0Config
from mirage.vfs.mem0.mem0 import Mem0VFS
from tests.fixtures.vfs_io import io_for


class FakeClient:
    async def get_all(self, options=None):
        return {
            "count": 2,
            "next": None,
            "results": [
                {"id": "aaa", "memory": "x"},
                {"id": "bbb", "memory": "y"},
            ],
        }


def _accessor():
    cfg = Mem0Config(api_key=SecretStr("k"), user_id="alex")
    acc = Mem0Accessor(cfg)
    acc._client = FakeClient()
    return acc


@pytest.mark.asyncio
async def test_passthrough_non_pattern():
    acc = _accessor()
    p = PathSpec(
        virtual="/mem/aaa.json",
        directory="/mem",
        vfs_path="aaa.json",
        resolved=True,
    )
    out = await io_for(Mem0VFS, acc).resolve_glob(
        acc, [p], RAMIndexCacheStore()
    )
    assert out == [p]


@pytest.mark.asyncio
async def test_expands_star():
    acc = _accessor()
    p = PathSpec(
        virtual="/mem/*.json",
        directory="/mem",
        vfs_path="*.json",
        pattern="*.json",
        resolved=False,
    )
    out = await io_for(Mem0VFS, acc).resolve_glob(
        acc, [p], RAMIndexCacheStore()
    )
    assert sorted(x.virtual for x in out) == ["/mem/aaa.json", "/mem/bbb.json"]

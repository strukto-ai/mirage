import pytest
from pydantic import SecretStr

from mirage.accessor.mem0 import Mem0Accessor
from mirage.core.mem0.readdir import readdir
from mirage.types import PathSpec
from mirage.vfs.mem0.config import Mem0Config


class FakeClient:
    def __init__(self):
        self.get_all_calls = 0

    async def get_all(self, options=None):
        self.get_all_calls += 1
        return {
            "count": 2,
            "next": None,
            "results": [
                {
                    "id": "aaa",
                    "memory": "first",
                    "created_at": "2026-06-15T00:34:18-07:00",
                    "updated_at": "2026-06-15T00:34:22-07:00",
                },
                {
                    "id": "bbb",
                    "memory": "second",
                    "created_at": "2026-06-15T01:00:00-07:00",
                    "updated_at": "2026-06-15T01:00:05-07:00",
                },
            ],
        }


def _accessor():
    cfg = Mem0Config(api_key=SecretStr("k"), user_id="alex")
    acc = Mem0Accessor(cfg)
    acc._client = FakeClient()
    return acc


@pytest.mark.asyncio
async def test_readdir_lists_memory_files():
    acc = _accessor()
    p = PathSpec(virtual="/mem", directory="/mem", vfs_path="")
    rows = await readdir(acc, p)
    assert sorted(row.name for row in rows) == ["aaa.json", "bbb.json"]


@pytest.mark.asyncio
async def test_readdir_rows_carry_times_and_the_memory():
    acc = _accessor()
    p = PathSpec(virtual="/mem", directory="/mem", vfs_path="")
    row = (await readdir(acc, p))[0]
    assert row.modified == "2026-06-15T00:34:22-07:00"
    assert row.extra["memory"]["created_at"] == "2026-06-15T00:34:18-07:00"

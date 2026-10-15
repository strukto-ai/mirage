import json

import pytest
from pydantic import SecretStr

from mirage.accessor.mem0 import Mem0Accessor
from mirage.core.mem0.read import read
from mirage.types import PathSpec
from mirage.vfs.mem0 import Mem0VFS
from mirage.vfs.mem0.config import Mem0Config
from mirage.workspace import Workspace
from tests.fixtures.vfs_io import vfs_over


class FakeClient:
    def __init__(self):
        self.get_calls = 0

    async def get_all(self, options=None):
        return {
            "count": 1,
            "next": None,
            "results": [
                {
                    "id": "aaa",
                    "memory": "loves bananas",
                    "categories": ["food"],
                }
            ],
        }

    async def get(self, memory_id):
        self.get_calls += 1
        return {
            "id": memory_id,
            "memory": "loves bananas",
            "categories": ["food"],
        }


def _accessor():
    cfg = Mem0Config(api_key=SecretStr("k"), user_id="alex")
    acc = Mem0Accessor(cfg)
    acc._client = FakeClient()
    return acc


def _mounted(acc: Mem0Accessor) -> Workspace:
    return Workspace({"/mem/": vfs_over(Mem0VFS, acc)})


@pytest.mark.asyncio
async def test_read_full_json_from_the_listing_no_get():
    acc = _accessor()
    ws = _mounted(acc)
    await ws.dispatch("readdir", PathSpec.from_str_path("/mem"))
    data, _ = await ws.dispatch(
        "read", PathSpec.from_str_path("/mem/aaa.json")
    )
    assert json.loads(data)["categories"] == ["food"]
    assert acc._client.get_calls == 0


@pytest.mark.asyncio
async def test_a_cold_read_resolves_through_the_scoped_listing():
    acc = _accessor()
    data, _ = await _mounted(acc).dispatch(
        "read", PathSpec.from_str_path("/mem/aaa.json")
    )
    assert json.loads(data)["id"] == "aaa"
    assert acc._client.get_calls == 0


@pytest.mark.asyncio
async def test_a_memory_outside_the_scope_is_enoent():
    """Which memories exist is the configured entity's listing; the
    read used to fetch any id in the file name, so ``cat`` served another
    user's memory that ``ls`` never showed."""
    acc = _accessor()
    with pytest.raises(FileNotFoundError):
        await _mounted(acc).dispatch(
            "read", PathSpec.from_str_path("/mem/zzz.json")
        )
    assert acc._client.get_calls == 0


@pytest.mark.asyncio
async def test_read_root_is_eisdir():
    # A matched directory kind is a real node being read as a file.
    acc = _accessor()
    with pytest.raises(IsADirectoryError):
        await read(
            acc,
            PathSpec(virtual="/mem", directory="/mem", vfs_path=""),
        )

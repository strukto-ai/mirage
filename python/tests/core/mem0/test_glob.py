import pytest
from pydantic import SecretStr

from mirage.accessor.mem0 import Mem0Accessor
from mirage.types import PathSpec
from mirage.vfs.mem0.config import Mem0Config
from mirage.vfs.mem0.mem0 import Mem0VFS
from mirage.workspace import Workspace
from mirage.workspace.expand.globs import expand_glob
from tests.fixtures.vfs_io import vfs_over


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


async def _expanded(acc: Mem0Accessor, p: PathSpec) -> list[PathSpec]:
    ws = Workspace({"/mem/": vfs_over(Mem0VFS, acc)})
    mount = ws._registry.mount_for("/mem/")
    return await expand_glob(
        ws.dispatch, mount, [p], mount.vfs.full_scan_limit
    )


@pytest.mark.asyncio
async def test_passthrough_non_pattern():
    acc = _accessor()
    p = PathSpec(
        virtual="/mem/aaa.json",
        directory="/mem",
        vfs_path="aaa.json",
        resolved=True,
    )
    out = await _expanded(acc, p)
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
    out = await _expanded(acc, p)
    assert sorted(x.virtual for x in out) == ["/mem/aaa.json", "/mem/bbb.json"]

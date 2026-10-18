import pytest
from pydantic import SecretStr

from mirage.types import PathSpec
from mirage.vfs.mem0 import Mem0Config
from mirage.vfs.mem0.mem0 import Mem0VFS
from mirage.workspace import Workspace
from tests.fixtures.mount_commands import run_on_mount


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


@pytest.mark.asyncio
async def test_grep_recursive_matches_content():
    # A memory reads from the row the scoped listing names, which the
    # mount hands it.
    ws = Workspace({"/mem/": _res()})
    result = await ws.shell("grep -r bananas /mem")
    assert "bananas" in await result.stdout_str()


@pytest.mark.asyncio
async def test_grep_bare_directory_is_a_directory():
    p = PathSpec(virtual="/mem", directory="/mem", vfs_path="")
    out, io = await run_on_mount(
        Workspace({"/mem/": _res()}), "grep", [p], ["bananas"]
    )
    assert out == b""
    assert io.exit_code == 2
    assert b"Is a directory" in (io.stderr or b"")

import pytest
from pydantic import SecretStr

from mirage.vfs.mem0 import Mem0Config
from mirage.vfs.mem0.mem0 import Mem0VFS
from mirage.workspace import Workspace


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
async def test_rg_recursive_by_default_matches_content():
    # A memory reads from the row the scoped listing names, which the
    # mount hands it.
    ws = Workspace({"/mem/": _res()})
    result = await ws.shell("rg bananas /mem")
    out = await result.stdout_str()
    assert "bananas" in out
    assert "sci-fi" not in out

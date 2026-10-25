import pytest
from pydantic import SecretStr

from mirage.types import VFSName
from mirage.vfs.mem0 import Mem0Config
from mirage.vfs.mem0.mem0 import Mem0VFS
from mirage.workspace import Workspace
from tests.fixtures.mount_commands import mount_commands
from tests.fixtures.vfs_io import served


def test_vfs_basic():
    cfg = Mem0Config(api_key=SecretStr("secret"), user_id="alex")
    res = Mem0VFS(cfg)
    assert res.name == VFSName.MEM0
    assert res.caches_reads is True
    assert res.supports_snapshot is False


def test_get_state_redacts_api_key():
    cfg = Mem0Config(api_key=SecretStr("secret"), user_id="alex")
    res = Mem0VFS(cfg)
    state = res.get_state()
    assert state["type"] == VFSName.MEM0
    assert "secret" not in str(state)


def test_vfs_uses_generic_read_only_surface():
    cfg = Mem0Config(api_key=SecretStr("secret"), user_id="alex")
    res = Mem0VFS(cfg)
    commands = {command.name for command in mount_commands(res)}
    assert {
        "cat",
        "find",
        "grep",
        "jq",
        "ls",
        "rg",
        "search",
        "stat",
    } <= commands
    assert served(res) == {"read", "readdir", "stat"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,stderr",
    [
        ("search --threshold 2 plans /m", "threshold must be in [0, 1]"),
        ("search --top-k 0 plans /m", "top-k must be positive"),
        (
            "search --method keyword plans /m",
            "only the 'semantic' method is supported",
        ),
    ],
)
async def test_search_refuses_an_option_before_asking_mem0(line, stderr):
    cfg = Mem0Config(api_key=SecretStr("secret"), user_id="alex")
    ws = Workspace({"/m": Mem0VFS(cfg)})
    try:
        result = await ws.shell(line)
        assert result.exit_code == 2
        assert await result.stderr_str() == f"search: {stderr}\n"
    finally:
        await ws.close()


class _PagedClient:
    def __init__(self):
        self.pages: list[int] = []

    async def get_all(self, options=None):
        self.pages.append(options.page)
        n = options.page
        return {"next": "more", "results": [{"id": f"m{n}", "memory": "x"}]}


# find hands its listing the walk's limit, so the memories are paged no
# further than one past what the walk can keep.
@pytest.mark.asyncio
async def test_find_pages_the_memories_no_further_than_its_walk_limit():
    cfg = Mem0Config(
        api_key=SecretStr("secret"),
        user_id="alex",
        default_page_size=1,
        walk_limit=2,
    )
    vfs = Mem0VFS(cfg)
    vfs.accessor._client = _PagedClient()
    ws = Workspace({"/m": vfs})
    try:
        await ws.shell("find /m")
        assert vfs.accessor._client.pages == [1, 2, 3]
    finally:
        await ws.close()

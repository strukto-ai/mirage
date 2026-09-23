import asyncio

from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


def _run(coro):
    return asyncio.run(coro)


async def _setup() -> Workspace:
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    ws.create_session("s")
    await ws.shell("mkdir -p /data/sub /data/emptydir", session_id="s")
    await ws.shell("touch /data/empty.txt /data/sub/nested.txt",
                   session_id="s")
    await ws.shell("printf x > /data/sub/full.txt", session_id="s")
    return ws


def test_empty_matches_empty_files_and_dirs() -> None:

    async def _go():
        ws = await _setup()
        r = await ws.shell("find /data -empty", session_id="s")
        out = sorted((await r.stdout_str()).split())
        assert out == [
            "/data/empty.txt", "/data/emptydir", "/data/sub/nested.txt"
        ]

    _run(_go())


def test_empty_with_type_d() -> None:

    async def _go():
        ws = await _setup()
        r = await ws.shell("find /data -type d -empty", session_id="s")
        assert sorted((await r.stdout_str()).split()) == ["/data/emptydir"]

    _run(_go())


def test_empty_with_type_f() -> None:

    async def _go():
        ws = await _setup()
        r = await ws.shell("find /data -type f -empty", session_id="s")
        assert sorted((await r.stdout_str()).split()) == [
            "/data/empty.txt", "/data/sub/nested.txt"
        ]

    _run(_go())

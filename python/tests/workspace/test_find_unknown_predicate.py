import asyncio

from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


def _ws() -> Workspace:
    return Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)


def _run(coro):
    return asyncio.run(coro)


async def _setup(ws: Workspace) -> None:
    ws.create_session("s")
    await ws.shell("mkdir -p /data/sub", session_id="s")
    await ws.shell("touch /data/a.txt /data/sub/nested.txt", session_id="s")


def test_unknown_predicate_exits_1_and_prints_nothing() -> None:

    async def _go():
        ws = _ws()
        await _setup(ws)
        r = await ws.shell("find /data -boguspredicate", session_id="s")
        assert r.exit_code == 1
        assert await r.stdout_str() == ""
        assert "-boguspredicate" in await r.stderr_str()

    _run(_go())


def test_unsupported_regex_exits_1() -> None:

    async def _go():
        ws = _ws()
        await _setup(ws)
        r = await ws.shell("find /data -regex '.*'", session_id="s")
        assert r.exit_code == 1

    _run(_go())


def test_supported_name_still_exits_0() -> None:

    async def _go():
        ws = _ws()
        await _setup(ws)
        r = await ws.shell("find /data -name '*.txt'", session_id="s")
        assert r.exit_code == 0
        out = await r.stdout_str()
        assert "/data/a.txt" in out

    _run(_go())

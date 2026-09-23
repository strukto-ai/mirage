import pytest

from mirage import RAMVFS, MountMode, Workspace
from mirage.io.stream import materialize
from mirage.workspace.executor.builtins.read import handle_read
from mirage.workspace.session.session import SessionState
from mirage.workspace.session.state import session_view


def make_session() -> SessionState:
    return SessionState(session_id="s1")


async def _read_ws() -> Workspace:
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("mkdir -p /data")
    return ws


@pytest.mark.asyncio
async def test_read_invalid_option_exits_2():
    _, io, _ = await handle_read(["-q", "v"], make_session(), b"line\n")
    assert io.exit_code == 2
    assert await materialize(io.stderr) == b"read: -q: invalid option\n"


@pytest.mark.asyncio
async def test_read_dash_r_consumed_not_a_variable():
    session = make_session()
    _, io, _ = await handle_read(["-r", "v"],
                                 session,
                                 b"hello world\n",
                                 state=session_view(session))
    assert io.exit_code == 0
    assert session.env["v"] == "hello world"
    assert "-r" not in session.env


@pytest.mark.asyncio
async def test_read_defaults_to_reply():
    session = make_session()
    _, io, _ = await handle_read([],
                                 session,
                                 b"hi\n",
                                 state=session_view(session))
    assert io.exit_code == 0
    assert session.env["REPLY"] == "hi"


@pytest.mark.asyncio
async def test_read_replaces_stale_stdin_buffer():
    # A previous read's exhausted herestring buffer must not shadow a
    # new command's stdin.
    ws = await _read_ws()
    await ws.shell("read -r x <<< first")
    io = await ws.shell('read -r y <<< second\necho "y=$y"')
    assert (io.stdout or b"") == b"y=second\n"


@pytest.mark.asyncio
async def test_read_scalar_replaces_array():
    ws = await _read_ws()
    await ws.shell("a=(x y z)")
    io = await ws.shell('read -r a b <<< "one two"\necho "a=$a b=$b"')
    assert (io.stdout or b"") == b"a=one b=two\n"

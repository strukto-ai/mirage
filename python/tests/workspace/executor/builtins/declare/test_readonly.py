import pytest

from mirage import RAMVFS, MountMode, Workspace
from mirage.io.stream import materialize
from mirage.shell.variable import VarAttr
from mirage.workspace.executor.builtins.declare import handle_readonly
from mirage.workspace.session.session import SessionState
from mirage.workspace.session.state import seed_var, set_attr


def make_session() -> SessionState:
    return SessionState(session_id="s1")


@pytest.mark.asyncio
async def test_readonly_p_prints_scalars_and_arrays():
    session = make_session()
    seed_var(session, "VAL", "x")
    set_attr(session, "VAL", VarAttr.READONLY)
    set_attr(session, "ONLY", VarAttr.READONLY)
    seed_var(session, "AR", ["a", "b c"])
    set_attr(session, "AR", VarAttr.READONLY)
    out, io, _ = await handle_readonly(["-p"], session)
    assert io.exit_code == 0
    text = (await materialize(out)).decode()
    assert 'declare -ar AR=([0]="a" [1]="b c")\n' in text
    assert "declare -r ONLY\n" in text
    assert 'declare -r VAL="x"\n' in text


@pytest.mark.asyncio
async def test_readonly_invalid_option_exit_2():
    session = make_session()
    _, io, _ = await handle_readonly(["-z"], session)
    assert io.exit_code == 2
    err = (io.stderr or b"").decode()
    assert "invalid option" in err
    assert "usage: readonly" in err


@pytest.mark.asyncio
async def test_readonly_p_via_workspace():
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell('readonly ZRP1=7; readonly -p | grep ZRP1')
    assert io.exit_code == 0
    assert (io.stdout or b"") == b'declare -r ZRP1="7"\n'


@pytest.mark.asyncio
async def test_readonly_a_lists_arrays_only():
    session = make_session()
    seed_var(session, "VAL", "x")
    set_attr(session, "VAL", VarAttr.READONLY)
    seed_var(session, "AR", ["a"])
    set_attr(session, "AR", VarAttr.READONLY)
    out, io, _ = await handle_readonly(["-a"], session)
    assert io.exit_code == 0
    assert await materialize(out) == b'declare -ar AR=([0]="a")\n'


@pytest.mark.asyncio
async def test_readonly_f_and_A_list_nothing():
    session = make_session()
    seed_var(session, "VAL", "x")
    set_attr(session, "VAL", VarAttr.READONLY)
    for flag in ("-f", "-A"):
        out, io, _ = await handle_readonly([flag], session)
        assert io.exit_code == 0
        assert await materialize(out) == b""


@pytest.mark.asyncio
async def test_readonly_a_via_workspace():
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell("readonly ZRS1=1; readonly -a ZRA1=(x); readonly -a")
    assert io.exit_code == 0
    assert (io.stdout or b"") == b'declare -ar ZRA1=([0]="x")\n'

import pytest

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
async def test_readonly_f_and_A_list_nothing():
    session = make_session()
    seed_var(session, "VAL", "x")
    set_attr(session, "VAL", VarAttr.READONLY)
    for flag in ("-f", "-A"):
        out, io, _ = await handle_readonly([flag], session)
        assert io.exit_code == 0
        assert await materialize(out) == b""

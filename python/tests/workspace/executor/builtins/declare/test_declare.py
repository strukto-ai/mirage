import asyncio

import pytest

from mirage.io.stream import materialize
from mirage.shell.array import make_array
from mirage.shell.variable import VarAttr
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.executor.builtins.declare.declare import (
    declared,
    mark_names,
)
from mirage.workspace.session.session import SessionState
from mirage.workspace.session.state import (
    env_get,
    seed_var,
    set_attr,
    set_var,
)


def make_session() -> SessionState:
    return SessionState(session_id="s1")


async def no_lines(*args, **kwargs):
    raise AssertionError("no nested line runs here")


@pytest.mark.asyncio
@pytest.mark.parametrize("stop", [RuntimeError, asyncio.CancelledError])
async def test_a_failed_subscript_gives_the_shell_back(
    stop: type[BaseException],
):
    async def stopping(*args, **kwargs):
        raise stop("stopped")

    session = make_session()
    seed_var(session, "KEPT", "outer")
    outer = session.vars.shell.enter()
    with pytest.raises(stop):
        await declared(
            "declare",
            lambda shell: shell.declare(
                "declare",
                "",
                "",
                ["KEPT=local", "LANDED=1", "a[$(x)]=v"],
                [],
                True,
            ),
            EvaluationContext(session),
            stopping,
            None,
        )
    assert env_get(session, "LANDED") == "1"
    assert env_get(session, "KEPT") == "local"
    session.vars.shell.leave(outer)
    assert env_get(session, "KEPT") == "outer"
    await set_var(session, "LATER", "1")
    assert env_get(session, "LATER") == "1"


@pytest.mark.asyncio
async def test_readonly_p_prints_scalars_and_arrays():
    session = make_session()
    seed_var(session, "VAL", "x")
    set_attr(session, "VAL", VarAttr.READONLY)
    set_attr(session, "ONLY", VarAttr.READONLY)
    seed_var(session, "AR", make_array(["a", "b c"]))
    set_attr(session, "AR", VarAttr.READONLY)
    out, io, _ = await mark_names(
        ["-p"], EvaluationContext(session), no_lines, None, VarAttr.READONLY
    )
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
        out, io, _ = await mark_names(
            [flag],
            EvaluationContext(session),
            no_lines,
            None,
            VarAttr.READONLY,
        )
        assert io.exit_code == 0
        assert await materialize(out) == b""

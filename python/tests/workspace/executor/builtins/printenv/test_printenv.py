import pytest

from mirage.io.stream import materialize
from mirage.shell.variable import VarAttr
from mirage.workspace.executor.builtins.printenv import handle_printenv
from mirage.workspace.session.session import SessionState
from mirage.workspace.session.state import seed_var, set_attr


def _session() -> SessionState:
    session = SessionState(session_id="s1")
    seed_var(session, "SHOWN", "yes")
    set_attr(session, "SHOWN", VarAttr.EXPORT)
    seed_var(session, "PLAIN", "no")
    return session


@pytest.mark.asyncio
async def test_printenv_prints_one_exported_name():
    out, io, node = await handle_printenv("SHOWN", _session())
    assert await materialize(out) == b"yes\n"
    assert io.exit_code == 0 and node.command == "printenv"


@pytest.mark.asyncio
async def test_printenv_cannot_see_a_plain_shell_variable():
    out, io, _ = await handle_printenv("PLAIN", _session())
    assert out is None and io.exit_code == 1


@pytest.mark.asyncio
async def test_printenv_lists_the_exported_set_sorted():
    out, io, _ = await handle_printenv(None, _session())
    text = (await materialize(out)).decode()
    assert io.exit_code == 0
    assert "SHOWN=yes" in text.splitlines()
    assert "PLAIN=no" not in text
    assert text.splitlines() == sorted(text.splitlines())

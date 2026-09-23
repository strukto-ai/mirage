import pytest

from mirage.workspace.executor.builtins.dirs import handle_pwd
from mirage.workspace.session import SessionState
from mirage.workspace.session.shell_dirs import change_dir


def _session() -> SessionState:
    session = SessionState(session_id="s1")
    change_dir(session, "/data/deep/real", "/data/lk")
    return session


@pytest.mark.asyncio
async def test_pwd_prints_the_logical_cwd_by_default():
    out, io, node = await handle_pwd([], _session())
    assert out == b"/data/lk\n"
    assert io.exit_code == 0 and node.command == "pwd"


@pytest.mark.asyncio
async def test_pwd_dash_p_prints_the_physical_cwd():
    out, _, _ = await handle_pwd(["-P"], _session())
    assert out == b"/data/deep/real\n"


@pytest.mark.asyncio
async def test_pwd_set_physical_changes_the_default():
    session = _session()
    session.shell_options["physical"] = True
    out, _, _ = await handle_pwd([], session)
    assert out == b"/data/deep/real\n"
    out, _, _ = await handle_pwd(["-L"], session)
    assert out == b"/data/lk\n"


@pytest.mark.asyncio
async def test_pwd_ignores_operands_and_refuses_unknown_options():
    out, io, _ = await handle_pwd(["extra"], _session())
    assert out == b"/data/lk\n" and io.exit_code == 0
    out, io, node = await handle_pwd(["-x"], _session())
    assert out is None and io.exit_code == 2
    assert io.stderr == b"pwd: -x: invalid option\npwd: usage: pwd [-LP]\n"

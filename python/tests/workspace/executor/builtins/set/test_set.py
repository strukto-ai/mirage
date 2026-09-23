import pytest

from mirage.io.stream import materialize
from mirage.workspace.executor.builtins.set import handle_set
from mirage.workspace.session.session import SessionState
from mirage.workspace.session.state import seed_var


@pytest.mark.asyncio
async def test_set_double_dash_replaces_the_positional_parameters():
    session = SessionState(session_id="s1")
    out, io, node = await handle_set(["--", "a", "b c"], session)
    assert out is None and io.exit_code == 0 and node.command == "set"
    assert session.positional_args == ["a", "b c"]


@pytest.mark.asyncio
async def test_set_bare_lists_the_variables_sorted():
    session = SessionState(session_id="s1")
    seed_var(session, "ZED", "1")
    seed_var(session, "ALPHA", "2")
    out, io, _ = await handle_set([], session)
    lines = (await materialize(out)).decode().splitlines()
    assert io.exit_code == 0
    assert "ALPHA=2" in lines and "ZED=1" in lines
    assert lines == sorted(lines)


@pytest.mark.asyncio
async def test_set_toggles_a_shell_option_by_letter_and_by_name():
    session = SessionState(session_id="s1")
    _, io, _ = await handle_set(["-e"], session)
    assert io.exit_code == 0 and session.shell_options.get("errexit") is True
    _, io, _ = await handle_set(["+o", "errexit"], session)
    assert io.exit_code == 0 and session.shell_options.get("errexit") is False


@pytest.mark.asyncio
async def test_set_refuses_an_unknown_option_name_with_2():
    session = SessionState(session_id="s1")
    out, io, _ = await handle_set(["-o", "nosuchoption"], session)
    assert out is None and io.exit_code == 2

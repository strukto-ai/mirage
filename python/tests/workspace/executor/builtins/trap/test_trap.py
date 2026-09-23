import pytest

from mirage.workspace.executor.builtins.trap import handle_trap
from mirage.workspace.session.session import SessionState


@pytest.mark.asyncio
async def test_trap_is_accepted_and_prints_nothing():
    out, io, node = await handle_trap(SessionState(session_id="s1"))
    assert out is None
    assert io.exit_code == 0
    assert node.command == "trap" and node.exit_code == 0

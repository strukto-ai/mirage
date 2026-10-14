import pytest

from mirage.workspace.executor.builtins.whoami import handle_whoami


@pytest.mark.asyncio
async def test_whoami_prints_the_profile():
    out, io, node = await handle_whoami("reviewer")
    assert io.exit_code == 0
    assert out == b"reviewer\n"
    assert node.exit_code == 0


@pytest.mark.asyncio
async def test_whoami_errors_without_a_profile():
    out, io, _ = await handle_whoami(None)
    assert io.exit_code == 1
    assert out is None
    assert io.stderr == b"whoami: cannot find name for user ID\n"

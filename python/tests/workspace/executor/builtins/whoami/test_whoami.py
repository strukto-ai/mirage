import pytest

from mirage.commands.builtin.utils.identity import Identity
from mirage.workspace.executor.builtins.whoami import handle_whoami


@pytest.mark.asyncio
async def test_whoami_prints_the_profile():
    out, io, node = await handle_whoami(Identity(profile="reviewer"))
    assert io.exit_code == 0
    assert out == b"reviewer\n"
    assert node.exit_code == 0


@pytest.mark.asyncio
async def test_whoami_without_a_profile_is_root():
    out, io, _ = await handle_whoami(Identity())
    assert io.exit_code == 0
    assert out == b"root\n"


@pytest.mark.asyncio
async def test_whoami_errors_for_a_document_without_a_name():
    out, io, _ = await handle_whoami(Identity(profile=""))
    assert io.exit_code == 1
    assert out is None
    assert io.stderr == b"whoami: cannot find name for user ID 1000\n"

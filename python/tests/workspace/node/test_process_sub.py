import pytest

from mirage.types import MountMode
from mirage.workspace import Workspace


@pytest.mark.asyncio
async def test_process_substitution_keeps_stdin_separate_and_releases_paths():
    ws = Workspace({}, mode=MountMode.WRITE)
    try:
        io = await ws.shell(
            "printf 'outer\\n' | cat <(echo one) - <(echo two); echo /dev/fd/*"
        )
        assert (
            io.exit_code,
            await io.stdout_str(),
            await io.stderr_str(),
        ) == (0, "one\nouter\ntwo\n/dev/fd/*\n", "")
    finally:
        await ws.close()

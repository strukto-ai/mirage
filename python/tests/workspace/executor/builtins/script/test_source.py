import pytest

from mirage.io.stream import materialize
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.executor.builtins.script import handle_source
from mirage.workspace.session.session import SessionState


@pytest.mark.asyncio
async def test_source_without_a_filename_is_a_usage_error():
    out, io, node = await handle_source(None, None, "",
                                        SessionState(session_id="s1"))
    assert out is None
    assert io.exit_code == 2
    assert b"filename argument required" in (await materialize(io.stderr))
    assert node.command == "source"


@pytest.mark.asyncio
async def test_source_runs_the_file_in_the_calling_shell():
    ws = Workspace({"/data": (RAMVFS(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    await ws.shell("printf 'X=from_file\\necho arg1=$1\\n' > /data/s.sh")
    r = await ws.shell("source /data/s.sh one; echo X=$X")
    assert r.exit_code == 0
    assert r.stdout == b"arg1=one\nX=from_file\n"


@pytest.mark.asyncio
async def test_source_reports_a_missing_file():
    ws = Workspace({"/data": (RAMVFS(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    r = await ws.shell("source /data/nope.sh")
    assert r.exit_code == 1
    assert b"No such file or directory" in r.stderr

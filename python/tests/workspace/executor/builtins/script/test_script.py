import pytest

from mirage.types import FileStat, FileType
from mirage.utils.errors import enoent
from mirage.workspace.executor.builtins.script import read_script_text
from mirage.workspace.session import SessionState


@pytest.mark.asyncio
async def test_read_script_text_reports_a_missing_file():
    session = SessionState(session_id="s", cwd="/")

    async def dispatch(op, path, **kwargs):
        raise enoent(path)

    with pytest.raises(FileNotFoundError):
        await read_script_text(dispatch, "/missing.sh", session.cwd)


@pytest.mark.asyncio
async def test_read_script_text_calls_a_directory_a_directory():
    session = SessionState(session_id="s", cwd="/")
    stat = FileStat(name="sub", path="/sub", type=FileType.DIRECTORY, size=0)

    async def dispatch(op, path, **kwargs):
        if op == "stat":
            return stat, None
        raise enoent(path)

    with pytest.raises(IsADirectoryError):
        await read_script_text(dispatch, "/sub", session.cwd)


@pytest.mark.asyncio
async def test_read_script_text_propagates_a_non_filesystem_failure():
    session = SessionState(session_id="s", cwd="/")

    async def dispatch(op, path, **kwargs):
        raise RuntimeError("token expired")

    with pytest.raises(RuntimeError, match="token expired"):
        await read_script_text(dispatch, "/script.sh", session.cwd)

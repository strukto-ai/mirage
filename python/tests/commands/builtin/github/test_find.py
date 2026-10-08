import pytest

from mirage.commands.builtin.github.find import find
from mirage.commands.config import CommandOpts
from mirage.context import reset_current_session, set_current_session
from mirage.io.types import materialize
from mirage.types import HiddenPaths, PathSpec, Visibility
from mirage.utils.hidden import hidden_under
from mirage.vfs.github import GitHubVFS
from mirage.view.types import NamespaceView
from mirage.workspace.session import SessionState
from tests.fixtures.vfs_io import io_for


@pytest.mark.asyncio
async def test_find_missing_start_reports_error(github_env):
    accessor, index = github_env
    stdout, io = await find(
        accessor,
        [PathSpec.from_str_path("/missing")],
        [],
        CommandOpts(io=io_for(GitHubVFS, accessor), index=index),
    )

    assert await materialize(stdout) == b""
    assert io.exit_code == 1
    assert b"missing" in await materialize(io.stderr)


@pytest.mark.asyncio
async def test_a_hidden_child_leaves_its_directory_empty(github_env):
    accessor, index = github_env
    vis = Visibility(paths=HiddenPaths(paths=("/docs/guide.md",)))
    session = SessionState(session_id="veiled", visibility=vis)
    ns = NamespaceView(
        visibility=vis, scoped=lambda virtual: hidden_under(vis, virtual)
    )
    token = set_current_session(session)
    try:
        stdout, io = await find(
            accessor,
            [PathSpec.from_str_path("/docs")],
            ["-type", "d", "-empty"],
            CommandOpts(io=io_for(GitHubVFS, accessor), index=index, ns=ns),
        )
        out = await materialize(stdout)
    finally:
        reset_current_session(token)

    assert out == b"/docs\n"
    assert io.exit_code == 0

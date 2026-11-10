import asyncio
import shlex
import subprocess

import pytest

from mirage.commands.cli.builtin.git.config import config_key


def test_config_key_folds_section_and_name_but_not_subsection():
    assert config_key("Branch.Main.Remote") == "branch.Main.remote"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command",
    [
        "config --local --list",
        "config --local --get core.bare",
        "config --local core.bare",
        "config --local --get nope.key",
        "config --local --get-regexp '^core[.]bare'",
        "config --local --type=bool core.bare",
        "config --local --name-only --list",
        "config --local --get-all core.bare",
    ],
)
async def test_reads_match_git(git_ws, repo_path, command):
    expected = await asyncio.to_thread(
        subprocess.run,
        ["git", "-C", str(repo_path), *shlex.split(command)],
        capture_output=True,
    )
    actual = await git_ws.shell("git -C /repo " + command)
    assert (actual.exit_code, actual.stdout or b"", actual.stderr or b"") == (
        expected.returncode,
        expected.stdout,
        expected.stderr,
    )


@pytest.mark.asyncio
async def test_a_command_line_value_is_read_last(git_ws):
    result = await git_ws.shell(
        "git -C /repo -c core.bare=maybe config --get core.bare"
    )
    assert result.exit_code == 0
    assert result.stdout == b"maybe\n"

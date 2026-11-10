import asyncio
import shlex
import subprocess

import pytest

from mirage.commands.cli.builtin.git.check_ignore import _unquoted
from mirage.commands.cli.builtin.git.errors import GitError


async def native(repo_path, line):
    """Run real git in the repository.

    Args:
        repo_path (Path): the working tree.
        line (str): the words after ``git``.
    """
    return await asyncio.to_thread(
        subprocess.run,
        ["git", "-C", str(repo_path), *shlex.split(line)],
        capture_output=True,
    )


async def same_as_git(git_ws, repo_path, line):
    """Assert both programs answer one line alike.

    Args:
        git_ws (Workspace): workspace with the repository and CLI.
        repo_path (Path): the working tree.
        line (str): the words after ``git``.
    """
    expected = await native(repo_path, line)
    actual = await git_ws.shell("git -C /repo " + line)
    assert (actual.exit_code, actual.stdout or b"", actual.stderr or b"") == (
        expected.returncode,
        expected.stdout,
        expected.stderr,
    )


@pytest.mark.parametrize(
    "line,expected",
    [
        (b'"ig\\157"', b"igo"),
        (b'"a"x', b"a"),
        (b'"\\t\\n"', b"\t\n"),
        (b'"\\\\ \\""', b'\\ "'),
    ],
)
def test_unquoted_reads_to_the_closing_quote(line, expected):
    assert _unquoted(line) == expected


@pytest.mark.parametrize("line", [b'"open', b'"a\\q"', b'"a\\1"'])
def test_unquoted_refuses_a_broken_line(line):
    with pytest.raises(GitError, match="line is badly quoted"):
        _unquoted(line)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command",
    [
        "check-ignore igfile",
        "check-ignore other",
        "check-ignore -v igfile igkeep",
        "check-ignore -v -n other",
        "check-ignore -q igfile",
        "check-ignore a.txt",
        "check-ignore --no-index a.txt",
        "check-ignore -v --no-index a.txt",
        "check-ignore sub/x",
        "check-ignore",
        "check-ignore -n x",
        "check-ignore -z x",
        "check-ignore -q a b",
        "check-ignore -q -v a",
        "check-ignore ''",
    ],
)
async def test_check_ignore_matches_git(git_ws, repo_path, command):
    (repo_path / ".gitignore").write_text("ig*\n!igkeep\n*.txt\nsub/\n")
    await same_as_git(git_ws, repo_path, command)


@pytest.mark.asyncio
async def test_a_later_stdin_line_keeps_the_answers_before_it(
    git_ws, repo_path
):
    (repo_path / ".gitignore").write_text("ig*\n")
    result = await git_ws.shell(
        "printf 'igfile\\n\\nigb\\n' | git -C /repo check-ignore --stdin"
    )
    assert result.exit_code == 128
    assert result.stdout == b"igfile\n"
    assert result.stderr.startswith(b"fatal: empty string")

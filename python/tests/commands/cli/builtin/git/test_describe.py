import asyncio
import shlex
import subprocess

import pytest

TAGGER = {
    "GIT_AUTHOR_NAME": "Ada",
    "GIT_AUTHOR_EMAIL": "ada@example.com",
    "GIT_COMMITTER_NAME": "Ada",
    "GIT_COMMITTER_EMAIL": "ada@example.com",
}


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
        env=TAGGER,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command",
    [
        "describe",
        "describe --tags",
        "describe --all",
        "describe --long",
        "describe --abbrev=0",
        "describe --match 'v*'",
        "describe --exclude 'v*'",
        "describe HEAD~2",
        "describe --always HEAD~2",
        "describe --dirty",
        "describe --dirty=+wip",
        "describe nope",
    ],
)
async def test_describe_matches_git(git_ws, repo_path, command):
    await native(repo_path, "tag -a -m one v1 HEAD~1")
    await native(repo_path, "tag light")
    expected = await native(repo_path, command)
    actual = await git_ws.shell("git -C /repo " + command)
    assert (actual.exit_code, actual.stdout or b"", actual.stderr or b"") == (
        expected.returncode,
        expected.stdout,
        expected.stderr,
    )


@pytest.mark.asyncio
async def test_no_tag_at_all_says_so(git_ws):
    result = await git_ws.shell("git -C /repo describe")
    assert result.exit_code == 128
    assert result.stderr.startswith(b"fatal: No names found")

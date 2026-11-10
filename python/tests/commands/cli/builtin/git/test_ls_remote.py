import asyncio
import shlex
import subprocess

import pytest

TAGGER = {
    "GIT_AUTHOR_NAME": "Ada",
    "GIT_AUTHOR_EMAIL": "ada@example.com",
    "GIT_COMMITTER_NAME": "Ada",
    "GIT_COMMITTER_EMAIL": "ada@example.com",
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_CONFIG_SYSTEM": "/dev/null",
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
        "ls-remote .",
        "ls-remote --heads .",
        "ls-remote --tags .",
        "ls-remote --refs .",
        "ls-remote --symref .",
        "ls-remote --symref --heads .",
        "ls-remote . main",
        "ls-remote . 'refs/tags/*'",
        "ls-remote . nope",
        "ls-remote --exit-code . nope",
        "ls-remote --sort=-refname .",
        "ls-remote --sort=objectname --heads .",
        "ls-remote --get-url nope",
        "ls-remote --get-url",
        "ls-remote",
        "ls-remote nope",
        "ls-remote --sort=bogus .",
    ],
)
async def test_ls_remote_matches_git(git_ws, repo_path, command):
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
async def test_a_remote_named_by_config_says_where_it_listed(git_ws):
    result = await git_ws.shell(
        "git -C /repo -c remote.origin.url=/repo ls-remote"
    )
    assert result.exit_code == 0
    assert result.stderr == b"From /repo\n"

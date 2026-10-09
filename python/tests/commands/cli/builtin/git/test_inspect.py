import asyncio
import json
import os
import shlex
import subprocess
from pathlib import Path

import pytest

from tests.commands.cli.builtin.git.conftest import mounted_rw


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command",
    [
        "remote -v",
        "show-ref",
        "show-ref main",
        "rev-list --all --count",
        "rev-list HEAD",
        "log -1 --date=iso --format=%ad",
        "log -1 --date=iso-strict --format=%ad",
        "log -1 --format=%aI%n%ai%n%cI%n%ci",
        "log -1 --pretty=raw",
        "log --oneline --decorate -2",
        "log --decorate -1",
        "branch -a -vv",
        "show --name-status --format= HEAD",
        "show --summary --format=%h HEAD",
        "diff-tree --no-commit-id --name-only -r HEAD",
        "diff-tree HEAD",
        "diff-tree -r HEAD",
    ],
)
async def test_reads_match_git(git_ws, repo_path, command):
    native = await asyncio.to_thread(
        subprocess.run,
        ["git", "-C", str(repo_path), *shlex.split(command)],
        capture_output=True,
    )
    actual = await git_ws.shell("git -C /repo " + command)
    assert (actual.exit_code, actual.stdout or b"", actual.stderr or b"") == (
        native.returncode,
        native.stdout,
        native.stderr,
    )


@pytest.mark.asyncio
async def test_remote_and_tracking_reads(git_ws, repo_path):
    for args in [
        ["remote", "add", "origin", "https://example.com/org/repo.git"],
        [
            "remote",
            "set-url",
            "--push",
            "origin",
            "ssh://git@example.com/org/repo.git",
        ],
        ["update-ref", "refs/remotes/origin/main", "HEAD~1"],
        ["branch", "--set-upstream-to=origin/main", "main"],
    ]:
        await asyncio.to_thread(
            subprocess.run,
            ["git", "-C", str(repo_path), *args],
            check=True,
            capture_output=True,
        )
    for command in [
        "remote",
        "remote -v",
        "config --get remote.origin.url",
        "branch -a -vv",
        "branch -v",
    ]:
        native = await asyncio.to_thread(
            subprocess.run,
            ["git", "-C", str(repo_path), *shlex.split(command)],
            capture_output=True,
        )
        actual = await git_ws.shell("git -C /repo " + command)
        assert (
            actual.exit_code,
            actual.stdout or b"",
            actual.stderr or b"",
        ) == (native.returncode, native.stdout, native.stderr)


GAPS = Path(__file__).resolve().parents[6] / "integ/fixtures/git/gaps.sh"
ENV = {
    **os.environ,
    "LC_ALL": "C",
    "LANG": "C",
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_CONFIG_NOSYSTEM": "1",
}


@pytest.fixture(scope="module")
def gaps_repo(tmp_path_factory):
    path = tmp_path_factory.mktemp("gaps") / "repo"
    subprocess.run(
        ["bash", str(GAPS), str(path)],
        check=True,
        capture_output=True,
        env=ENV,
    )
    return path


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command", json.loads(GAPS.with_suffix(".json").read_text())
)
async def test_inspection_forms_match_git(gaps_repo, command):
    native = await asyncio.to_thread(
        subprocess.run,
        ["git", "-C", str(gaps_repo), *shlex.split(command)],
        capture_output=True,
        env=ENV,
    )
    with mounted_rw(gaps_repo) as ws:
        actual = await ws.shell("git -C /repo " + command)
    assert (actual.exit_code, actual.stdout or b"", actual.stderr or b"") == (
        native.returncode,
        native.stdout,
        native.stderr,
    )


@pytest.mark.asyncio
async def test_global_config_uses_virtual_home_without_repository(
    git_rw, repo_path
):
    home = repo_path / "home"
    (home / ".config/git").mkdir(parents=True)
    (home / ".config/git/config").write_text("[user]\nname = XDG Author\n")
    (home / ".gitconfig").write_text("[user]\nname = Global Author\n")
    result = await git_rw.shell(
        "HOME=/repo/home git config --global --list --show-origin"
    )
    assert result.exit_code == 0
    assert result.stdout == (
        b"file:/repo/home/.config/git/config\tuser.name=XDG Author\n"
        b"file:/repo/home/.gitconfig\tuser.name=Global Author\n"
    )
    result = await git_rw.shell(
        "HOME=/repo/home git config --global --get user.name"
    )
    assert result.stdout == b"Global Author\n"
    result = await git_rw.shell(
        "HOME=/repo/missing git config --global --list"
    )
    assert result.exit_code == 128
    assert result.stderr == (
        b"fatal: unable to read config file "
        b"'/repo/missing/.gitconfig': "
        b"No such file or directory\n"
    )


@pytest.mark.asyncio
async def test_rev_parse_toplevel_from_subdirectory(git_ws, repo_path):
    (repo_path / "nested").mkdir()
    result = await git_ws.shell(
        "cd /repo/nested && git rev-parse --show-toplevel"
    )
    assert result.exit_code == 0
    assert result.stdout == b"/repo\n"


@pytest.mark.asyncio
async def test_rev_parse_prints_toplevel_in_line_order(git_ws):
    head = (await git_ws.shell("git -C /repo rev-parse HEAD")).stdout
    result = await git_ws.shell(
        "git -C /repo rev-parse HEAD --show-toplevel HEAD"
    )
    assert result.stdout == head + b"/repo\n" + head

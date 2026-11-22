import asyncio
import json
import os
import shlex
import shutil
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
def inspection_repos(tmp_path_factory):
    repos = {}
    for name in ("gaps", "merge-base", "branch"):
        path = tmp_path_factory.mktemp(name) / "repo"
        subprocess.run(
            ["bash", str(GAPS.with_name(name + ".sh")), str(path)],
            check=True,
            capture_output=True,
            env=ENV,
        )
        repos[name] = path
    return repos


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "fixture,command",
    [
        (name, command)
        for name in ("gaps", "merge-base", "branch")
        for command in json.loads(GAPS.with_name(name + ".json").read_text())
    ],
)
async def test_inspection_forms_match_git(inspection_repos, fixture, command):
    path = inspection_repos[fixture]
    native = await asyncio.to_thread(
        subprocess.run,
        ["git", "-C", str(path), *shlex.split(command)],
        capture_output=True,
        env=ENV,
    )
    with mounted_rw(path) as ws:
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


@pytest.mark.asyncio
async def test_config_writes_lines_as_git_does(git_rw, repo_path):
    # git 2.47.3 on debian:stable-slim: a set rewrites the variable's
    # line spelled as typed, --add goes after the block's last variable,
    # a new block takes the name's case, and unset takes an emptied
    # block with it.
    config = repo_path / ".git/config"
    original = config.read_bytes()
    for form in (
        "user.email a@b",
        "user.Email c@d",
        "--add user.email e@f",
        "set user.phone 1",
        "unset user.phone",
        "remote.Origin.url X",
        "core.x ' lead'",
        "set sec.y 'a#b'",
        "--unset core.x",
        "--unset sec.y",
    ):
        result = await git_rw.shell("git -C /repo config " + form)
        assert result.exit_code == 0, form
        assert result.stderr in (None, b""), form
    assert config.read_bytes() == original + (
        b'[user]\n\tEmail = c@d\n\temail = e@f\n[remote "Origin"]\n\turl = X\n'
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "form, code, err",
    [
        (
            "user.email x",
            5,
            b"warning: user.email has multiple values\n"
            b"error: cannot overwrite multiple values with a single value\n"
            b"       Use a regexp, --add or --replace-all to change "
            b"user.email.\n",
        ),
        (
            "--unset user.email",
            5,
            b"warning: user.email has multiple values\n",
        ),
        ("--unset nope.key", 5, b""),
        ("foo bar", 2, b"error: key does not contain a section: foo\n"),
        ("a. c", 2, b"error: key does not contain variable name: a.\n"),
        ("a.1b c", 1, b"error: invalid key: a.1b\n"),
        (
            "--add --unset a.b c",
            129,
            b"error: options '--unset' and '--add' cannot be used together\n",
        ),
    ],
)
async def test_config_write_refusals_match_git(
    git_rw, repo_path, form, code, err
):
    for line in ("user.email a@b", "--add user.email c@d"):
        await git_rw.shell("git -C /repo config " + line)
    config = repo_path / ".git/config"
    before = config.read_bytes()
    result = await git_rw.shell("git -C /repo config " + form)
    assert result.exit_code == code
    assert (result.stderr or b"").startswith(err)
    assert config.read_bytes() == before


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "form",
    [
        "user.name changed old",
        "--unset user.name old",
        "--bool core.bare yes",
        "rename-section core other",
    ],
)
async def test_config_writes_mirage_lacks_are_refused(git_rw, repo_path, form):
    config = repo_path / ".git/config"
    original = config.read_bytes()
    result = await git_rw.shell("git -C /repo config " + form)
    assert result.exit_code == 1
    assert result.stdout in (None, b"")
    assert b"git config is read-only in Mirage" in result.stderr
    assert config.read_bytes() == original


@pytest.mark.asyncio
@pytest.mark.parametrize("verb", ["rev-parse", "rev-list"])
async def test_dash_h_is_help_only_as_the_verbs_one_word(git_ws, verb):
    alone = await git_ws.shell(f"git -C /repo {verb} -h")
    assert alone.exit_code == 0
    assert (alone.stdout or b"").startswith(b"usage: git " + verb.encode())
    repeated = await git_ws.shell(f"git -C /repo {verb} HEAD {verb} -h")
    assert repeated.exit_code != 0
    assert b"usage:" not in (repeated.stdout or b"")


@pytest.fixture(scope="module")
def bare_root(tmp_path_factory) -> Path:
    """A directory holding only a bare clone, ``repo.git``.

    Args:
        tmp_path_factory (TempPathFactory): pytest's module temp dirs.
    """
    root = tmp_path_factory.mktemp("bare")
    env = {
        **ENV,
        "GIT_AUTHOR_NAME": "Ada",
        "GIT_AUTHOR_EMAIL": "ada@example.com",
        "GIT_COMMITTER_NAME": "Ada",
        "GIT_COMMITTER_EMAIL": "ada@example.com",
    }
    source = root / "source"
    for args, cwd in (
        (["init", "-q", "-b", "main", str(source)], root),
        (["commit", "-q", "--allow-empty", "-m", "A"], source),
        (["clone", "-q", "--bare", str(source), str(root / "repo.git")], root),
        (["branch", "trunk"], root / "repo.git"),
    ):
        subprocess.run(["git", *args], cwd=cwd, env=env, check=True)
    shutil.rmtree(source)
    return root


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "directory, line",
    [
        (
            "repo.git",
            "rev-parse --is-bare-repository --is-inside-work-tree --is-inside-git-dir",
        ),
        ("repo.git", "log --format=%s"),
        ("repo.git/refs", "rev-parse --is-bare-repository"),
        ("repo.git", "status"),
    ],
)
async def test_a_bare_repository_is_found_as_git_finds_it(
    bare_root, directory, line
):
    native = subprocess.run(
        ["git", *shlex.split(line)],
        cwd=bare_root / directory,
        env=ENV,
        capture_output=True,
    )
    with mounted_rw(bare_root) as ws:
        got = await ws.shell(f"git -C /repo/{directory} {line}")
    assert (got.exit_code, got.stdout or b"", got.stderr or b"") == (
        native.returncode,
        native.stdout,
        native.stderr,
    )

import asyncio
import os
import subprocess

import pytest

ENV = {
    **os.environ,
    "LC_ALL": "C",
    "LANG": "C",
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_AUTHOR_NAME": "Test",
    "GIT_AUTHOR_EMAIL": "test@example.com",
    "GIT_COMMITTER_NAME": "Test",
    "GIT_COMMITTER_EMAIL": "test@example.com",
}


@pytest.fixture
def search_repo(repo_path):
    (repo_path / "docs/nested").mkdir(parents=True)
    for name, data in {
        "search.txt": b"one\nONE\nstone\n@\na|b\nlast",
        "docs/note.txt": b"one\nother\n",
        "docs/nested/deep.txt": b"one\n",
        "binary.dat": b"one\0more\n",
        "empty.txt": b"",
        "tab\tname.txt": b"one\n",
    }.items():
        (repo_path / name).write_bytes(data)
    subprocess.run(["git", "add", "."], cwd=repo_path, env=ENV, check=True)
    subprocess.run(
        ["git", "commit", "-qm", "search"], cwd=repo_path, env=ENV, check=True
    )
    subprocess.run(
        ["git", "tag", "-a", "v1", "-m", "tag"],
        cwd=repo_path,
        env=ENV,
        check=True,
    )
    (repo_path / "search.txt").write_text("staged\n")
    subprocess.run(
        ["git", "add", "search.txt"], cwd=repo_path, env=ENV, check=True
    )
    (repo_path / "search.txt").write_text("working\none\n")
    (repo_path / "untracked.txt").write_text("one\n")
    return repo_path


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "ls-tree -t HEAD docs/note.txt",
        "ls-tree -rt HEAD docs/nested/deep.txt",
        "ls-tree -rd HEAD docs/nested/",
        "ls-tree HEAD ./",
        "ls-tree HEAD docs/.",
        "ls-tree HEAD search.txt/",
        "ls-tree HEAD:search.txt",
        "ls-tree HEAD",
        "ls-tree -r HEAD",
        "ls-tree -rt HEAD",
        "ls-tree -d HEAD",
        "ls-tree -rd HEAD",
        "ls-tree --name-only HEAD",
        "ls-tree --name-status HEAD",
        "ls-tree -rz HEAD",
        "ls-tree -r --name-only HEAD",
        "ls-tree HEAD docs",
        "ls-tree HEAD docs/",
        "ls-tree HEAD docs/nested",
        "ls-tree HEAD docs/nested/",
        "ls-tree -r HEAD '*.txt'",
        "ls-tree HEAD -- docs/note.txt",
        "ls-tree HEAD^{tree}",
        "ls-tree HEAD:docs",
        "ls-tree v1",
        "ls-tree bad-revision",
    ],
)
async def test_matches_native_git(git_ws, search_repo, line):
    native = await asyncio.to_thread(
        subprocess.run,
        ["bash", "-c", f"git {line}"],
        cwd=search_repo,
        env=ENV,
        capture_output=True,
    )
    actual = await git_ws.shell(f"LC_ALL=C git -C /repo {line}")
    assert (actual.exit_code, actual.stdout or b"", actual.stderr or b"") == (
        native.returncode,
        native.stdout,
        native.stderr,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "ls-tree HEAD",
        "ls-tree -r HEAD",
        "ls-tree --full-name HEAD",
        "ls-tree --full-tree HEAD",
        "ls-tree HEAD ../search.txt",
        "ls-tree HEAD .",
    ],
)
async def test_subdirectory_matches_native_git(git_ws, search_repo, line):
    native = await asyncio.to_thread(
        subprocess.run,
        ["bash", "-c", f"git {line}"],
        cwd=search_repo / "docs",
        env=ENV,
        capture_output=True,
    )
    actual = await git_ws.shell(f"cd /repo/docs && LC_ALL=C git {line}")
    assert (actual.exit_code, actual.stdout or b"", actual.stderr or b"") == (
        native.returncode,
        native.stdout,
        native.stderr,
    )

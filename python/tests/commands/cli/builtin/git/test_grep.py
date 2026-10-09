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
        "grep one --cached -- docs",
        "grep one -I",
        "grep -- --",
        "grep -e one -- docs",
        "grep -Ll one HEAD",
        "grep -lL one HEAD",
        "grep -n one HEAD:search.txt",
        "grep -n one HEAD:search.txt -- NOSUCH",
        "grep -n one HEAD:search.txt HEAD:search.txt",
        "grep one",
        "grep -n one",
        "grep -n one HEAD",
        "grep -n one HEAD~1 HEAD",
        "grep --cached -n staged",
        "grep -n working",
        "grep --cached -n working",
        "grep -i -n ONE HEAD",
        "grep -F -n 'a|b' HEAD",
        "grep -E -n 'one|other' HEAD",
        "grep -F -E -n 'one|other' HEAD",
        "grep -E -F -n 'one|other' HEAD",
        "grep -w -n one HEAD",
        "grep -w '@' HEAD",
        "grep -v -n one HEAD -- docs",
        "grep -c one HEAD",
        "grep -c NOMATCH HEAD",
        "grep -l one HEAD",
        "grep -L one HEAD",
        "grep -L NOMATCH HEAD",
        "grep -q one HEAD",
        "grep -q NOMATCH HEAD",
        "grep -e one -e other HEAD",
        "grep -n -e 'one\nother' HEAD",
        "grep -n one -- docs",
        "grep -n one docs",
        "grep -n one '*.txt'",
        "grep -n one HEAD -- docs",
        "grep -nz one HEAD",
        "grep -lz one HEAD",
        "grep -a -n one HEAD -- binary.dat",
        "grep -I one HEAD",
        "grep -I -L one HEAD",
        "grep -h -n one HEAD -- docs",
        "grep -H -n one HEAD -- docs",
        "grep",
        "grep --cached one HEAD",
        "grep one NOSUCH --",
        "grep one NOSUCH",
        "grep -n one HEAD:docs",
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
        "grep -n one",
        "grep -n one HEAD",
        "grep -n one HEAD -- ..",
        "grep -n one -- ../search.txt",
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


@pytest.mark.asyncio
@pytest.mark.parametrize("pattern", ["*a", "+a", "?a", "(?=a)"])
async def test_extended_regexp_uses_git_posix_dialect(
    git_ws, search_repo, pattern
):
    native = await asyncio.to_thread(
        subprocess.run,
        ["git", "grep", "-E", pattern, "HEAD"],
        cwd=search_repo,
        env=ENV,
        capture_output=True,
    )
    actual = await git_ws.shell(f"git -C /repo grep -E '{pattern}' HEAD")
    assert actual.exit_code == native.returncode == 128
    assert (actual.stderr or b"").startswith(b"fatal: command line, '")


@pytest.mark.asyncio
@pytest.mark.parametrize("replacement", ["missing", "file_link"])
async def test_worktree_skips_deleted_and_symlinked_entries(
    git_ws, search_repo, replacement
):
    (search_repo / "search.txt").unlink()
    if replacement == "file_link":
        (search_repo / "search.txt").symlink_to("docs/note.txt")
    path = "search.txt"
    native = await asyncio.to_thread(
        subprocess.run,
        ["git", "grep", "one", "--", path],
        cwd=search_repo,
        env=ENV,
        capture_output=True,
    )
    actual = await git_ws.shell(f"git -C /repo grep one -- {path}")
    assert (actual.exit_code, actual.stdout or b"", actual.stderr or b"") == (
        native.returncode,
        native.stdout,
        native.stderr,
    )


@pytest.mark.asyncio
async def test_unmerged_index_uses_worktree_but_not_cached_stages(
    git_ws, search_repo
):
    oid = subprocess.check_output(
        ["git", "rev-parse", "HEAD:search.txt"], cwd=search_repo, env=ENV
    ).strip()
    rows = b"".join(
        b"100644 " + oid + b" " + str(stage).encode() + b"\tconflict.txt\n"
        for stage in (1, 2, 3)
    )
    subprocess.run(
        ["git", "update-index", "--index-info"],
        input=rows,
        cwd=search_repo,
        env=ENV,
        check=True,
    )
    (search_repo / "conflict.txt").write_text("ours\n<<<<<<<\nother\n")
    for line in (
        "grep ours -- conflict.txt",
        "grep other -- conflict.txt",
        "grep --cached one -- conflict.txt",
    ):
        native = await asyncio.to_thread(
            subprocess.run,
            ["bash", "-c", f"git {line}"],
            cwd=search_repo,
            env=ENV,
            capture_output=True,
        )
        actual = await git_ws.shell(f"git -C /repo {line}")
        assert (
            actual.exit_code,
            actual.stdout or b"",
            actual.stderr or b"",
        ) == (native.returncode, native.stdout, native.stderr)


@pytest.mark.asyncio
async def test_bare_repo_requires_worktree_only_for_default_source(
    git_ws, search_repo
):
    subprocess.run(
        ["git", "init", "-q", "--bare", str(search_repo / "bare")],
        env=ENV,
        check=True,
    )
    for options in ([], ["--cached"]):
        native = await asyncio.to_thread(
            subprocess.run,
            [
                "git",
                "--git-dir",
                str(search_repo / "bare"),
                "grep",
                *options,
                "one",
            ],
            env=ENV,
            capture_output=True,
        )
        actual = await git_ws.shell(
            f"git --git-dir /repo/bare grep {' '.join(options)} one"
        )
        assert (
            actual.exit_code,
            actual.stdout or b"",
            actual.stderr or b"",
        ) == (native.returncode, native.stdout, native.stderr)


@pytest.mark.asyncio
async def test_bare_h_is_usage_not_a_missing_pattern(git_ws):
    actual = await git_ws.shell("git -C /repo grep -h")
    assert actual.exit_code == 129
    assert (actual.stdout or b"").startswith(b"usage: git grep ")
    assert not actual.stderr


@pytest.mark.asyncio
async def test_namespace_directory_link_keeps_tracked_paths(
    git_rw, search_repo
):
    moved = await git_rw.shell(
        "mv /repo/docs /repo/moved && ln -s moved /repo/docs"
    )
    assert moved.exit_code == 0
    actual = await git_rw.shell("git -C /repo grep one -- docs")
    assert actual.exit_code == 0
    assert actual.stdout == b"docs/nested/deep.txt:one\ndocs/note.txt:one\n"


@pytest.mark.asyncio
async def test_disk_directory_links_stay_hidden_by_mount_policy(
    git_ws, search_repo
):
    (search_repo / "docs").rename(search_repo / "moved")
    (search_repo / "docs").symlink_to("moved", target_is_directory=True)
    actual = await git_ws.shell("git -C /repo grep one -- docs")
    assert actual.exit_code == 1
    assert not actual.stdout

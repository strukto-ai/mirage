# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import posixpath
from pathlib import Path

import pytest
from dulwich.repo import Repo

from mirage.commands.cli.builtin.git.checkout import _conflicts

MODE = 0o100644


async def run(ws, line: str) -> tuple[int, bytes, bytes]:
    """Run one git line against the mounted repository.

    Args:
        ws (Workspace): workspace with the repository and CLI.
        line (str): the command line, without the leading directory.
    """
    result = await ws.execute(f"git -C /repo {line}")
    return result.exit_code, result.stdout or b"", result.stderr or b""


def head_ref(repo_path: Path) -> bytes:
    """What ``.git/HEAD`` holds, read straight off disk.

    Args:
        repo_path (Path): the repository's working tree.
    """
    return (repo_path / ".git" / "HEAD").read_bytes().strip()


async def write(ws, name: str, text: str) -> None:
    """Create a file through the mount rather than behind its back.

    A mount caches its listings, so a file dropped straight onto disk
    after a command has already walked the tree stays invisible to every
    command after it, and a test written that way passes for the wrong
    reason.

    Args:
        ws (Workspace): the writable workspace.
        name (str): repository-relative path to write.
        text (str): one word of content; a newline is appended.
    """
    parent = posixpath.dirname(name)
    if parent:
        await ws.execute(f"mkdir -p /repo/{parent}")
    await ws.execute(f"echo {text} > /repo/{name}")


async def branch_holding(ws, name: str, path: str, text: str) -> None:
    """Make a branch that holds one file main does not, then leave it.

    Args:
        ws (Workspace): the writable workspace.
        name (str): the branch to create.
        path (str): repository-relative path only the branch holds.
        text (str): the content the branch records for it.
    """
    await run(ws, f"checkout -b {name}")
    await write(ws, path, text)
    await run(ws, "add -A")
    await run(ws, f"commit -m {name}")
    await run(ws, "checkout main")


async def branch_at(ws, repo_path: Path, name: str) -> None:
    """Make a branch holding one extra commit, then go back.

    Args:
        ws (Workspace): the writable workspace.
        repo_path (Path): the repository's working tree.
        name (str): the branch to create.
    """
    await run(ws, f"checkout -b {name}")
    (repo_path / "a.txt").write_text("on the branch\n", encoding="utf-8")
    await run(ws, "add -A")
    await run(ws, "commit -m sideways")
    await run(ws, "checkout main")


def test_a_file_both_branches_agree_on_is_carried():
    # git carries an uncommitted edit across rather than refusing when
    # the target branch records the same content for the path.
    before = {b"a.txt": (MODE, b"a" * 40)}
    after = {b"a.txt": (MODE, b"a" * 40)}
    assert _conflicts(before, after, {"a.txt"}) == []


def test_a_file_the_branches_disagree_on_blocks():
    before = {b"a.txt": (MODE, b"a" * 40)}
    after = {b"a.txt": (MODE, b"b" * 40)}
    assert _conflicts(before, after, {"a.txt"}) == ["a.txt"]


def test_a_file_the_target_does_not_have_blocks():
    before = {b"a.txt": (MODE, b"a" * 40)}
    assert _conflicts(before, {}, {"a.txt"}) == ["a.txt"]


def test_a_clean_file_never_blocks():
    before = {b"a.txt": (MODE, b"a" * 40)}
    after = {b"a.txt": (MODE, b"b" * 40)}
    assert _conflicts(before, after, set()) == []


@pytest.mark.asyncio
async def test_switching_moves_head_to_the_branch(git_rw, repo_path: Path):
    await run(git_rw, "branch topic")
    code, _out, err = await run(git_rw, "checkout topic")
    assert code == 0
    assert err == b"Switched to branch 'topic'\n"
    assert head_ref(repo_path) == b"ref: refs/heads/topic"


@pytest.mark.asyncio
async def test_switching_to_where_you_already_are_says_so(git_rw):
    _code, _out, err = await run(git_rw, "checkout main")
    assert err == b"Already on 'main'\n"


@pytest.mark.asyncio
async def test_creating_and_switching_in_one_step(git_rw, repo_path: Path):
    code, _out, err = await run(git_rw, "checkout -b shiny")
    assert code == 0
    assert err == b"Switched to a new branch 'shiny'\n"
    assert head_ref(repo_path) == b"ref: refs/heads/shiny"


@pytest.mark.asyncio
async def test_creating_at_a_start_point_branches_from_there(
        git_rw, repo_path: Path):
    # The operand is the whole point of the form: without it every commit
    # after the switch lands on the wrong history.
    with Repo(str(repo_path)) as repo:
        older = repo[repo.refs[b"HEAD"]].parents[0]
    code, _out, err = await run(git_rw, "checkout -b older HEAD~1")
    assert code == 0
    assert err == b"Switched to a new branch 'older'\n"
    with Repo(str(repo_path)) as repo:
        assert repo.refs[b"refs/heads/older"] == older


@pytest.mark.asyncio
async def test_creating_without_a_start_point_branches_from_head(
        git_rw, repo_path: Path):
    with Repo(str(repo_path)) as repo:
        head = repo.refs[b"HEAD"]
    assert (await run(git_rw, "checkout -b shiny"))[0] == 0
    with Repo(str(repo_path)) as repo:
        assert repo.refs[b"refs/heads/shiny"] == head


@pytest.mark.asyncio
async def test_creating_at_a_start_point_that_is_not_a_commit(git_rw):
    code, _out, err = await run(git_rw, "checkout -b shiny nosuchrev")
    assert code == 128
    assert err == (b"fatal: 'nosuchrev' is not a commit and a branch 'shiny' "
                   b"cannot be created from it\n")


@pytest.mark.asyncio
async def test_creating_a_branch_that_exists_is_refused(git_rw):
    await run(git_rw, "branch topic")
    code, _out, err = await run(git_rw, "checkout -b topic")
    assert code == 128
    assert err == b"fatal: a branch named 'topic' already exists\n"


@pytest.mark.asyncio
async def test_an_unknown_target_is_refused(git_rw):
    code, _out, err = await run(git_rw, "checkout nosuchthing")
    assert code == 1
    assert err == (b"error: pathspec 'nosuchthing' did not match any file(s) "
                   b"known to git\n")


@pytest.mark.asyncio
async def test_the_working_tree_follows_the_branch(git_rw, repo_path: Path):
    await branch_at(git_rw, repo_path, "topic")
    assert (repo_path / "a.txt").read_text() == "one changed\n"
    await run(git_rw, "checkout topic")
    assert (repo_path / "a.txt").read_text() == "on the branch\n"


@pytest.mark.asyncio
async def test_an_edit_that_would_be_lost_blocks_the_switch(
        git_rw, repo_path: Path):
    await branch_at(git_rw, repo_path, "topic")
    (repo_path / "a.txt").write_text("precious\n", encoding="utf-8")
    code, _out, err = await run(git_rw, "checkout topic")
    assert code == 1
    assert b"would be overwritten by checkout" in err
    assert b"\ta.txt" in err
    # The point of the refusal: the edit is still there.
    assert (repo_path / "a.txt").read_text() == "precious\n"
    assert head_ref(repo_path) == b"ref: refs/heads/main"


@pytest.mark.asyncio
async def test_an_edit_to_an_untouched_file_rides_along(
        git_rw, repo_path: Path):
    await branch_at(git_rw, repo_path, "topic")
    (repo_path / "b.txt").write_text("carried\n", encoding="utf-8")
    code, out, _err = await run(git_rw, "checkout topic")
    assert code == 0
    assert out == b"M\tb.txt\n"
    assert (repo_path / "b.txt").read_text() == "carried\n"


@pytest.mark.asyncio
async def test_an_untracked_file_is_left_alone(git_rw, repo_path: Path):
    await branch_at(git_rw, repo_path, "topic")
    (repo_path / "mine.txt").write_text("untracked\n", encoding="utf-8")
    assert (await run(git_rw, "checkout topic"))[0] == 0
    assert (repo_path / "mine.txt").read_text() == "untracked\n"


@pytest.mark.asyncio
async def test_an_untracked_file_the_branch_holds_blocks_the_switch(
        git_rw, repo_path: Path):
    # The dangerous one: the file is in no index and no tree, so the
    # tracked comparison cannot see it, and writing the branch's blob
    # over it destroys the only copy there is.
    await branch_holding(git_rw, "topic", "fresh.txt", "branch")
    await write(git_rw, "fresh.txt", "mine")
    code, _out, err = await run(git_rw, "checkout topic")
    assert code == 1
    assert err == (b"error: The following untracked working tree files would "
                   b"be overwritten by checkout:\n\tfresh.txt\nPlease move or "
                   b"remove them before you switch branches.\nAborting\n")
    assert (repo_path / "fresh.txt").read_text() == "mine\n"
    assert head_ref(repo_path) == b"ref: refs/heads/main"


@pytest.mark.asyncio
async def test_an_untracked_file_inside_an_untracked_directory_blocks(
        git_rw, repo_path: Path):
    # Status collapses a wholly untracked directory to one `dir/` row,
    # and a collision has to be decided per file. git names the file.
    await branch_holding(git_rw, "topic", "nd/file.txt", "branch")
    await write(git_rw, "nd/file.txt", "mine")
    await write(git_rw, "nd/other.txt", "also")
    code, _out, err = await run(git_rw, "checkout topic")
    assert code == 1
    assert b"\tnd/file.txt" in err
    assert (repo_path / "nd" / "file.txt").read_text() == "mine\n"


@pytest.mark.asyncio
async def test_an_ignored_file_is_overwritten_without_a_word(
        git_rw, repo_path: Path):
    # git's own split: an ignored file is not work the caller is keeping.
    await run(git_rw, "checkout -b topic")
    await write(git_rw, "ig.txt", "branch")
    await run(git_rw, "add -f ig.txt")
    await run(git_rw, "commit -m ignored")
    await run(git_rw, "checkout main")
    await write(git_rw, ".gitignore", "ig.txt")
    await write(git_rw, "ig.txt", "mine")
    code, _out, _err = await run(git_rw, "checkout topic")
    assert code == 0
    assert (repo_path / "ig.txt").read_text() == "branch\n"


@pytest.mark.asyncio
async def test_both_kinds_of_conflict_are_reported_together(git_rw):
    await run(git_rw, "checkout -b topic")
    await write(git_rw, "a.txt", "onthebranch")
    await write(git_rw, "fresh.txt", "branch")
    await run(git_rw, "add -A")
    await run(git_rw, "commit -m both")
    await run(git_rw, "checkout main")
    await write(git_rw, "a.txt", "precious")
    await write(git_rw, "fresh.txt", "mine")
    code, _out, err = await run(git_rw, "checkout topic")
    assert code == 1
    # One aborting line at the end, and the second paragraph carries its
    # own prefix, which is how git prints two errors before one abort.
    assert err == (b"error: Your local changes to the following files would "
                   b"be overwritten by checkout:\n\ta.txt\nPlease commit your "
                   b"changes or stash them before you switch branches.\n"
                   b"error: The following untracked working tree files would "
                   b"be overwritten by checkout:\n\tfresh.txt\nPlease move or "
                   b"remove them before you switch branches.\nAborting\n")


@pytest.mark.asyncio
async def test_switching_to_a_commit_detaches_head(git_rw, repo_path: Path):
    with Repo(str(repo_path)) as repo:
        older = repo[repo.refs[b"HEAD"]].parents[0].decode()
    code, _out, err = await run(git_rw, f"checkout {older[:7]}")
    assert code == 0
    assert b"detached HEAD" in err
    assert head_ref(repo_path) == older.encode()


@pytest.mark.asyncio
async def test_an_unknown_switch_is_refused(git_rw):
    code, _out, err = await run(git_rw, "checkout -Z")
    assert code == 129
    assert err == b"error: unknown switch `Z'\n"

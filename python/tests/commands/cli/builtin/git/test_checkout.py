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

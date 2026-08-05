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

from mirage.commands.cli.builtin.git import GIT
from tests.commands.cli.builtin.git.conftest import (make_branch, mounted,
                                                     pack_refs)

REMOTE_DIR = ("refs", "remotes", "origin")


def add_remote(repo_path: Path, name: str, content: str) -> None:
    """Write one loose ref under ``refs/remotes/origin``.

    Written by hand because the fixture repository has no remote to
    fetch from, and a remote-tracking ref is just a file.

    Args:
        repo_path (Path): the repository's working tree.
        name (str): ref name below ``refs/remotes/origin``.
        content (str): the ref's contents, an id or a ``ref:`` line.
    """
    directory = repo_path / ".git" / Path(*REMOTE_DIR)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / name).write_text(content + "\n", encoding="utf-8")


def head_sha(repo_path: Path) -> str:
    """The current commit id.

    Args:
        repo_path (Path): the repository's working tree.
    """
    with Repo(str(repo_path)) as repo:
        return repo.refs[b"HEAD"].decode()


@pytest.mark.asyncio
async def test_the_checked_out_branch_is_marked(git_ws):
    result = await git_ws.execute("git -C /repo branch")
    assert result.exit_code == 0
    assert result.stdout == b"* main\n"


@pytest.mark.asyncio
async def test_other_branches_are_listed_and_sorted(repo_path):
    make_branch(repo_path, "zeta")
    make_branch(repo_path, "feat/git-cli")
    with mounted(repo_path) as ws:
        ws.register_cli("git", GIT)
        result = await ws.execute("git -C /repo branch")
    assert result.stdout == b"  feat/git-cli\n* main\n  zeta\n"


@pytest.mark.asyncio
async def test_local_branches_are_found_in_packed_refs(repo_path):
    # A fresh clone keeps its refs packed and none loose, so the reader
    # has to serve a branch listing with an empty refs/heads directory.
    make_branch(repo_path, "packed-one")
    pack_refs(repo_path)
    with mounted(repo_path) as ws:
        ws.register_cli("git", GIT)
        result = await ws.execute("git -C /repo branch")
    assert result.stdout == b"* main\n  packed-one\n"


@pytest.mark.asyncio
async def test_remotes_are_hidden_by_default(repo_path):
    add_remote(repo_path, "main", head_sha(repo_path))
    with mounted(repo_path) as ws:
        ws.register_cli("git", GIT)
        result = await ws.execute("git -C /repo branch")
    assert result.stdout == b"* main\n"


@pytest.mark.asyncio
async def test_all_lists_locals_then_remotes(repo_path):
    add_remote(repo_path, "main", head_sha(repo_path))
    with mounted(repo_path) as ws:
        ws.register_cli("git", GIT)
        result = await ws.execute("git -C /repo branch -a")
    assert result.stdout == b"* main\n  remotes/origin/main\n"


@pytest.mark.asyncio
async def test_remotes_only_drops_the_local_branches(repo_path):
    add_remote(repo_path, "main", head_sha(repo_path))
    with mounted(repo_path) as ws:
        ws.register_cli("git", GIT)
        result = await ws.execute("git -C /repo branch -r")
    assert result.stdout == b"  remotes/origin/main\n"


@pytest.mark.asyncio
async def test_a_symbolic_remote_ref_renders_its_target(repo_path):
    # refs/remotes/origin/HEAD is a pointer, not a branch, and git
    # renders it with the arrow rather than as another branch.
    add_remote(repo_path, "main", head_sha(repo_path))
    add_remote(repo_path, "HEAD", "ref: refs/remotes/origin/main")
    with mounted(repo_path) as ws:
        ws.register_cli("git", GIT)
        result = await ws.execute("git -C /repo branch -r")
    assert result.stdout == (b"  remotes/origin/HEAD -> origin/main\n"
                             b"  remotes/origin/main\n")


async def _run(ws, line: str) -> tuple[int, bytes, bytes]:
    """Run one git line against the mounted repository.

    Args:
        ws (Workspace): workspace with the repository and CLI.
        line (str): the command line, without the leading directory.
    """
    result = await ws.execute(f"git -C /repo {line}")
    return result.exit_code, result.stdout or b"", result.stderr or b""


@pytest.mark.asyncio
async def test_a_name_creates_a_branch(git_rw):
    assert await _run(git_rw, "branch feature") == (0, b"", b"")
    assert (await _run(git_rw, "branch"))[1] == b"  feature\n* main\n"


@pytest.mark.asyncio
async def test_a_branch_starts_where_it_was_told_to(git_rw, repo_path: Path):
    await _run(git_rw, "branch older HEAD~1")
    with Repo(str(repo_path)) as repo:
        parent = repo[repo.refs[b"refs/heads/main"]].parents[0]
        assert repo.refs[b"refs/heads/older"] == parent


@pytest.mark.asyncio
async def test_creating_a_branch_twice_is_refused(git_rw):
    await _run(git_rw, "branch feature")
    code, _out, err = await _run(git_rw, "branch feature")
    assert code == 128
    assert err == b"fatal: a branch named 'feature' already exists\n"


@pytest.mark.asyncio
async def test_deleting_says_what_it_removed(git_rw):
    await _run(git_rw, "branch feature")
    code, out, _err = await _run(git_rw, "branch -d feature")
    assert code == 0
    assert out.startswith(b"Deleted branch feature (was ")


@pytest.mark.asyncio
async def test_deleting_an_unmerged_branch_is_refused(git_rw):
    # The branch name is the only thing pointing at that commit, so -d
    # would be the command that loses it.
    await _run(git_rw, "checkout -b topic")
    await git_rw.execute("echo sideways > /repo/a.txt")
    await _run(git_rw, "add -A")
    await _run(git_rw, "commit -m sideways")
    await _run(git_rw, "checkout main")
    code, out, err = await _run(git_rw, "branch -d topic")
    assert code == 1
    assert out == b""
    assert err == (b"error: the branch 'topic' is not fully merged\n"
                   b"hint: If you are sure you want to delete it, run "
                   b"'git branch -D topic'\n")
    assert (await _run(git_rw, "branch"))[1] == b"* main\n  topic\n"


@pytest.mark.asyncio
async def test_force_deleting_an_unmerged_branch_removes_it(git_rw):
    await _run(git_rw, "checkout -b topic")
    await git_rw.execute("echo sideways > /repo/a.txt")
    await _run(git_rw, "add -A")
    await _run(git_rw, "commit -m sideways")
    await _run(git_rw, "checkout main")
    code, out, _err = await _run(git_rw, "branch -D topic")
    assert code == 0
    assert out.startswith(b"Deleted branch topic (was ")
    assert (await _run(git_rw, "branch"))[1] == b"* main\n"


@pytest.mark.asyncio
async def test_deleting_a_branch_behind_head_is_allowed(git_rw):
    # Merged does not mean equal: an ancestor of HEAD is contained in
    # it, so nothing is lost by dropping the name.
    await _run(git_rw, "branch older HEAD~1")
    code, out, _err = await _run(git_rw, "branch -d older")
    assert code == 0
    assert out.startswith(b"Deleted branch older (was ")


@pytest.mark.asyncio
async def test_deleting_a_branch_that_is_not_there(git_rw):
    code, _out, err = await _run(git_rw, "branch -d nosuch")
    assert code == 1
    assert err == b"error: branch 'nosuch' not found\n"


@pytest.mark.asyncio
async def test_the_checked_out_branch_cannot_be_deleted(git_rw):
    code, _out, err = await _run(git_rw, "branch -d main")
    assert code == 1
    assert b"cannot delete branch 'main' used by worktree" in err


@pytest.mark.asyncio
async def test_an_unknown_switch_is_not_read_as_a_branch_name(git_rw):
    # The operand slot would otherwise swallow it and try to make a
    # branch called -Z, which is how this broke once.
    code, _out, err = await _run(git_rw, "branch -Z")
    assert code == 129
    assert err == b"error: unknown switch `Z'\n"

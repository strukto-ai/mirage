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
from dulwich import porcelain
from dulwich.index import IndexEntry
from dulwich.objects import Blob
from dulwich.repo import Repo

from mirage.commands.cli.builtin.git import GIT
from mirage.commands.cli.builtin.git.status import parse_flags
from mirage.commands.cli.builtin.git.worktree import (
    UNTRACKED_ALL,
    UNTRACKED_NO,
    UNTRACKED_NORMAL,
)
from mirage.commands.spec.flag_view import FlagView
from mirage.types import MountMode
from mirage.vfs.disk import DiskVFS
from mirage.workspace import Workspace
from tests.commands.cli.builtin.git.conftest import commit_file

CLEAN = b"On branch main\nnothing to commit, working tree clean\n"


async def run(git_ws, line: str) -> bytes:
    """Run one git line against the mounted repository.

    Args:
        git_ws (Workspace): workspace with the repository and CLI.
        line (str): the command line, without the leading directory.
    """
    result = await git_ws.shell(f"git -C /repo {line}")
    assert result.exit_code == 0, result.stderr
    return result.stdout


@pytest.mark.asyncio
async def test_a_clean_tree_says_so(git_ws):
    assert await run(git_ws, "status") == CLEAN


@pytest.mark.asyncio
async def test_a_clean_tree_prints_nothing_in_porcelain(git_ws):
    assert await run(git_ws, "status --porcelain") == b""


@pytest.mark.asyncio
async def test_an_edited_file_is_unstaged(git_ws, repo_path: Path):
    (repo_path / "a.txt").write_text("edited\n", encoding="utf-8")
    assert await run(git_ws, "status --porcelain") == b" M a.txt\n"


@pytest.mark.asyncio
async def test_an_edit_of_the_same_length_is_still_found(
    git_ws, repo_path: Path
):
    # The size fast-path cannot see this one, so it is the case that
    # proves the content hash is actually consulted.
    original = (repo_path / "a.txt").read_text(encoding="utf-8")
    (repo_path / "a.txt").write_text(original.upper(), encoding="utf-8")
    assert await run(git_ws, "status --porcelain") == b" M a.txt\n"


@pytest.mark.asyncio
async def test_a_staged_edit_is_in_the_left_column(git_ws, repo_path: Path):
    (repo_path / "a.txt").write_text("edited\n", encoding="utf-8")
    porcelain.add(str(repo_path), paths=[str(repo_path / "a.txt")])
    assert await run(git_ws, "status --porcelain") == b"M  a.txt\n"


@pytest.mark.asyncio
async def test_staged_then_edited_again_fills_both_columns(
    git_ws, repo_path: Path
):
    (repo_path / "a.txt").write_text("staged\n", encoding="utf-8")
    porcelain.add(str(repo_path), paths=[str(repo_path / "a.txt")])
    (repo_path / "a.txt").write_text("and then some\n", encoding="utf-8")
    assert await run(git_ws, "status --porcelain") == b"MM a.txt\n"


@pytest.mark.asyncio
async def test_a_removed_file_is_a_deletion(git_ws, repo_path: Path):
    (repo_path / "b.txt").unlink()
    assert await run(git_ws, "status --porcelain") == b" D b.txt\n"


@pytest.mark.asyncio
async def test_a_deletion_widens_the_hint_to_name_rm(git_ws, repo_path: Path):
    (repo_path / "b.txt").unlink()
    assert b'(use "git add/rm <file>..."' in await run(git_ws, "status")


@pytest.mark.asyncio
async def test_a_new_file_is_untracked(git_ws, repo_path: Path):
    (repo_path / "fresh.txt").write_text("x\n", encoding="utf-8")
    assert await run(git_ws, "status --porcelain") == b"?? fresh.txt\n"


@pytest.mark.asyncio
async def test_an_untracked_directory_collapses_to_one_entry(
    git_ws, repo_path: Path
):
    (repo_path / "sub").mkdir()
    (repo_path / "sub" / "deep.txt").write_text("x\n", encoding="utf-8")
    assert await run(git_ws, "status --porcelain") == b"?? sub/\n"


@pytest.mark.asyncio
async def test_untracked_all_names_every_file_inside(git_ws, repo_path: Path):
    (repo_path / "sub").mkdir()
    (repo_path / "sub" / "deep.txt").write_text("x\n", encoding="utf-8")
    assert (
        await run(git_ws, "status --porcelain -uall") == b"?? sub/deep.txt\n"
    )


@pytest.mark.asyncio
async def test_untracked_no_leaves_them_out(git_ws, repo_path: Path):
    (repo_path / "fresh.txt").write_text("x\n", encoding="utf-8")
    assert await run(git_ws, "status --porcelain -uno") == b""


@pytest.mark.asyncio
async def test_an_empty_directory_is_invisible(git_ws, repo_path: Path):
    (repo_path / "hollow").mkdir()
    assert await run(git_ws, "status --porcelain") == b""


@pytest.mark.asyncio
async def test_an_ignored_file_is_not_untracked(git_ws, repo_path: Path):
    (repo_path / ".gitignore").write_text("*.log\n", encoding="utf-8")
    (repo_path / "noisy.log").write_text("x\n", encoding="utf-8")
    assert await run(git_ws, "status --porcelain") == b"?? .gitignore\n"


@pytest.mark.asyncio
async def test_a_tracked_file_under_an_ignored_directory_still_compares(
    git_ws, repo_path: Path
):
    # Ignore rules govern untracked files only. Skipping the directory
    # outright would report the tracked file inside it as deleted.
    (repo_path / "vendor").mkdir()
    (repo_path / "vendor" / "kept.txt").write_text("v\n", encoding="utf-8")
    porcelain.add(
        str(repo_path), paths=[str(repo_path / "vendor" / "kept.txt")]
    )
    (repo_path / ".gitignore").write_text("vendor/\n", encoding="utf-8")
    (repo_path / "vendor" / "kept.txt").write_text(
        "changed\n", encoding="utf-8"
    )
    lines = (await run(git_ws, "status --porcelain")).splitlines()
    assert b"AM vendor/kept.txt" in lines


@pytest.mark.asyncio
async def test_the_branch_line_is_opt_in(git_ws):
    assert await run(git_ws, "status --porcelain -b") == b"## main\n"


@pytest.mark.asyncio
async def test_short_reads_like_porcelain(git_ws, repo_path: Path):
    (repo_path / "a.txt").write_text("edited\n", encoding="utf-8")
    assert await run(git_ws, "status -s") == b" M a.txt\n"


@pytest.mark.asyncio
async def test_a_move_is_reported_as_a_rename(git_ws, repo_path: Path):
    (repo_path / "moved.txt").write_bytes((repo_path / "b.txt").read_bytes())
    (repo_path / "b.txt").unlink()
    porcelain.add(str(repo_path), paths=[str(repo_path / "moved.txt")])
    porcelain.remove(str(repo_path), paths=[str(repo_path / "b.txt")])
    assert (
        await run(git_ws, "status --porcelain") == b"R  b.txt -> moved.txt\n"
    )


@pytest.mark.asyncio
async def test_a_subdirectory_reads_paths_from_where_git_runs(
    git_ws, repo_path: Path
):
    # Pinned against git 2.54: the human formats name paths from the
    # invocation directory, so the untracked one git runs in is ./, and
    # porcelain stays relative to the top.
    (repo_path / "a.txt").write_text("edited\n", encoding="utf-8")
    (repo_path / "sub").mkdir()
    (repo_path / "sub" / "new.txt").write_text("x\n", encoding="utf-8")
    short = await git_ws.shell("git -C /repo/sub status --short")
    machine = await git_ws.shell("git -C /repo/sub status --porcelain")
    assert short.stdout == b" M ../a.txt\n?? ./\n"
    assert machine.stdout == b" M a.txt\n?? sub/\n"


def flags(**raw: object) -> FlagView:
    """A flag view over one raw kwarg bag.

    Args:
        raw (object): flag kwargs as the dispatcher would pass them.
    """
    return FlagView(raw)


def test_untracked_defaults_to_normal():
    assert parse_flags(flags()).untracked == UNTRACKED_NORMAL


def test_a_bare_u_means_all():
    assert parse_flags(flags(untracked_files=True)).untracked == UNTRACKED_ALL


def test_an_attached_mode_is_taken_as_typed():
    assert parse_flags(flags(untracked_files="no")).untracked == UNTRACKED_NO


@pytest.mark.asyncio
async def test_quote_path_off_prints_non_ascii_as_itself(
    git_ws, repo_path: Path
):
    (repo_path / "é.txt").write_text("x\n", encoding="utf-8")
    config = repo_path / ".git" / "config"
    config.write_text(config.read_text() + "[core]\n\tquotePath = false\n")
    assert await run(git_ws, "status --porcelain") == "?? é.txt\n".encode()


@pytest.mark.asyncio
async def test_a_bad_quote_path_value_is_gits_fatal(git_ws, repo_path: Path):
    config = repo_path / ".git" / "config"
    config.write_text(config.read_text() + "[core]\n\tquotePath = junk\n")
    result = await git_ws.shell("git -C /repo status")
    assert (result.exit_code, result.stderr) == (
        128,
        b"fatal: bad boolean config value 'junk' for 'core.quotepath'\n",
    )


@pytest.mark.asyncio
async def test_a_rename_from_a_hidden_path_reads_as_an_add(repo_path: Path):
    # The source and the destination are two rows: the hide drops the
    # source alone, so the session sees a file appear, and no format
    # names or counts the path it came from.
    with Workspace(
        {"/repo/": DiskVFS(root=str(repo_path))},
        mode=MountMode.WRITE,
        profiles={"veiled": {"paths": {"hide": ["/repo/a.txt"]}}},
    ) as ws:
        ws.register_cli("git", GIT)
        await ws.shell("git -C /repo mv a.txt moved.txt")
        ws.create_session("v", profile="veiled")
        lines = (
            "git -C /repo status --porcelain; "
            "git -C /repo diff --cached --stat; "
            "git -C /repo diff --cached --name-status"
        )
        veiled = await ws.shell(lines, session_id="v")
        assert veiled.stdout == (
            b"A  moved.txt\n"
            b" moved.txt | 1 +\n"
            b" 1 file changed, 1 insertion(+)\n"
            b"A\tmoved.txt\n"
        )
        full = await ws.shell(lines)
        assert full.stdout == (
            b"R  a.txt -> moved.txt\n"
            b" a.txt => moved.txt | 0\n"
            b" 1 file changed, 0 insertions(+), 0 deletions(-)\n"
            b"R100\ta.txt\tmoved.txt\n"
        )


@pytest.mark.asyncio
async def test_a_directory_whose_only_tracked_file_is_hidden_reads_as_untracked(
    repo_path: Path,
):
    # The walk collapses by the session's view of the index, so the
    # report has the shape a checkout of what the session sees has.
    (repo_path / "dir").mkdir()
    commit_file(repo_path, "dir/secret.txt", "s\n", "secret")
    (repo_path / "dir" / "new.txt").write_text("n\n", encoding="utf-8")
    with Workspace(
        {"/repo/": DiskVFS(root=str(repo_path))},
        mode=MountMode.WRITE,
        profiles={"veiled": {"paths": {"hide": ["/repo/dir/secret.txt"]}}},
    ) as ws:
        ws.register_cli("git", GIT)
        ws.create_session("v", profile="veiled")
        line = "git -C /repo status --porcelain"
        assert (await ws.shell(line, session_id="v")).stdout == b"?? dir/\n"
        assert (await ws.shell(line)).stdout == b"?? dir/new.txt\n"


@pytest.mark.asyncio
async def test_a_hide_matches_an_index_name_that_is_not_utf8(repo_path: Path):
    # The row names the path as its bytes spell it, so a hide written
    # with the surrogate escape still matches it.
    blob = Blob.from_string(b"x\n")
    with Repo(str(repo_path)) as repo:
        repo.object_store.add_object(blob)
        index = repo.open_index()
        index[b"\xff.txt"] = IndexEntry(
            ctime=0,
            mtime=0,
            dev=0,
            ino=0,
            mode=0o100644,
            uid=0,
            gid=0,
            size=2,
            sha=blob.id,
        )
        index.write()
    with Workspace(
        {"/repo/": DiskVFS(root=str(repo_path))},
        mode=MountMode.WRITE,
        profiles={"veiled": {"paths": {"hide": ["/repo/\udcff.txt"]}}},
    ) as ws:
        ws.register_cli("git", GIT)
        ws.create_session("v", profile="veiled")
        line = "git -C /repo status --porcelain"
        assert (await ws.shell(line, session_id="v")).stdout == b""
        assert (await ws.shell(line)).stdout == (b'AD "\\357\\277\\275.txt"\n')

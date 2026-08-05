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

from mirage.commands.cli.builtin.git.status import parse_flags
from mirage.commands.cli.builtin.git.worktree import (UNTRACKED_ALL,
                                                      UNTRACKED_NO,
                                                      UNTRACKED_NORMAL)
from mirage.commands.spec.types import FlagView

CLEAN = b"On branch main\nnothing to commit, working tree clean\n"


async def run(git_ws, line: str) -> bytes:
    """Run one git line against the mounted repository.

    Args:
        git_ws (Workspace): workspace with the repository and CLI.
        line (str): the command line, without the leading directory.
    """
    result = await git_ws.execute(f"git -C /repo {line}")
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
        git_ws, repo_path: Path):
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
        git_ws, repo_path: Path):
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
        git_ws, repo_path: Path):
    (repo_path / "sub").mkdir()
    (repo_path / "sub" / "deep.txt").write_text("x\n", encoding="utf-8")
    assert await run(git_ws, "status --porcelain") == b"?? sub/\n"


@pytest.mark.asyncio
async def test_untracked_all_names_every_file_inside(git_ws, repo_path: Path):
    (repo_path / "sub").mkdir()
    (repo_path / "sub" / "deep.txt").write_text("x\n", encoding="utf-8")
    assert await run(git_ws,
                     "status --porcelain -uall") == b"?? sub/deep.txt\n"


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
        git_ws, repo_path: Path):
    # Ignore rules govern untracked files only. Skipping the directory
    # outright would report the tracked file inside it as deleted.
    (repo_path / "vendor").mkdir()
    (repo_path / "vendor" / "kept.txt").write_text("v\n", encoding="utf-8")
    porcelain.add(str(repo_path),
                  paths=[str(repo_path / "vendor" / "kept.txt")])
    (repo_path / ".gitignore").write_text("vendor/\n", encoding="utf-8")
    (repo_path / "vendor" / "kept.txt").write_text("changed\n",
                                                   encoding="utf-8")
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
    assert await run(git_ws,
                     "status --porcelain") == b"R  b.txt -> moved.txt\n"


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

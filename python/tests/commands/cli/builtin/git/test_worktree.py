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

import functools
from pathlib import Path

import pytest

from mirage.commands.cli.builtin.git.types import RepoLocation
from mirage.commands.cli.builtin.git.worktree import (UNTRACKED_ALL,
                                                      UNTRACKED_NO,
                                                      UNTRACKED_NORMAL, scan,
                                                      tracked_directories)
from mirage.workspace.executor.builtins.links import path_stat

LOCATION = RepoLocation(gitdir="/repo/.git",
                        commondir="/repo/.git",
                        worktree="/repo",
                        mount_root="/repo/")
TRACKED = {"a.txt", "b.txt"}


async def walk(ws, tracked: set[str], mode: str = UNTRACKED_NORMAL):
    """Scan the mounted working tree.

    Args:
        ws (Workspace): workspace with the repository mounted.
        tracked (set[str]): paths to treat as held by the index.
        mode (str): which untracked files to report.
    """
    return await scan(ws.dispatch, functools.partial(path_stat, ws.dispatch),
                      LOCATION, tracked, mode)


def test_a_path_contributes_every_directory_above_it():
    assert tracked_directories({"a/b/c.txt"}) == {"a", "a/b"}


def test_a_root_level_path_contributes_no_directory():
    assert tracked_directories({"a.txt"}) == set()


@pytest.mark.asyncio
async def test_the_git_directory_is_never_walked(workspace):
    found = await walk(workspace, TRACKED)
    assert not any(path.startswith(".git") for path in found.files)
    assert not any(path.startswith(".git") for path in found.untracked)


@pytest.mark.asyncio
async def test_tracked_files_come_back_with_their_stat(workspace):
    found = await walk(workspace, TRACKED)
    assert found.files["a.txt"].size == len("one changed\n")


@pytest.mark.asyncio
async def test_a_file_the_index_does_not_hold_is_untracked(
        workspace, repo_path: Path):
    (repo_path / "fresh.txt").write_text("x\n", encoding="utf-8")
    found = await walk(workspace, TRACKED)
    assert found.untracked == ["fresh.txt"]


@pytest.mark.asyncio
async def test_an_untracked_directory_is_named_once(workspace,
                                                    repo_path: Path):
    (repo_path / "sub").mkdir()
    (repo_path / "sub" / "one.txt").write_text("x\n", encoding="utf-8")
    (repo_path / "sub" / "two.txt").write_text("y\n", encoding="utf-8")
    found = await walk(workspace, TRACKED)
    assert found.untracked == ["sub/"]


@pytest.mark.asyncio
async def test_untracked_all_descends_instead(workspace, repo_path: Path):
    (repo_path / "sub").mkdir()
    (repo_path / "sub" / "one.txt").write_text("x\n", encoding="utf-8")
    found = await walk(workspace, TRACKED, UNTRACKED_ALL)
    assert found.untracked == ["sub/one.txt"]


@pytest.mark.asyncio
async def test_untracked_no_reports_none_of_them(workspace, repo_path: Path):
    (repo_path / "sub").mkdir()
    (repo_path / "sub" / "one.txt").write_text("x\n", encoding="utf-8")
    found = await walk(workspace, TRACKED, UNTRACKED_NO)
    assert found.untracked == []


@pytest.mark.asyncio
async def test_a_directory_holding_a_tracked_file_is_descended_into(
        workspace, repo_path: Path):
    (repo_path / "src").mkdir()
    (repo_path / "src" / "tracked.txt").write_text("t\n", encoding="utf-8")
    (repo_path / "src" / "loose.txt").write_text("l\n", encoding="utf-8")
    found = await walk(workspace, TRACKED | {"src/tracked.txt"})
    assert found.untracked == ["src/loose.txt"]


@pytest.mark.asyncio
async def test_an_empty_directory_is_invisible(workspace, repo_path: Path):
    # git tracks no directories, so one holding nothing has nothing to
    # report and is not mentioned at all.
    (repo_path / "hollow").mkdir()
    found = await walk(workspace, TRACKED)
    assert found.untracked == []


@pytest.mark.asyncio
async def test_a_directory_of_only_ignored_files_is_invisible_too(
        workspace, repo_path: Path):
    (repo_path / ".gitignore").write_text("*.log\n", encoding="utf-8")
    (repo_path / "logs").mkdir()
    (repo_path / "logs" / "a.log").write_text("x\n", encoding="utf-8")
    found = await walk(workspace, TRACKED)
    assert found.untracked == [".gitignore"]


@pytest.mark.asyncio
async def test_an_ignored_directory_holding_a_tracked_file_is_still_walked(
        workspace, repo_path: Path):
    # Ignore rules govern untracked files only. Skipping the directory
    # would leave the tracked file unfound and reported as deleted.
    (repo_path / ".gitignore").write_text("vendor/\n", encoding="utf-8")
    (repo_path / "vendor").mkdir()
    (repo_path / "vendor" / "kept.txt").write_text("v\n", encoding="utf-8")
    (repo_path / "vendor" / "junk.txt").write_text("j\n", encoding="utf-8")
    found = await walk(workspace, TRACKED | {"vendor/kept.txt"})
    assert "vendor/kept.txt" in found.files
    assert "vendor/junk.txt" not in found.untracked

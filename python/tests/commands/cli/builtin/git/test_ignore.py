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

from mirage.commands.cli.builtin.git.ignore import IgnoreStack, load_ignores
from mirage.commands.cli.builtin.git.types import RepoLocation

EMPTY = IgnoreStack([])


def test_nothing_is_ignored_without_a_file():
    assert not EMPTY.is_ignored("anything.txt")


def test_a_glob_catches_what_it_names():
    stack = EMPTY.push("", b"*.log\n")
    assert stack.is_ignored("noisy.log")
    assert not stack.is_ignored("quiet.txt")


def test_a_directory_pattern_needs_a_directory():
    stack = EMPTY.push("", b"build/\n")
    assert stack.is_ignored("build", is_dir=True)
    assert not stack.is_ignored("build", is_dir=False)


def test_a_bang_line_takes_something_back():
    stack = EMPTY.push("", b"*.log\n!keep.log\n")
    assert stack.is_ignored("drop.log")
    assert not stack.is_ignored("keep.log")


def test_a_deeper_file_overrides_a_shallower_one():
    # Precedence runs the opposite way to the stack: the innermost
    # .gitignore decides, whatever the root said.
    stack = EMPTY.push("", b"*.log\n").push("docs", b"!*.log\n")
    assert stack.is_ignored("top.log")
    assert not stack.is_ignored("docs/keep.log")


def test_a_deeper_file_names_paths_from_its_own_directory():
    # The pattern is `notes.txt`, not `docs/notes.txt`; reading it
    # against the repository root would match nothing.
    stack = EMPTY.push("docs", b"notes.txt\n")
    assert stack.is_ignored("docs/notes.txt")


def test_pushing_leaves_the_original_alone():
    # The walk hands each subdirectory its own stack, so a push must not
    # reach the parent's copy or the rules would outlive the directory.
    outer = EMPTY.push("", b"*.log\n")
    outer.push("docs", b"*.txt\n")
    assert not outer.is_ignored("docs/notes.txt")


@pytest.mark.asyncio
async def test_both_repository_files_are_read(workspace, repo_path: Path):
    (repo_path / ".gitignore").write_text("*.log\n", encoding="utf-8")
    info = repo_path / ".git" / "info"
    info.mkdir(exist_ok=True)
    (info / "exclude").write_text("*.tmp\n", encoding="utf-8")
    stack = await load_ignores(workspace.dispatch, "/repo/.git", "/repo")
    assert stack.is_ignored("a.log")
    assert stack.is_ignored("a.tmp")


@pytest.mark.asyncio
async def test_a_tracked_gitignore_overrides_the_private_list(
        workspace, repo_path: Path):
    info = repo_path / ".git" / "info"
    info.mkdir(exist_ok=True)
    (info / "exclude").write_text("*.log\n", encoding="utf-8")
    (repo_path / ".gitignore").write_text("!keep.log\n", encoding="utf-8")
    stack = await load_ignores(workspace.dispatch, "/repo/.git", "/repo")
    assert not stack.is_ignored("keep.log")


@pytest.mark.asyncio
async def test_a_repository_with_neither_file_ignores_nothing(workspace):
    stack = await load_ignores(workspace.dispatch, "/repo/.git", "/repo")
    assert not stack.is_ignored("whatever.log")


def test_a_location_carries_the_two_directories_apart():
    # The ignore stack reads the private list from the git directory and
    # the tracked one from the working tree, which are not the same
    # place for a linked worktree.
    location = RepoLocation(gitdir="/repo/.git/worktrees/w",
                            commondir="/repo/.git",
                            worktree="/work",
                            mount_root="/")
    assert location.gitdir != location.worktree

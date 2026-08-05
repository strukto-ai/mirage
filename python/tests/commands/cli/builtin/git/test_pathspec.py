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

import pytest

from mirage.commands.cli.builtin.git.errors import OutsideRepositoryError
from mirage.commands.cli.builtin.git.pathspec import (absolute_operand,
                                                      matched, repo_relative,
                                                      under)
from mirage.commands.cli.builtin.git.types import RepoLocation

LOCATION = RepoLocation(gitdir="/repo/.git",
                        commondir="/repo/.git",
                        worktree="/repo",
                        mount_root="/repo/")


def test_a_relative_operand_resolves_against_the_run_directory():
    # `-C` moves before anything else happens, so a pathspec is read
    # from where git ended up, not from where the shell is.
    assert absolute_operand("/repo/docs", "notes.md") == "/repo/docs/notes.md"


def test_an_absolute_operand_is_taken_as_given():
    assert absolute_operand("/repo/docs", "/repo/a.txt") == "/repo/a.txt"


def test_dot_segments_are_flattened():
    assert absolute_operand("/repo/docs", "../a.txt") == "/repo/a.txt"


def test_a_path_inside_the_tree_becomes_relative():
    assert repo_relative(LOCATION, "/repo", "docs/notes.md") == \
        "docs/notes.md"


def test_the_tree_root_itself_is_the_empty_path():
    # What `git add .` from the top resolves to, and it means everything.
    assert repo_relative(LOCATION, "/repo", ".") == ""


def test_a_path_outside_the_tree_is_refused():
    with pytest.raises(OutsideRepositoryError):
        repo_relative(LOCATION, "/repo", "/elsewhere/a.txt")


def test_a_run_directory_below_the_root_still_resolves():
    assert repo_relative(LOCATION, "/repo/docs", "notes.md") == \
        "docs/notes.md"


def test_everything_is_under_the_root():
    assert under("docs/notes.md", "")


def test_a_sibling_is_not_under_a_directory():
    assert not under("documents/a.txt", "docs")


def test_a_child_is_under_its_directory():
    assert under("docs/a.txt", "docs")


def test_an_exact_file_selects_only_itself():
    assert matched({"a.txt", "a.txt.bak"}, "a.txt") == {"a.txt"}


def test_a_directory_selects_its_whole_subtree():
    paths = {"docs/a.md", "docs/deep/b.md", "other.txt"}
    assert matched(paths, "docs") == {"docs/a.md", "docs/deep/b.md"}


def test_the_root_selects_everything():
    paths = {"a.txt", "docs/b.md"}
    assert matched(paths, "") == paths

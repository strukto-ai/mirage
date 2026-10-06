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

from mirage.commands.cli.builtin.git.errors import (
    EmptyPathspecError,
    OutsideRepositoryError,
    UnsupportedPathspecError,
)
from mirage.commands.cli.builtin.git.pathspec import (
    absolute_operand,
    matched,
    pathspec_patterns,
    pathspec_selects,
    repo_relative,
    under,
)
from mirage.commands.cli.builtin.git.types import RepoLocation
from mirage.utils.path import typed_spec

LOCATION = RepoLocation(
    gitdir=typed_spec("/repo/.git", "/"),
    commondir=typed_spec("/repo/.git", "/"),
    worktree=typed_spec("/repo", "/"),
    mount_root=typed_spec("/repo/", "/"),
)


def test_a_relative_operand_resolves_against_the_run_directory():
    # `-C` moves before anything else happens, so a pathspec is read
    # from where git ended up, not from where the shell is.
    assert absolute_operand("/repo/docs", "notes.md") == "/repo/docs/notes.md"


def test_an_absolute_operand_is_taken_as_given():
    assert absolute_operand("/repo/docs", "/repo/a.txt") == "/repo/a.txt"


def test_dot_segments_are_flattened():
    assert absolute_operand("/repo/docs", "../a.txt") == "/repo/a.txt"


def test_a_path_inside_the_tree_becomes_relative():
    assert repo_relative(LOCATION, "/repo", "docs/notes.md") == "docs/notes.md"


def test_the_tree_root_itself_is_the_empty_path():
    # What `git add .` from the top resolves to, and it means everything.
    assert repo_relative(LOCATION, "/repo", ".") == ""


def test_a_path_outside_the_tree_is_refused():
    with pytest.raises(OutsideRepositoryError):
        repo_relative(LOCATION, "/repo", "/elsewhere/a.txt")


def test_a_run_directory_below_the_root_still_resolves():
    assert repo_relative(LOCATION, "/repo/docs", "notes.md") == "docs/notes.md"


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


def test_a_name_that_is_both_a_file_and_a_directory_selects_both():
    paths = {"slot", "slot/child", "other"}
    assert matched(paths, "slot") == {"slot", "slot/child"}


@pytest.mark.parametrize(
    "path,patterns,expected",
    [
        ("docs/a.md", [""], True),
        ("docs/a.md", ["docs"], True),
        ("docs/a.md", ["doc"], False),
        ("docs/a.md", ["docs/a.md"], True),
        ("docs/sub/a.md", ["*.md"], True),
        ("docs/a.md", ["docs/*.txt", "*.md"], True),
        ("a.txt", ["docs"], False),
    ],
)
def test_a_pathspec_names_a_path_a_directory_or_a_glob(
    path, patterns, expected
):
    assert pathspec_selects(path, patterns) is expected


@pytest.mark.parametrize(
    "operand,error",
    [
        ("", EmptyPathspecError),
        (":(top)a.txt", UnsupportedPathspecError),
        (":!a.txt", UnsupportedPathspecError),
        ("/elsewhere/a.txt", OutsideRepositoryError),
    ],
)
def test_a_pathspec_git_refuses_or_this_build_lacks_is_refused(operand, error):
    with pytest.raises(error):
        pathspec_patterns(LOCATION, "/repo", [operand])

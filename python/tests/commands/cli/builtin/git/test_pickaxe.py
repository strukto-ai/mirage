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
from dulwich.objects import Commit
from dulwich.repo import Repo

from mirage.commands.cli.builtin.git.diff_output import (
    RENAME_SCORE,
    DiffFlags,
    shows,
)
from mirage.commands.cli.builtin.git.pickaxe import Pickaxe, contains
from mirage.rs.regex import PosixRegex
from tests.commands.cli.builtin.git.conftest import (
    AUTHOR,
    commit_file,
    commit_gitlink,
)


def touches(repo: Repo, commit: Commit, needle: bytes) -> bool:
    """Whether ``-S`` keeps a commit, its diff read without renames.

    Args:
        repo (Repo): the repository.
        commit (Commit): the commit.
        needle (bytes): the string.
    """
    return shows(repo, commit, DiffFlags(pickaxe=Pickaxe(needle=needle)))


def greps(repo: Repo, commit: Commit, pattern: PosixRegex) -> bool:
    """Whether ``-G`` keeps a commit.

    Args:
        repo (Repo): the repository.
        commit (Commit): the commit.
        pattern (PosixRegex): the pattern.
    """
    return shows(repo, commit, DiffFlags(pickaxe=Pickaxe(changed=pattern)))


def commits_of(repo_path: Path) -> list[Commit]:
    """Every commit on the current branch, newest first.

    Args:
        repo_path (Path): the repository's working tree.
    """
    with Repo(str(repo_path)) as repo:
        found = []
        sha = repo.refs[b"HEAD"]
        while True:
            commit = repo[sha]
            assert isinstance(commit, Commit)
            found.append(commit)
            if not commit.parents:
                return found
            sha = commit.parents[0]


def test_a_root_commit_introduces_everything_it_adds(repo_path):
    with Repo(str(repo_path)) as repo:
        root = commits_of(repo_path)[-1]
        assert touches(repo, root, b"one")


def test_a_commit_that_adds_the_string_is_reported(repo_path):
    commit_file(repo_path, "c.txt", "needle here\n", "fourth")
    with Repo(str(repo_path)) as repo:
        head = commits_of(repo_path)[0]
        assert touches(repo, head, b"needle")


def test_a_commit_that_removes_the_string_is_reported(repo_path):
    commit_file(repo_path, "c.txt", "needle here\n", "fourth")
    commit_file(repo_path, "c.txt", "gone\n", "fifth")
    with Repo(str(repo_path)) as repo:
        head = commits_of(repo_path)[0]
        assert touches(repo, head, b"needle")


def test_a_commit_that_leaves_the_count_alone_is_not_reported(repo_path):
    # The whole point of -S: the third fixture commit rewrites a.txt
    # from "one" to "one changed", so the string "one" still occurs
    # exactly once and the commit is NOT a match. A grep would report it.
    with Repo(str(repo_path)) as repo:
        third = commits_of(repo_path)[0]
        assert not touches(repo, third, b"one")


def test_moving_a_line_between_files_is_reported(repo_path):
    # The count -S watches is per file, not per repository, so a line
    # moving from a.txt to b.txt changes both counts and does match.
    # Verified against git 2.50.1 on this exact shape: both the root
    # commit and the moving commit are listed.
    (repo_path / "a.txt").write_text("moved\n", encoding="utf-8")
    (repo_path / "b.txt").write_text("one changed\n", encoding="utf-8")
    porcelain.add(
        str(repo_path),
        paths=[str(repo_path / "a.txt"), str(repo_path / "b.txt")],
    )
    porcelain.commit(
        str(repo_path),
        message=b"moved the line",
        author=AUTHOR,
        committer=AUTHOR,
    )
    with Repo(str(repo_path)) as repo:
        head = commits_of(repo_path)[0]
        assert touches(repo, head, b"one changed")


def test_a_rename_that_keeps_the_count_is_not_reported(repo_path):
    # git pairs renames before it counts, so moving a file that holds the
    # string is no match, while the same move read as a delete and an
    # add is (git 2.47.3).
    (repo_path / "a.txt").rename(repo_path / "moved.txt")
    porcelain.add(str(repo_path), paths=[str(repo_path / "moved.txt")])
    porcelain.remove(
        str(repo_path), paths=[str(repo_path / "a.txt")], cached=True
    )
    porcelain.commit(
        str(repo_path), message=b"move", author=AUTHOR, committer=AUTHOR
    )
    with Repo(str(repo_path)) as repo:
        head = commits_of(repo_path)[0]
        renamed = DiffFlags(
            renames=RENAME_SCORE, pickaxe=Pickaxe(needle=b"one changed")
        )
        assert not shows(repo, head, renamed)
        assert touches(repo, head, b"one changed")


def test_a_commit_touching_nothing_relevant_is_not_reported(repo_path):
    with Repo(str(repo_path)) as repo:
        second = commits_of(repo_path)[1]
        assert not touches(repo, second, b"absent-string")


# git 2.47 on debian:stable-slim lists a commit under -S PATTERN
# --pickaxe-regex when the count changes: a blank line counts, and ^ never
# holds where a search resumes after an empty match, so a third blank line
# in a row goes unseen.
@pytest.mark.parametrize(
    "old,new,pattern,listed",
    [
        ("a\n", "a\n\nb\n", "^$", True),
        ("a\n\nb\n", "a\n\nc\n", "^$", False),
        ("a\n\nc\n", "a\n\n\nc\n", "^$", False),
        ("a\n\n\nc\n", "a\n\n\n\nc\n", "^$", True),
        ("x", "", "$", True),
        ("ab\nab\n", "ab\nab\nab", "^", False),
        ("ab\nab\n", "ab\nab\nab", "$", True),
        ("a\n\nc\n", "a\n\n\nc\n", "b*", True),
    ],
)
def test_contains_counts_as_git_does(old, new, pattern, listed):
    regex = PosixRegex(pattern, True, utf8=True, multiline=True)
    assert (contains(old, regex) != contains(new, regex)) is listed


def test_contains_steps_over_a_whole_character_past_an_empty_match():
    regex = PosixRegex("x*", True, utf8=True, multiline=True)
    assert contains("😀😀", regex) == 2


def test_a_gitlink_is_read_as_its_subproject_line(repo_path):
    # git's pickaxe fills a gitlink side with "Subproject commit <id>",
    # the text its patch prints, rather than reading the id as a blob.
    with Repo(str(repo_path)) as repo:
        target = repo.refs[b"HEAD"]
    commit_gitlink(repo_path, "sub")
    with Repo(str(repo_path)) as repo:
        head = commits_of(repo_path)[0]
        assert touches(repo, head, b"Subproject commit " + target)
        assert greps(repo, head, PosixRegex("^Subproject commit", True))
        assert not touches(repo, head, b"absent-string")

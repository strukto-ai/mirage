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

from dulwich import porcelain
from dulwich.objects import Commit
from dulwich.repo import Repo

from mirage.commands.cli.builtin.git.pickaxe import touches
from tests.commands.cli.builtin.git.conftest import AUTHOR, commit_file


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
        assert touches(repo.object_store, root, b"one")


def test_a_commit_that_adds_the_string_is_reported(repo_path):
    commit_file(repo_path, "c.txt", "needle here\n", "fourth")
    with Repo(str(repo_path)) as repo:
        head = commits_of(repo_path)[0]
        assert touches(repo.object_store, head, b"needle")


def test_a_commit_that_removes_the_string_is_reported(repo_path):
    commit_file(repo_path, "c.txt", "needle here\n", "fourth")
    commit_file(repo_path, "c.txt", "gone\n", "fifth")
    with Repo(str(repo_path)) as repo:
        head = commits_of(repo_path)[0]
        assert touches(repo.object_store, head, b"needle")


def test_a_commit_that_leaves_the_count_alone_is_not_reported(repo_path):
    # The whole point of -S: the third fixture commit rewrites a.txt
    # from "one" to "one changed", so the string "one" still occurs
    # exactly once and the commit is NOT a match. A grep would report it.
    with Repo(str(repo_path)) as repo:
        third = commits_of(repo_path)[0]
        assert not touches(repo.object_store, third, b"one")


def test_moving_a_line_between_files_is_reported(repo_path):
    # The count -S watches is per file, not per repository, so a line
    # moving from a.txt to b.txt changes both counts and does match.
    # Verified against git 2.50.1 on this exact shape: both the root
    # commit and the moving commit are listed.
    (repo_path / "a.txt").write_text("moved\n", encoding="utf-8")
    (repo_path / "b.txt").write_text("one changed\n", encoding="utf-8")
    porcelain.add(str(repo_path),
                  paths=[str(repo_path / "a.txt"),
                         str(repo_path / "b.txt")])
    porcelain.commit(str(repo_path),
                     message=b"moved the line",
                     author=AUTHOR,
                     committer=AUTHOR)
    with Repo(str(repo_path)) as repo:
        head = commits_of(repo_path)[0]
        assert touches(repo.object_store, head, b"one changed")


def test_a_commit_touching_nothing_relevant_is_not_reported(repo_path):
    with Repo(str(repo_path)) as repo:
        second = commits_of(repo_path)[1]
        assert not touches(repo.object_store, second, b"absent-string")

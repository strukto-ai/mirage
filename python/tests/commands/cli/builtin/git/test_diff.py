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

import asyncio
import shlex
import subprocess
from pathlib import Path

import pytest


@pytest.mark.asyncio
async def test_two_revisions_diff_against_each_other(git_ws):
    result = await git_ws.shell("git -C /repo diff HEAD~1 HEAD")
    text = result.stdout.decode()
    assert result.exit_code == 0
    assert "diff --git a/a.txt b/a.txt" in text
    assert "-one" in text
    assert "+one changed" in text


@pytest.mark.asyncio
async def test_one_revision_diffs_it_against_head(git_ws):
    result = await git_ws.shell("git -C /repo diff HEAD~1")
    assert result.exit_code == 0
    assert "+one changed" in result.stdout.decode()


@pytest.mark.asyncio
async def test_a_revision_against_itself_prints_nothing(git_ws):
    result = await git_ws.shell("git -C /repo diff HEAD HEAD")
    assert result.exit_code == 0
    assert result.stdout == b""


@pytest.mark.asyncio
async def test_no_operand_prints_nothing_yet(git_ws):
    # Comparing against the working tree needs the index and a worktree
    # scan, neither of which exists. Until then a bare `git diff` is
    # silent rather than wrong.
    result = await git_ws.shell("git -C /repo diff")
    assert result.exit_code == 0
    assert result.stdout == b""


@pytest.mark.asyncio
async def test_a_file_added_between_two_revisions_shows_as_new(git_ws):
    result = await git_ws.shell("git -C /repo diff HEAD~2 HEAD~1")
    text = result.stdout.decode()
    assert "diff --git a/b.txt b/b.txt" in text
    assert "new file mode" in text
    assert "+two" in text


@pytest.mark.asyncio
async def test_the_older_side_may_be_named_second(git_ws):
    # Argument order decides direction, so this is the reverse patch.
    result = await git_ws.shell("git -C /repo diff HEAD HEAD~1")
    text = result.stdout.decode()
    assert "-one changed" in text
    assert "+one" in text


@pytest.mark.asyncio
async def test_an_unknown_revision_is_a_fatal(git_ws):
    result = await git_ws.shell("git -C /repo diff nope HEAD")
    assert result.exit_code == 128
    assert result.stderr.startswith(b"fatal: ambiguous argument 'nope'")


@pytest.mark.asyncio
async def test_an_unreadable_work_tree_file_is_refused_in_git_words(
    git_rw, repo_path: Path
):
    (repo_path / "a.txt").write_text("new\n", encoding="utf-8")
    await git_rw.set_session_profile(
        git_rw.default_session_id,
        {
            "commands": {
                "deny": [{"reason": "sealed", "paths": ["/repo/a.txt"]}]
            }
        },
    )
    result = await git_rw.shell("git -C /repo diff")
    assert result.exit_code == 128
    assert result.stderr == (
        b'error: open("a.txt"): Permission denied\nfatal: cannot hash a.txt\n'
    )


COMMITTER = {
    "GIT_AUTHOR_NAME": "Ada",
    "GIT_AUTHOR_EMAIL": "ada@example.com",
    "GIT_COMMITTER_NAME": "Ada",
    "GIT_COMMITTER_EMAIL": "ada@example.com",
}


async def native(repo_path, line):
    """Run real git in the repository.

    Args:
        repo_path (Path): the working tree.
        line (str): the words after ``git``.
    """
    return await asyncio.to_thread(
        subprocess.run,
        ["git", "-C", str(repo_path), *shlex.split(line)],
        capture_output=True,
        env=COMMITTER,
    )


async def conflicted(repo_path):
    """Stop a real merge of ``side`` on a conflict in ``a.txt``.

    Args:
        repo_path (Path): the working tree.
    """
    await native(repo_path, "checkout -q -b side HEAD~1")
    (repo_path / "a.txt").write_text("one side\n", encoding="utf-8")
    await native(repo_path, "commit -q -am side")
    await native(repo_path, "checkout -q main")
    await native(repo_path, "merge -q side")


async def assert_matches_git(ws, repo_path, command):
    """Compare a Mirage run with real git's.

    Args:
        ws (Workspace): the workspace mounting the repository.
        repo_path (Path): the working tree.
        command (str): the words after ``git``.
    """
    expected = await native(repo_path, command)
    actual = await ws.shell("git -C /repo " + command)
    assert (actual.exit_code, actual.stdout or b"", actual.stderr or b"") == (
        expected.returncode,
        expected.stdout,
        expected.stderr,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command",
    [
        "diff-files",
        "diff-files --name-status",
        "diff-files --stat",
        "diff-files --numstat",
        "diff-files -p",
    ],
)
async def test_diff_files_on_a_conflict_matches_git(
    git_ws, repo_path, command
):
    await conflicted(repo_path)
    await assert_matches_git(git_ws, repo_path, command)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command",
    [
        "diff-tree -c HEAD",
        "diff-tree --cc HEAD",
        "diff-tree -c --full-index HEAD",
        "diff-tree -c --diff-filter=M HEAD",
        "diff-tree -c --diff-filter=A HEAD",
        "diff-tree -c --diff-filter=m HEAD",
        "show --format= --cc --no-prefix HEAD",
        "show --format= --cc --full-index HEAD",
    ],
)
async def test_a_resolved_merge_matches_git(git_ws, repo_path, command):
    await conflicted(repo_path)
    (repo_path / "a.txt").write_text("resolved\n", encoding="utf-8")
    await native(repo_path, "add a.txt")
    await native(repo_path, "commit -q -m merge")
    await assert_matches_git(git_ws, repo_path, command)

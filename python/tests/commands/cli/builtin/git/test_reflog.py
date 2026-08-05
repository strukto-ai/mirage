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

from mirage.commands.cli.builtin.git.reflog import ZERO, entry, record

WHO = b"Test Author <test@example.com>"
OLD = b"1" * 40
NEW = b"2" * 40


def test_a_line_carries_both_ids_then_the_identity():
    line = entry(OLD, NEW, WHO, 1700000000, "commit: a change")
    assert line.startswith(OLD + b" " + NEW + b" " + WHO)


def test_the_message_is_separated_by_a_tab():
    # Load-bearing: the message may itself contain spaces, so the tab is
    # what tells a reader where the fixed fields stop.
    line = entry(OLD, NEW, WHO, 1700000000, "commit: two words")
    assert line.endswith(b"\tcommit: two words\n")


def test_a_first_entry_names_no_predecessor():
    line = entry(ZERO, NEW, WHO, 1700000000, "commit (initial): first")
    assert line.startswith(b"0" * 40)


def lines(repo_path: Path, *parts: str) -> list[bytes]:
    """One log's lines, empty when it does not exist yet.

    The fixture repository was built by making commits, so both logs
    already have entries in them: what these assert is the delta.

    Args:
        repo_path (Path): the repository's working tree.
        parts (str): path segments below ``.git``.
    """
    path = repo_path.joinpath(".git", *parts)
    return path.read_bytes().splitlines() if path.exists() else []


@pytest.mark.asyncio
async def test_both_logs_gain_the_same_line_when_head_is_on_a_branch(
        git_rw, repo_path: Path):
    await record(git_rw.dispatch, "/repo/.git", "refs/heads/main", OLD, NEW,
                 WHO, 1700000000, "commit: recorded")
    head = lines(repo_path, "logs", "HEAD")
    branch = lines(repo_path, "logs", "refs", "heads", "main")
    assert head[-1] == branch[-1]
    assert head[-1].endswith(b"\tcommit: recorded")


@pytest.mark.asyncio
async def test_a_detached_head_leaves_the_branch_log_alone(
        git_rw, repo_path: Path):
    before = lines(repo_path, "logs", "refs", "heads", "main")
    await record(git_rw.dispatch, "/repo/.git", None, OLD, NEW, WHO,
                 1700000000, "checkout: moving from main to abc1234")
    assert lines(repo_path, "logs", "refs", "heads", "main") == before
    assert lines(
        repo_path, "logs",
        "HEAD")[-1].endswith(b"\tcheckout: moving from main to abc1234")


@pytest.mark.asyncio
async def test_entries_accumulate_rather_than_replace(git_rw, repo_path: Path):
    before = len(lines(repo_path, "logs", "HEAD"))
    await record(git_rw.dispatch, "/repo/.git", None, OLD, NEW, WHO,
                 1700000000, "first")
    await record(git_rw.dispatch, "/repo/.git", None, NEW, OLD, WHO,
                 1700000001, "second")
    assert len(lines(repo_path, "logs", "HEAD")) == before + 2

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

from mirage.commands.cli.builtin.git import GIT
from tests.commands.cli.builtin.git.conftest import (commit_merge, make_branch,
                                                     mounted)


@pytest.mark.asyncio
async def test_no_operand_shows_head(git_ws):
    result = await git_ws.execute("git -C /repo show")
    assert result.exit_code == 0
    assert "    third" in result.stdout.decode()


@pytest.mark.asyncio
async def test_the_header_block_comes_before_the_patch(git_ws):
    result = await git_ws.execute("git -C /repo show HEAD")
    lines = result.stdout.decode().split("\n")
    assert lines[0].startswith("commit ")
    assert lines[1] == "Author: Test Author <test@example.com>"
    assert lines[2].startswith("Date:   ")
    assert lines[3] == ""
    assert lines[4] == "    third"


@pytest.mark.asyncio
async def test_the_patch_shows_what_the_commit_changed(git_ws):
    result = await git_ws.execute("git -C /repo show HEAD")
    text = result.stdout.decode()
    assert "diff --git a/a.txt b/a.txt" in text
    assert "-one" in text
    assert "+one changed" in text


@pytest.mark.asyncio
async def test_an_ancestry_suffix_walks_back(git_ws):
    result = await git_ws.execute("git -C /repo show HEAD~2")
    assert "    first" in result.stdout.decode()


@pytest.mark.asyncio
async def test_a_root_commit_diffs_against_nothing(git_ws):
    # No parent, so every file it adds is new. The patch must still
    # render rather than fall over looking for a parent tree.
    result = await git_ws.execute("git -C /repo show HEAD~2")
    text = result.stdout.decode()
    assert result.exit_code == 0
    assert "new file mode" in text
    assert "+one" in text


@pytest.mark.asyncio
async def test_a_commit_id_operand_resolves(git_ws):
    listing = await git_ws.execute("git -C /repo log --oneline -n 1")
    short = listing.stdout.decode().split(" ", 1)[0]
    result = await git_ws.execute(f"git -C /repo show {short}")
    assert result.exit_code == 0
    assert "    third" in result.stdout.decode()


@pytest.mark.asyncio
async def test_an_unknown_revision_is_a_fatal(git_ws):
    result = await git_ws.execute("git -C /repo show nope")
    assert result.exit_code == 128
    assert result.stderr.startswith(b"fatal: ambiguous argument 'nope'")


@pytest.mark.asyncio
async def test_walking_off_the_end_of_history_is_a_fatal(git_ws):
    result = await git_ws.execute("git -C /repo show HEAD~9")
    assert result.exit_code == 128
    assert b"unknown revision" in result.stderr


@pytest.mark.asyncio
async def test_a_merge_names_its_parents(repo_path):
    make_branch(repo_path, "side")
    commit_merge(repo_path, "side", "merge side")
    with mounted(repo_path) as ws:
        ws.register_cli("git", GIT)
        result = await ws.execute("git -C /repo show HEAD")
    lines = result.stdout.decode().split("\n")
    assert lines[0].startswith("commit ")
    assert lines[1].startswith("Merge: ")
    parents = lines[1].removeprefix("Merge: ").split(" ")
    assert len(parents) == 2
    assert all(len(p) == 7 for p in parents)


@pytest.mark.asyncio
async def test_a_merge_shows_no_patch(repo_path):
    # git renders a merge as a combined diff against every parent, which
    # is empty whenever the result matches one of them. Showing a
    # first-parent patch here would print something git never does.
    make_branch(repo_path, "side")
    commit_merge(repo_path, "side", "merge side")
    with mounted(repo_path) as ws:
        ws.register_cli("git", GIT)
        result = await ws.execute("git -C /repo show HEAD")
    assert result.exit_code == 0
    assert b"diff --git" not in result.stdout
    assert result.stdout.rstrip(b"\n").endswith(b"    merge side")

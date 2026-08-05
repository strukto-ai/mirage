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


@pytest.mark.asyncio
async def test_two_revisions_diff_against_each_other(git_ws):
    result = await git_ws.execute("git -C /repo diff HEAD~1 HEAD")
    text = result.stdout.decode()
    assert result.exit_code == 0
    assert "diff --git a/a.txt b/a.txt" in text
    assert "-one" in text
    assert "+one changed" in text


@pytest.mark.asyncio
async def test_one_revision_diffs_it_against_head(git_ws):
    result = await git_ws.execute("git -C /repo diff HEAD~1")
    assert result.exit_code == 0
    assert "+one changed" in result.stdout.decode()


@pytest.mark.asyncio
async def test_a_revision_against_itself_prints_nothing(git_ws):
    result = await git_ws.execute("git -C /repo diff HEAD HEAD")
    assert result.exit_code == 0
    assert result.stdout == b""


@pytest.mark.asyncio
async def test_no_operand_prints_nothing_yet(git_ws):
    # Comparing against the working tree needs the index and a worktree
    # scan, neither of which exists. Until then a bare `git diff` is
    # silent rather than wrong.
    result = await git_ws.execute("git -C /repo diff")
    assert result.exit_code == 0
    assert result.stdout == b""


@pytest.mark.asyncio
async def test_a_file_added_between_two_revisions_shows_as_new(git_ws):
    result = await git_ws.execute("git -C /repo diff HEAD~2 HEAD~1")
    text = result.stdout.decode()
    assert "diff --git a/b.txt b/b.txt" in text
    assert "new file mode" in text
    assert "+two" in text


@pytest.mark.asyncio
async def test_the_older_side_may_be_named_second(git_ws):
    # Argument order decides direction, so this is the reverse patch.
    result = await git_ws.execute("git -C /repo diff HEAD HEAD~1")
    text = result.stdout.decode()
    assert "-one changed" in text
    assert "+one" in text


@pytest.mark.asyncio
async def test_an_unknown_revision_is_a_fatal(git_ws):
    result = await git_ws.execute("git -C /repo diff nope HEAD")
    assert result.exit_code == 128
    assert result.stderr.startswith(b"fatal: ambiguous argument 'nope'")

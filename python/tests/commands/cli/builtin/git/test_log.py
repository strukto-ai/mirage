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

AUTHOR_LINE = "Author: Test Author <test@example.com>"


def subjects_of(stdout: bytes) -> list[str]:
    """Subjects from ``--oneline`` output.

    Args:
        stdout (bytes): the command's stdout.
    """
    return [
        line.split(" ", 1)[1] for line in stdout.decode().splitlines() if line
    ]


@pytest.mark.asyncio
async def test_oneline_lists_newest_first(git_ws):
    result = await git_ws.execute("git -C /repo log --oneline")
    assert result.exit_code == 0
    assert subjects_of(result.stdout) == ["third", "second", "first"]


@pytest.mark.asyncio
async def test_oneline_rows_start_with_a_seven_character_id(git_ws):
    result = await git_ws.execute("git -C /repo log --oneline -n 1")
    row = result.stdout.decode().rstrip("\n")
    assert len(row.split(" ", 1)[0]) == 7


@pytest.mark.asyncio
async def test_max_count_cuts_the_list(git_ws):
    result = await git_ws.execute("git -C /repo log -n 2 --oneline")
    assert subjects_of(result.stdout) == ["third", "second"]


@pytest.mark.asyncio
async def test_numeric_shorthand_is_accepted(git_ws):
    result = await git_ws.execute("git -C /repo log -2 --oneline")
    assert subjects_of(result.stdout) == ["third", "second"]


@pytest.mark.asyncio
async def test_reverse_prints_oldest_first(git_ws):
    result = await git_ws.execute("git -C /repo log --oneline --reverse")
    assert subjects_of(result.stdout) == ["first", "second", "third"]


@pytest.mark.asyncio
async def test_default_format_is_gits_header_block(git_ws):
    result = await git_ws.execute("git -C /repo log -n 1")
    lines = result.stdout.decode().split("\n")
    assert lines[0].startswith("commit ")
    assert len(lines[0].split(" ")[1]) == 40
    assert lines[1] == AUTHOR_LINE
    assert lines[2].startswith("Date:   ")
    assert lines[3] == ""
    assert lines[4] == "    third"


@pytest.mark.asyncio
async def test_entries_are_separated_by_a_blank_line(git_ws):
    result = await git_ws.execute("git -C /repo log")
    text = result.stdout.decode()
    assert text.count("commit ") == 3
    assert "\n\ncommit " in text


@pytest.mark.asyncio
async def test_a_revision_operand_starts_the_walk_there(git_ws):
    result = await git_ws.execute("git -C /repo log HEAD~1 --oneline")
    assert subjects_of(result.stdout) == ["second", "first"]


@pytest.mark.asyncio
async def test_pickaxe_finds_the_commit_that_introduced_a_string(git_ws):
    result = await git_ws.execute("git -C /repo log -S changed "
                                  "--oneline --reverse")
    assert subjects_of(result.stdout) == ["third"]


@pytest.mark.asyncio
async def test_pickaxe_ignores_a_rewrite_that_keeps_the_count(git_ws):
    result = await git_ws.execute("git -C /repo log -S one --oneline")
    assert subjects_of(result.stdout) == ["first"]


@pytest.mark.asyncio
async def test_an_unknown_revision_is_a_fatal(git_ws):
    result = await git_ws.execute("git -C /repo log nope --oneline")
    assert result.exit_code == 128
    assert result.stderr.startswith(b"fatal: ambiguous argument 'nope'")


@pytest.mark.asyncio
async def test_a_date_git_reads_but_we_do_not_is_a_fatal(git_ws):
    result = await git_ws.execute("git -C /repo log --since '2 weeks ago'")
    assert result.exit_code == 128
    assert b"invalid date format for --since" in result.stderr


@pytest.mark.asyncio
async def test_a_window_that_excludes_everything_prints_nothing(git_ws):
    result = await git_ws.execute("git -C /repo log --since 4102444800")
    assert result.exit_code == 0
    assert result.stdout == b""

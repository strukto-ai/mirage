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
from dulwich import porcelain

from tests.commands.cli.builtin.git.conftest import commit_file

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


def _branch_with_commit(repo_path, name: str, filename: str,
                        subject: str) -> None:
    """A commit on a new branch, leaving HEAD back on main.

    Args:
        repo_path (Path): the repository's working tree.
        name (str): branch name to create.
        filename (str): file the branch commit writes.
        subject (str): the branch commit's message.
    """
    porcelain.branch_create(str(repo_path), name)
    porcelain.update_head(str(repo_path), f"refs/heads/{name}")
    commit_file(repo_path, filename, "side content\n", subject)
    porcelain.update_head(str(repo_path), "refs/heads/main")


@pytest.mark.asyncio
async def test_all_includes_commits_from_other_branches(git_ws, repo_path):
    _branch_with_commit(repo_path, "side", "side.txt", "side work")
    plain = await git_ws.execute("git -C /repo log --oneline")
    everything = await git_ws.execute("git -C /repo log --all --oneline")
    assert "side work" not in plain.stdout.decode()
    assert "side work" in everything.stdout.decode()
    assert subjects_of(plain.stdout) == ["third", "second", "first"]


@pytest.mark.asyncio
async def test_format_placeholders_render_the_commit_fields(git_ws):
    result = await git_ws.execute(
        "git -C /repo log -n 1 --format='%H|%h|%an|%ae|%s'")
    full, abbrev, name, email, subject = (
        result.stdout.decode().rstrip("\n").split("|"))
    assert len(full) == 40
    assert full.startswith(abbrev) and len(abbrev) == 7
    assert name == "Test Author"
    assert email == "test@example.com"
    assert subject == "third"


@pytest.mark.asyncio
async def test_format_separator_and_terminator_semantics(git_ws):
    # format: separates entries and ends without a newline; tformat:
    # (and any bare % string) terminates every entry with one.
    separated = await git_ws.execute("git -C /repo log --pretty='format:%s'")
    terminated = await git_ws.execute("git -C /repo log --format='%s'")
    assert separated.stdout == b"third\nsecond\nfirst"
    assert terminated.stdout == b"third\nsecond\nfirst\n"


@pytest.mark.asyncio
async def test_pretty_oneline_prints_full_ids_unlike_oneline(git_ws):
    pretty = await git_ws.execute("git -C /repo log --pretty=oneline -n 1")
    dashed = await git_ws.execute("git -C /repo log --oneline -n 1")
    assert len(pretty.stdout.decode().split(" ", 1)[0]) == 40
    assert len(dashed.stdout.decode().split(" ", 1)[0]) == 7


@pytest.mark.asyncio
async def test_bare_pretty_defaults_to_medium(git_ws):
    bare = await git_ws.execute("git -C /repo log --pretty")
    medium = await git_ws.execute("git -C /repo log")
    assert bare.stdout == medium.stdout


@pytest.mark.asyncio
async def test_block_presets_shape_their_headers(git_ws):
    short = await git_ws.execute("git -C /repo log -n 1 --pretty=short")
    full = await git_ws.execute("git -C /repo log -n 1 --pretty=full")
    fuller = await git_ws.execute("git -C /repo log -n 1 --pretty=fuller")
    assert "Date:" not in short.stdout.decode()
    assert "    third" in short.stdout.decode()
    full_text = full.stdout.decode()
    assert "Commit: Test Author <test@example.com>" in full_text
    assert "Date:" not in full_text
    fuller_text = fuller.stdout.decode()
    assert "AuthorDate: " in fuller_text
    assert "CommitDate: " in fuller_text
    assert "Author:     Test Author <test@example.com>" in fuller_text


@pytest.mark.asyncio
async def test_decorations_name_head_branches_and_tags(git_ws, repo_path):
    porcelain.tag_create(str(repo_path), b"v1")
    result = await git_ws.execute("git -C /repo log -n 1 --format='%d'")
    assert result.stdout == b" (HEAD -> main, tag: v1)\n"
    bare = await git_ws.execute("git -C /repo log -n 1 --format='%D'")
    assert bare.stdout == b"HEAD -> main, tag: v1\n"


@pytest.mark.asyncio
async def test_undecorated_commits_render_d_as_nothing(git_ws):
    result = await git_ws.execute("git -C /repo log -n 1 --format='x%d' HEAD~1"
                                  )
    assert result.stdout == b"x\n"


@pytest.mark.asyncio
async def test_invalid_pretty_name_is_refused_like_git(git_ws):
    result = await git_ws.execute("git -C /repo log --pretty=bogus")
    assert result.exit_code == 128
    assert result.stderr == b"fatal: invalid --pretty format: bogus\n"


@pytest.mark.asyncio
async def test_real_but_unsupported_preset_says_unsupported(git_ws):
    result = await git_ws.execute("git -C /repo log --pretty=raw")
    assert result.exit_code == 128
    assert b"unsupported --pretty format: raw" in result.stderr


@pytest.mark.asyncio
async def test_empty_format_prints_nothing(git_ws):
    result = await git_ws.execute("git -C /repo log --format=")
    assert result.exit_code == 0
    assert result.stdout in (b"", None) or result.stdout == b""


@pytest.mark.asyncio
async def test_unknown_placeholders_stay_verbatim(git_ws):
    result = await git_ws.execute("git -C /repo log -n 1 --format='%q %zz'")
    assert result.stdout == b"%q %zz\n"


@pytest.mark.asyncio
async def test_format_empty_entries_keep_their_separators(git_ws):
    # git 2.37/2.54: format: joins every entry, so a template that
    # renders empty still claims its separator - three commits print
    # exactly two bare newlines.
    result = await git_ws.execute("git -C /repo log --pretty=format:")
    assert result.stdout == b"\n\n"


@pytest.mark.asyncio
async def test_tformat_terminates_empty_entries(git_ws):
    # Only the head commit decorates; the two undecorated entries still
    # claim their terminators, unlike an empty template.
    result = await git_ws.execute("git -C /repo log --format='%d'")
    assert result.stdout == b" (HEAD -> main)\n\n\n"


@pytest.mark.asyncio
async def test_x_placeholder_names_a_raw_byte(git_ws):
    result = await git_ws.execute("git -C /repo log -n 1 --format='a%x80b'")
    assert result.stdout == b"a\x80b\n"


@pytest.mark.asyncio
async def test_bare_format_is_refused_like_git(git_ws):
    result = await git_ws.execute("git -C /repo log --format")
    assert result.exit_code == 128
    assert result.stderr == b"fatal: unrecognized argument: --format\n"

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

from mirage.commands.cli.builtin.git.reset import restored


async def run(ws, line: str) -> tuple[int, bytes, bytes]:
    """Run one git line against the mounted repository.

    Args:
        ws (Workspace): workspace with the repository and CLI.
        line (str): the command line, without the leading directory.
    """
    result = await ws.execute(f"git -C /repo {line}")
    return result.exit_code, result.stdout or b"", result.stderr or b""


def test_a_restored_entry_states_no_size_rather_than_a_wrong_one():
    # The blob is not read, so its length is not known. Zero is read
    # back as "not stated"; claiming a length would report every tracked
    # file as modified the moment anything was unstaged.
    entry = restored(b"a" * 40, 0o100644)
    assert entry.size == 0
    assert entry.sha == b"a" * 40


@pytest.mark.asyncio
async def test_unstaging_puts_the_index_back(git_rw, repo_path: Path):
    (repo_path / "a.txt").write_text("edited\n", encoding="utf-8")
    await run(git_rw, "add -A")
    assert (await run(git_rw, "status --porcelain"))[1] == b"M  a.txt\n"
    await run(git_rw, "reset")
    assert (await run(git_rw, "status --porcelain"))[1] == b" M a.txt\n"


@pytest.mark.asyncio
async def test_unstaging_leaves_the_working_tree_alone(git_rw,
                                                       repo_path: Path):
    # Mixed mode, which is git's default: the edit survives, only the
    # staging of it is undone.
    (repo_path / "a.txt").write_text("edited\n", encoding="utf-8")
    await run(git_rw, "add -A")
    await run(git_rw, "reset")
    assert (repo_path / "a.txt").read_text() == "edited\n"


@pytest.mark.asyncio
async def test_it_reports_what_is_left_unstaged(git_rw, repo_path: Path):
    (repo_path / "a.txt").write_text("edited\n", encoding="utf-8")
    await run(git_rw, "add -A")
    _code, out, _err = await run(git_rw, "reset")
    assert out == b"Unstaged changes after reset:\nM\ta.txt\n"


@pytest.mark.asyncio
async def test_a_clean_tree_reports_nothing(git_rw):
    assert await run(git_rw, "reset") == (0, b"", b"")


@pytest.mark.asyncio
async def test_a_staged_new_file_becomes_untracked_again(
        git_rw, repo_path: Path):
    (repo_path / "fresh.txt").write_text("x\n", encoding="utf-8")
    await run(git_rw, "add -A")
    await run(git_rw, "reset")
    assert (await run(git_rw, "status --porcelain"))[1] == b"?? fresh.txt\n"


@pytest.mark.asyncio
async def test_a_pathspec_unstages_only_that_path(git_rw, repo_path: Path):
    (repo_path / "a.txt").write_text("edited\n", encoding="utf-8")
    (repo_path / "b.txt").write_text("also edited\n", encoding="utf-8")
    await run(git_rw, "add -A")
    await run(git_rw, "reset a.txt")
    _code, out, _err = await run(git_rw, "status --porcelain")
    assert out == b" M a.txt\nM  b.txt\n"


@pytest.mark.asyncio
async def test_a_pathspec_that_matches_nothing_is_refused(git_rw):
    # Selecting nothing used to unstage nothing and exit 0, which reads
    # to a script as "the index was reset".
    code, _out, err = await run(git_rw, "reset nosuch.txt")
    assert code == 128
    assert err == (b"fatal: ambiguous argument 'nosuch.txt': unknown revision "
                   b"or path not in the working tree.\nUse '--' to separate "
                   b"paths from revisions, like this:\n"
                   b"'git <command> [<revision>...] -- [<file>...]'\n")


@pytest.mark.asyncio
async def test_a_revision_operand_says_which_feature_is_missing(git_rw):
    # Real git resets the index to the named commit. This build does not,
    # and "unknown revision" would be a lie about a revision it resolves.
    code, _out, err = await run(git_rw, "reset HEAD~1")
    assert code == 128
    assert err == (b"fatal: cannot reset to 'HEAD~1': this build resets the "
                   b"index from HEAD only\n")


@pytest.mark.asyncio
async def test_an_untracked_path_is_refused(git_rw, repo_path: Path):
    # It is in the working tree but in neither the index nor HEAD, so
    # reset has nothing to put back for it.
    (repo_path / "fresh.txt").write_text("x\n", encoding="utf-8")
    code, _out, err = await run(git_rw, "reset fresh.txt")
    assert code == 128
    assert b"ambiguous argument 'fresh.txt'" in err


@pytest.mark.asyncio
async def test_an_unknown_switch_is_refused(git_rw):
    code, _out, err = await run(git_rw, "reset -Z")
    assert code == 129
    assert err == b"error: unknown switch `Z'\n"

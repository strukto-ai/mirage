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
from dulwich.index import IndexEntry
from dulwich.objects import Blob
from dulwich.repo import Repo

from mirage.commands.cli.builtin.git.constants import REGULAR
from mirage.commands.cli.builtin.git.reset import restored
from tests.commands.cli.builtin.git.conftest import branch_with_paths
from tests.commands.cli.builtin.git.conftest import run as run


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
async def test_unstaging_leaves_the_working_tree_alone(
    git_rw, repo_path: Path
):
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
    git_rw, repo_path: Path
):
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
    assert err == (
        b"fatal: ambiguous argument 'nosuch.txt': unknown revision "
        b"or path not in the working tree.\nUse '--' to separate "
        b"paths from revisions, like this:\n"
        b"'git <command> [<revision>...] -- [<file>...]'\n"
    )


@pytest.mark.asyncio
async def test_a_revision_operand_says_which_feature_is_missing(git_rw):
    # Real git resets the index to the named commit. This build does not,
    # and "unknown revision" would be a lie about a revision it resolves.
    code, _out, err = await run(git_rw, "reset HEAD~1")
    assert code == 128
    assert err == (
        b"fatal: cannot reset to 'HEAD~1': this build resets the "
        b"index from HEAD only\n"
    )


@pytest.mark.asyncio
async def test_an_untracked_path_is_refused(git_rw, repo_path: Path):
    # It is in the working tree but in neither the index nor HEAD, so
    # reset has nothing to put back for it.
    (repo_path / "fresh.txt").write_text("x\n", encoding="utf-8")
    code, _out, err = await run(git_rw, "reset fresh.txt")
    assert code == 128
    assert b"ambiguous argument 'fresh.txt'" in err


@pytest.mark.asyncio
async def test_quiet_unstages_without_a_report(git_rw, repo_path: Path):
    (repo_path / "a.txt").write_text("edited\n", encoding="utf-8")
    await run(git_rw, "add -A")
    assert await run(git_rw, "reset -q") == (0, b"", b"")
    assert (await run(git_rw, "status --porcelain"))[1] == b" M a.txt\n"


@pytest.mark.asyncio
async def test_reset_refuses_to_stage_a_path_git_rejects(
    git_rw, repo_path: Path
):
    branch_with_paths(
        repo_path,
        "odd",
        {"a.txt": b"one changed\n", "fresh": b"f\n", "git~1/x": b"x\n"},
    )
    Repo(str(repo_path)).refs.set_symbolic_ref(b"HEAD", b"refs/heads/odd")
    assert await run(git_rw, "reset") == (
        128,
        b"",
        b"error: invalid path 'git~1/x'\n"
        b"fatal: make_cache_entry failed for path 'git~1/x'\n",
    )
    assert (await run(git_rw, "ls-files"))[1] == b"a.txt\nb.txt\n"


@pytest.mark.asyncio
async def test_reset_of_paths_git_accepts_still_stages_them(
    git_rw, repo_path: Path
):
    branch_with_paths(repo_path, "odd", {"fresh": b"f\n", "git~1/x": b"x\n"})
    Repo(str(repo_path)).refs.set_symbolic_ref(b"HEAD", b"refs/heads/odd")
    assert (await run(git_rw, "reset -q -- fresh"))[0] == 0
    assert (await run(git_rw, "ls-files"))[1] == b"a.txt\nb.txt\nfresh\n"


@pytest.mark.asyncio
async def test_reset_names_only_the_first_path_git_rejects(
    git_rw, repo_path: Path
):
    branch_with_paths(
        repo_path, "odd", {"git~1/x": b"x\n", ".git/y": b"x\n", "z": b"z\n"}
    )
    Repo(str(repo_path)).refs.set_symbolic_ref(b"HEAD", b"refs/heads/odd")
    assert await run(git_rw, "reset -q") == (
        128,
        b"",
        b"error: invalid path '.git/y'\n"
        b"fatal: make_cache_entry failed for path '.git/y'\n",
    )
    assert (await run(git_rw, "ls-files"))[1] == b"a.txt\nb.txt\n"


@pytest.mark.parametrize(
    "head_mode,staged,code,listed",
    [
        (REGULAR, b"x\n", 0, b"a.txt\ngit~1\n"),
        (0o100755, b"x\n", 128, b"a.txt\nb.txt\ngit~1\n"),
        (REGULAR, b"y\n", 128, b"a.txt\nb.txt\ngit~1\n"),
    ],
)
@pytest.mark.asyncio
async def test_reset_checks_only_an_entry_it_changes(
    git_rw,
    repo_path: Path,
    head_mode: int,
    staged: bytes,
    code: int,
    listed: bytes,
):
    branch_with_paths(
        repo_path,
        "odd",
        {"a.txt": b"one changed\n", "git~1": b"x\n"},
        {"git~1": head_mode},
    )
    with Repo(str(repo_path)) as repo:
        index = repo.open_index()
        index[b"git~1"] = IndexEntry(
            ctime=0,
            mtime=0,
            dev=0,
            ino=0,
            mode=REGULAR,
            uid=0,
            gid=0,
            size=0,
            sha=Blob.from_string(staged).id,
        )
        index.write()
        repo.refs.set_symbolic_ref(b"HEAD", b"refs/heads/odd")
    assert (await run(git_rw, "reset -q"))[0] == code
    assert (await run(git_rw, "ls-files"))[1] == listed

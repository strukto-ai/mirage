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

import re
from pathlib import Path

import pytest
from dulwich.repo import Repo

from mirage.commands.cli.builtin.git.commit import DEFAULT_EMAIL, identity
from mirage.commands.spec.types import FlagView

SUMMARY = re.compile(rb"^\[main [0-9a-f]{7,}\] (.+)$", re.M)


async def run(ws, line: str) -> tuple[int, bytes, bytes]:
    """Run one git line against the mounted repository.

    Args:
        ws (Workspace): workspace with the repository and CLI.
        line (str): the command line, without the leading directory.
    """
    result = await ws.execute(f"git -C /repo {line}")
    return result.exit_code, result.stdout or b"", result.stderr or b""


def head_commit(repo_path: Path):
    """The commit HEAD names, read by a plain on-disk repository.

    Args:
        repo_path (Path): the repository's working tree.
    """
    with Repo(str(repo_path)) as repo:
        return repo[repo.refs[b"HEAD"]]


def test_the_recorded_identity_is_stated_not_guessed():
    # git would read user.name from a config file that a mount cannot
    # reach. Guessing the operator's own name into someone else's
    # history is the thing to avoid here.
    assert DEFAULT_EMAIL.encode() in identity(FlagView({}))


def test_an_author_flag_overrides_it():
    who = identity(FlagView({"author": "Ada <ada@example.com>"}))
    assert who == b"Ada <ada@example.com>"


@pytest.mark.asyncio
async def test_a_commit_lands_on_the_branch(git_rw, repo_path: Path):
    (repo_path / "a.txt").write_text("changed\n", encoding="utf-8")
    await run(git_rw, "add -A")
    code, out, _err = await run(git_rw, "commit -m 'a change'")
    assert code == 0
    assert SUMMARY.search(out).group(1) == b"a change"
    assert head_commit(repo_path).message == b"a change\n"


@pytest.mark.asyncio
async def test_the_diffstat_counts_lines(git_rw, repo_path: Path):
    (repo_path / "a.txt").write_text("one changed\nand another\n",
                                     encoding="utf-8")
    await run(git_rw, "add -A")
    _code, out, _err = await run(git_rw, "commit -m more")
    assert b" 1 file changed, 1 insertion(+)\n" in out


@pytest.mark.asyncio
async def test_a_new_file_gets_a_create_mode_line(git_rw, repo_path: Path):
    (repo_path / "fresh.txt").write_text("x\n", encoding="utf-8")
    await run(git_rw, "add -A")
    _code, out, _err = await run(git_rw, "commit -m fresh")
    assert b" create mode 100644 fresh.txt\n" in out


@pytest.mark.asyncio
async def test_a_removal_gets_a_delete_mode_line(git_rw, repo_path: Path):
    (repo_path / "b.txt").unlink()
    await run(git_rw, "add -A")
    _code, out, _err = await run(git_rw, "commit -m gone")
    assert b" delete mode 100644 b.txt\n" in out


@pytest.mark.asyncio
async def test_the_parent_is_the_commit_that_was_there(git_rw,
                                                       repo_path: Path):
    before = head_commit(repo_path).id
    (repo_path / "a.txt").write_text("next\n", encoding="utf-8")
    await run(git_rw, "add -A")
    await run(git_rw, "commit -m next")
    assert head_commit(repo_path).parents == [before]


@pytest.mark.asyncio
async def test_nothing_staged_prints_the_status_on_stdout(git_rw):
    # git shows the whole status here rather than a one-line refusal,
    # and it goes to stdout because that is where a status would go.
    code, out, err = await run(git_rw, "commit -m nope")
    assert code == 1
    assert err == b""
    assert out == (b"On branch main\nnothing to commit, working tree clean\n")


@pytest.mark.asyncio
async def test_an_untracked_file_alone_is_still_nothing_to_commit(
        git_rw, repo_path: Path):
    (repo_path / "fresh.txt").write_text("x\n", encoding="utf-8")
    code, out, _err = await run(git_rw, "commit -m nope")
    assert code == 1
    assert out.endswith(b'nothing added to commit but untracked files '
                        b'present (use "git add" to track)\n')


@pytest.mark.asyncio
async def test_no_message_is_refused_rather_than_invented(
        git_rw, repo_path: Path):
    (repo_path / "a.txt").write_text("changed\n", encoding="utf-8")
    await run(git_rw, "add -A")
    code, _out, err = await run(git_rw, "commit")
    assert code == 128
    assert b"no commit message supplied" in err


@pytest.mark.asyncio
async def test_a_commit_is_recorded_in_the_reflog(git_rw, repo_path: Path):
    # git branch reads this to say where a detached HEAD came from, so
    # an absent log turns a good checkout into "(no branch)".
    (repo_path / "a.txt").write_text("changed\n", encoding="utf-8")
    await run(git_rw, "add -A")
    await run(git_rw, "commit -m logged")
    log = (repo_path / ".git" / "logs" / "HEAD").read_bytes()
    assert log.rstrip().endswith(b"commit: logged")
    assert (repo_path / ".git" / "logs" / "refs" / "heads" / "main").exists()


@pytest.mark.asyncio
async def test_an_unknown_switch_is_refused(git_rw):
    code, _out, err = await run(git_rw, "commit -Z")
    assert code == 129
    assert err == b"error: unknown switch `Z'\n"

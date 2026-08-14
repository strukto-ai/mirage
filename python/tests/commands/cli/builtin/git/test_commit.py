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
from mirage.ops.types import SessionView
from mirage.types import HiddenVars
from mirage.workspace.session import Session
from mirage.workspace.session.state import session_view

SUMMARY = re.compile(rb"^\[main [0-9a-f]{7,}\] (.+)$", re.M)


def env_view(env: dict[str, str]) -> SessionView:
    """The session plane's door over a session holding ``env``.

    Args:
        env (dict[str, str]): the variables the session holds.
    """
    session = Session(session_id="s")
    session.env.update(env)
    return session_view(session)


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


def test_the_author_flag_still_wins_over_the_environment():
    view = env_view({"GIT_AUTHOR_NAME": "Env", "GIT_AUTHOR_EMAIL": "e@x"})
    fl = FlagView({"author": "Flag <f@x>"})
    assert identity(fl, view) == b"Flag <f@x>"


def test_the_author_comes_from_the_git_author_variables():
    # Pinned against git 2.50: GIT_AUTHOR_NAME and GIT_AUTHOR_EMAIL name
    # the author, ahead of any config and of the stated default.
    view = env_view({"GIT_AUTHOR_NAME": "A", "GIT_AUTHOR_EMAIL": "a@x"})
    assert identity(FlagView({}), view) == b"A <a@x>"


def test_email_is_the_fallback_address():
    # git falls back to $EMAIL when no GIT_*_EMAIL is set.
    view = env_view({"GIT_AUTHOR_NAME": "A", "EMAIL": "e@x"})
    assert identity(FlagView({}), view) == b"A <e@x>"


def test_no_environment_leaves_the_stated_default():
    assert identity(FlagView({}), env_view({})) == b"mirage <mirage@localhost>"


def test_a_hidden_variable_is_not_read_as_an_identity():
    # The door filters hidden names, so a hidden GIT_AUTHOR_NAME reads
    # as unset rather than leaking into a commit the session can see.
    session = Session(session_id="s",
                      hidden_vars=HiddenVars(patterns=("GIT_AUTHOR_*", )))
    session.env.update({
        "GIT_AUTHOR_NAME": "Secret",
        "GIT_AUTHOR_EMAIL": "s@x"
    })
    assert identity(FlagView({}),
                    session_view(session)) == (b"mirage <mirage@localhost>")


@pytest.mark.asyncio
async def test_commit_records_the_environment_author(git_rw, repo_path: Path):
    (repo_path / "a.txt").write_text("changed\n", encoding="utf-8")
    assert (await run(git_rw, "add -A"))[0] == 0
    line = ("GIT_AUTHOR_NAME=Ada GIT_AUTHOR_EMAIL=ada@x "
            "git -C /repo commit -m env")
    assert (await git_rw.execute(line)).exit_code == 0
    with Repo(str(repo_path)) as repo:
        head = repo[repo.refs[b"HEAD"]]
        assert head.author == b"Ada <ada@x>"

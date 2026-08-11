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

from mirage.commands.cli.builtin.git.errors import (FATAL_EXIT,
                                                    NotARepositoryError)
from mirage.commands.cli.builtin.git.util import fatal, start_point
from mirage.commands.spec.types import FlagView


def test_start_point_reads_the_resolved_c_flag():
    assert start_point(FlagView({"C": "/repo/src"})) == "/repo/src"


def test_start_point_falls_back_to_root_without_a_workspace():
    # Only reachable when a leaf is called outside a workspace: inside
    # one the walk always lands the "." default.
    assert start_point(FlagView({})) == "/"


def test_fatal_renders_gits_wording_and_exit():
    stream, io = fatal(NotARepositoryError())
    assert stream is None
    assert io.exit_code == FATAL_EXIT == 128
    assert io.stderr == (b"fatal: not a git repository (or any of the "
                         b"parent directories): .git\n")


def test_fatal_names_an_explicit_gitdir():
    _stream, io = fatal(NotARepositoryError("/tmp/norepo"))
    assert io.stderr == b"fatal: not a git repository: '/tmp/norepo'\n"


@pytest.mark.asyncio
async def test_an_unsupported_log_flag_says_so_rather_than_blaming_the_repo(
        git_ws):
    # -p is real git, absent here. As a revision operand it used to come
    # back "ambiguous argument", which reads as a missing commit.
    result = await git_ws.execute("git -C /repo log -p")
    assert result.exit_code == 128
    assert result.stderr == b"fatal: unrecognized argument: -p\n"


@pytest.mark.asyncio
async def test_an_unsupported_long_log_flag_is_refused_whole(git_ws):
    result = await git_ws.execute("git -C /repo log --graph")
    assert result.exit_code == 128
    assert result.stderr == b"fatal: unrecognized argument: --graph\n"


@pytest.mark.asyncio
async def test_an_unsupported_show_flag_is_refused(git_ws):
    result = await git_ws.execute("git -C /repo show --raw HEAD")
    assert result.exit_code == 128
    assert result.stderr == b"fatal: unrecognized argument: --raw\n"


@pytest.mark.asyncio
async def test_diff_keeps_gits_own_wording_and_exit_for_a_bad_option(git_ws):
    # git words this one differently from log and show, and exits 129
    # rather than 128. Pinned against git 2.50.1.
    result = await git_ws.execute("git -C /repo diff --stat HEAD")
    assert result.exit_code == 129
    assert result.stderr == b"error: invalid option: --stat\n"


@pytest.mark.asyncio
async def test_a_refused_flag_costs_no_object_reads(git_ws):
    # The check runs before the repository is opened, so a bad flag is
    # answered without touching the backend.
    result = await git_ws.execute("git -C /nowhere log -p")
    assert result.exit_code == 128
    assert result.stderr == b"fatal: unrecognized argument: -p\n"


@pytest.mark.asyncio
async def test_a_real_revision_still_resolves(git_ws):
    result = await git_ws.execute("git -C /repo log --oneline HEAD")
    assert result.exit_code == 0
    assert result.stdout


@pytest.mark.asyncio
async def test_an_unknown_revision_keeps_gits_ambiguous_wording(git_ws):
    result = await git_ws.execute("git -C /repo log nosuchref")
    assert result.exit_code == 128
    assert result.stderr.startswith(b"fatal: ambiguous argument 'nosuchref'")


@pytest.mark.asyncio
async def test_status_refuses_an_unknown_option_in_gits_own_words(git_ws):
    # Pinned against git 2.50.1: no program name, the option named
    # without its dashes, backquote-apostrophe quoting, exit 129.
    result = await git_ws.execute("git -C /repo status --nosuch")
    assert result.exit_code == 129
    assert result.stderr == b"error: unknown option `nosuch'\n"


@pytest.mark.asyncio
async def test_a_short_unknown_option_is_a_switch_not_an_option(git_ws):
    result = await git_ws.execute("git -C /repo status -Z")
    assert result.exit_code == 129
    assert result.stderr == b"error: unknown switch `Z'\n"


@pytest.mark.asyncio
async def test_branch_speaks_the_same_dialect(git_ws):
    result = await git_ws.execute("git -C /repo branch -Z")
    assert result.exit_code == 129
    assert result.stderr == b"error: unknown switch `Z'\n"

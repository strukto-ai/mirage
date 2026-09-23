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

from mirage.commands.cli.builtin.git.errors import (  # yapf: disable
    FATAL_EXIT, NotARepositoryError, UnknownSwitchError)
from mirage.commands.cli.builtin.git.util import (check_operands, escaped,
                                                  fatal, start_point, switches)
from mirage.commands.cli.types import CLIInvocation, CLISpec
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import Option


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
    result = await git_ws.shell("git -C /repo log -p")
    assert result.exit_code == 128
    assert result.stderr == b"fatal: unrecognized argument: -p\n"


@pytest.mark.asyncio
async def test_an_unsupported_long_log_flag_is_refused_whole(git_ws):
    result = await git_ws.shell("git -C /repo log --graph")
    assert result.exit_code == 128
    assert result.stderr == b"fatal: unrecognized argument: --graph\n"


@pytest.mark.asyncio
async def test_an_unsupported_show_flag_is_refused(git_ws):
    result = await git_ws.shell("git -C /repo show --raw HEAD")
    assert result.exit_code == 128
    assert result.stderr == b"fatal: unrecognized argument: --raw\n"


@pytest.mark.asyncio
async def test_diff_keeps_gits_own_wording_and_exit_for_a_bad_option(git_ws):
    # git words this one differently from log and show, and exits 129
    # rather than 128. Pinned against git 2.50.1.
    result = await git_ws.shell("git -C /repo diff --stat HEAD")
    assert result.exit_code == 129
    assert result.stderr == b"error: invalid option: --stat\n"


@pytest.mark.asyncio
async def test_a_refused_flag_costs_no_object_reads(git_ws):
    # The check runs before the repository is opened, so a bad flag is
    # answered without touching the backend.
    result = await git_ws.shell("git -C /nowhere log -p")
    assert result.exit_code == 128
    assert result.stderr == b"fatal: unrecognized argument: -p\n"


@pytest.mark.asyncio
async def test_a_real_revision_still_resolves(git_ws):
    result = await git_ws.shell("git -C /repo log --oneline HEAD")
    assert result.exit_code == 0
    assert result.stdout


@pytest.mark.asyncio
async def test_an_unknown_revision_keeps_gits_ambiguous_wording(git_ws):
    result = await git_ws.shell("git -C /repo log nosuchref")
    assert result.exit_code == 128
    assert result.stderr.startswith(b"fatal: ambiguous argument 'nosuchref'")


@pytest.mark.asyncio
async def test_status_refuses_an_unknown_option_in_gits_own_words(git_ws):
    # Pinned against git 2.50.1: no program name, the option named
    # without its dashes, backquote-apostrophe quoting, exit 129.
    result = await git_ws.shell("git -C /repo status --nosuch")
    assert result.exit_code == 129
    assert result.stderr == b"error: unknown option `nosuch'\n"


@pytest.mark.asyncio
async def test_a_short_unknown_option_is_a_switch_not_an_option(git_ws):
    result = await git_ws.shell("git -C /repo status -Z")
    assert result.exit_code == 129
    assert result.stderr == b"error: unknown switch `Z'\n"


@pytest.mark.asyncio
async def test_branch_speaks_the_same_dialect(git_ws):
    result = await git_ws.shell("git -C /repo branch -Z")
    assert result.exit_code == 129
    assert result.stderr == b"error: unknown switch `Z'\n"


def test_no_marker_escapes_nothing():
    assert escaped(("rm", "-f", "a.txt")) == frozenset()


def test_the_marker_escapes_every_word_after_it():
    assert escaped(("rm", "--", "-draft", "b.txt")) == {"-draft", "b.txt"}


def test_only_the_first_marker_counts():
    assert escaped(("rm", "--", "-a", "--", "-b")) == {"-a", "--", "-b"}


def test_an_escaped_operand_is_not_a_switch():
    check_operands(("-draft", ), UnknownSwitchError, frozenset({"-draft"}))


def test_an_unescaped_dashed_operand_is_still_refused():
    with pytest.raises(UnknownSwitchError):
        check_operands(("-draft", ), UnknownSwitchError, frozenset({"-other"}))


# git's parse-options consumes the letters it knows and names the first
# it does not (`git mv -nx` says `x', `git mv -draft` says `d'), so the
# refusal takes the verb's own switches; without them the whole word is
# named, which is how log, show and diff word theirs.
def test_a_cluster_is_refused_at_its_first_unknown_letter():
    with pytest.raises(UnknownSwitchError) as caught:
        check_operands(("-nx", ), UnknownSwitchError, frozenset(),
                       frozenset({"n"}))
    assert str(caught.value) == "unknown switch `x'"
    with pytest.raises(UnknownSwitchError) as caught:
        check_operands(("-draft", ), UnknownSwitchError, frozenset(),
                       frozenset({"f", "k", "n", "v"}))
    assert str(caught.value) == "unknown switch `d'"


def test_a_verb_with_no_switches_still_names_the_first_letter():
    # reset declares none, and git still says `Z' for `git reset -Zq`.
    with pytest.raises(UnknownSwitchError) as caught:
        check_operands(("-Zq", ), UnknownSwitchError, frozenset(), frozenset())
    assert str(caught.value) == "unknown switch `Z'"


def test_a_long_option_is_refused_whole():
    with pytest.raises(UnknownSwitchError) as caught:
        check_operands(("--bogus", ), UnknownSwitchError, frozenset(),
                       frozenset({"n"}))
    assert str(caught.value) == "unknown option `bogus'"


def test_without_known_switches_the_whole_word_is_named():
    with pytest.raises(UnknownSwitchError) as caught:
        check_operands(("-nx", ), UnknownSwitchError)
    assert str(caught.value) == "unknown switch `nx'"


async def _verb(inv: CLIInvocation) -> None:
    return None


def test_switches_reads_the_leaf_the_line_was_parsed_against():
    leaf = CLISpec(name="mv",
                   fn=_verb,
                   options=(Option(short="-f", long="--force"),
                            Option(short="-k"), Option(long="--sparse")))
    assert switches(CLIInvocation(None, spec=leaf)) == {"f", "k"}
    assert switches(CLIInvocation(None)) == frozenset()

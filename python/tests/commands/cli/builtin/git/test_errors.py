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

from mirage.commands.cli.builtin.git.errors import (  # yapf: disable
    FATAL_EXIT, AmbiguousArgumentError, BadDateError, BadStartPointError,
    GitError, NotARepositoryError, NoWorkingDirectoryError, NoWorkspaceError,
    RevisionResetError)


def test_every_fatal_shares_one_base():
    # `fatal` renders any GitError the same way, so a verb catches the
    # base and never enumerates the subclasses.
    for exc in (NotARepositoryError(), AmbiguousArgumentError("x"),
                BadDateError("--since", "x"), NoWorkspaceError(),
                NoWorkingDirectoryError("x")):
        assert isinstance(exc, GitError)


def test_git_exits_128_not_1_or_2():
    # Neither the dispatcher's usage exit (2) nor its handler-error
    # exit (1): git answers every fatal with 128.
    assert FATAL_EXIT == 128


def test_discovery_failure_names_the_parent_walk():
    assert str(NotARepositoryError()) == (
        "not a git repository (or any of the parent directories): .git")


def test_explicit_gitdir_failure_reads_differently():
    assert str(
        NotARepositoryError("/tmp/x")) == ("not a git repository: '/tmp/x'")


def test_unresolvable_revision_carries_gits_three_line_hint():
    # Pinned against git 2.47.3, which answers unknown ref, unmatched
    # short sha and walked-off-the-end ancestry with this one wording.
    assert str(AmbiguousArgumentError("HEAD~9")) == (
        "ambiguous argument 'HEAD~9': unknown revision or path not in the "
        "working tree.\n"
        "Use '--' to separate paths from revisions, like this:\n"
        "'git <command> [<revision>...] -- [<file>...]'")


def test_bad_date_names_both_the_flag_and_the_value():
    assert str(BadDateError(
        "--since",
        "2 weeks ago")) == ("invalid date format for --since: 2 weeks ago "
                            "(expected ISO-8601 or an epoch second)")


def test_missing_worktree_matches_gits_wording():
    assert str(
        NoWorkspaceError()) == ("this operation must be run in a work tree")


def test_unusable_directory_option_reads_like_gits_chdir_failure():
    assert str(NoWorkingDirectoryError("build")) == (
        "cannot change to 'build': No such file or directory")


def test_a_directory_option_naming_a_file_says_which_reason():
    assert str(NoWorkingDirectoryError(
        "a.txt",
        "Not a directory")) == ("cannot change to 'a.txt': Not a directory")


def test_a_bad_start_point_names_the_branch_it_would_have_made():
    assert str(BadStartPointError("nosuchrev", "shiny")) == (
        "'nosuchrev' is not a commit and a branch 'shiny' cannot be created "
        "from it")


def test_resetting_to_a_revision_says_which_feature_is_missing():
    assert str(RevisionResetError("HEAD~1")) == (
        "cannot reset to 'HEAD~1': this build resets the index from HEAD only")

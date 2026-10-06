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
from dulwich.objects import Commit
from dulwich.repo import Repo

from mirage.commands.cli.builtin.git import GIT
from mirage.commands.cli.builtin.git.errors import BadDateError, GitError
from mirage.commands.cli.builtin.git.format import subject
from mirage.commands.cli.builtin.git.history import (
    decoration_style,
    parse_flags,
    select,
)
from mirage.commands.cli.builtin.git.types import Decoration
from mirage.commands.spec import parse_command, parse_to_kwargs
from mirage.commands.spec.flag_view import FlagView
from tests.commands.cli.builtin.git.conftest import commit_file

NO_FLAGS: dict[str, object] = {}


def head_of(repo: Repo) -> Commit:
    """The commit HEAD points at.

    Args:
        repo (Repo): the repository to read.
    """
    commit = repo[repo.refs[b"HEAD"]]
    assert isinstance(commit, Commit)
    return commit


def subjects(repo_path, flags: dict[str, object]) -> list[str]:
    """Subjects of the commits a log invocation would print.

    Args:
        repo_path (Path): the repository's working tree.
        flags (dict[str, object]): raw flag kwargs.
    """
    with Repo(str(repo_path)) as repo:
        parsed = parse_flags(FlagView(flags))
        return [subject(c) for c in select(repo, [head_of(repo)], parsed)]


def test_flags_default_to_off():
    parsed = parse_flags(FlagView(NO_FLAGS))
    assert parsed.max_count is None
    assert not parsed.oneline
    assert not parsed.reverse
    assert parsed.search is None
    assert parsed.since is None and parsed.until is None


def test_iso_dates_are_read_as_epoch_seconds():
    parsed = parse_flags(FlagView({"since": "2026-01-16T11:10:00+00:00"}))
    assert parsed.since == 1768561800.0


def test_a_bare_epoch_second_is_accepted():
    assert parse_flags(FlagView({"until": "1768561800"})).until == 1768561800.0


def test_wording_git_accepts_but_we_do_not_is_refused_loudly():
    # git reads "2 weeks ago"; we do not. Refusing beats ignoring, which
    # would silently widen the window rather than narrow it.
    with pytest.raises(BadDateError):
        parse_flags(FlagView({"since": "2 weeks ago"}))


def test_history_is_newest_first(repo_path):
    assert subjects(repo_path, NO_FLAGS) == ["third", "second", "first"]


def test_max_count_cuts_from_the_newest_end(repo_path):
    assert subjects(repo_path, {"max_count": 2}) == ["third", "second"]


def test_reverse_flips_the_whole_walk(repo_path):
    assert subjects(repo_path, {"reverse": True}) == [
        "first",
        "second",
        "third",
    ]


def test_limit_applies_before_reverse(repo_path):
    # git cuts to -n against the newest commits and only then reverses,
    # so this is the newest one, not the oldest.
    assert subjects(repo_path, {"max_count": 1, "reverse": True}) == ["third"]


def test_pickaxe_selects_only_commits_that_change_the_count(repo_path):
    # "one" survives the third commit's rewrite to "one changed", so its
    # count never moves and only the commit that introduced it matches.
    assert subjects(repo_path, {"S": "one"}) == ["first"]


def test_pickaxe_with_reverse_names_the_introducing_commit(repo_path):
    assert subjects(repo_path, {"S": "changed", "reverse": True}) == ["third"]


def test_pickaxe_limit_counts_survivors_not_commits_visited(repo_path):
    # -n cannot be pushed into the walker while a pickaxe is active: the
    # limit counts commits that pass the filter. Two commits are newer
    # than the match, so a naive push-down would return nothing.
    assert subjects(repo_path, {"S": "one", "max_count": 1}) == ["first"]


def test_since_drops_everything_older(repo_path):
    with Repo(str(repo_path)) as repo:
        newest = head_of(repo).commit_time
    assert subjects(repo_path, {"since": str(newest + 60)}) == []


@pytest.mark.parametrize(
    "argv,expected",
    [
        (["--date-order", "--topo-order"], "topo"),
        (["--topo-order", "--date-order"], "date"),
        (["--topo-order", "--date-order", "--topo-order"], "topo"),
        (["--graph", "--date-order", "--topo-order"], "topo"),
        (["--date-order", "--graph"], "date"),
        (["-S", "--topo-order", "--date-order"], "date"),
    ],
)
def test_order_options_follow_the_last_typed_occurrence(argv, expected):
    spec = next(node for node in GIT.subcommands if node.name == "log")
    parsed = parse_command(spec, argv, "/")
    assert parse_flags(FlagView(parse_to_kwargs(parsed))).order == expected


def log_subjects(repo_path, argv: list[str]) -> list[str]:
    """Subjects of the commits ``git log <argv>`` would print.

    Args:
        repo_path (Path): the repository's working tree.
        argv (list[str]): the words after ``git log``.
    """
    spec = next(node for node in GIT.subcommands if node.name == "log")
    return subjects(repo_path, parse_to_kwargs(parse_command(spec, argv, "/")))


@pytest.mark.parametrize(
    "argv",
    [
        ["--max-count=2"],
        ["--max-count", "2"],
        ["-n", "2"],
        ["-n2"],
        ["-2"],
    ],
)
def test_every_spelling_of_the_count_cuts_the_same(repo_path, argv):
    assert log_subjects(repo_path, argv) == ["third", "second"]


@pytest.mark.parametrize(
    "argv,expected",
    [
        (["-n", "3", "--max-count=1"], ["third"]),
        (["--max-count=1", "-n", "3"], ["third", "second", "first"]),
        (["--max-count=-1"], ["third", "second", "first"]),
        (["-n", "-5"], ["third", "second", "first"]),
    ],
)
def test_the_last_count_wins_and_a_negative_one_is_no_limit(
    repo_path, argv, expected
):
    assert log_subjects(repo_path, argv) == expected


def test_grep_matches_a_line_of_the_body(repo_path):
    commit_file(repo_path, "c.txt", "c\n", "fourth\n\nMentions a needle.\n")
    assert log_subjects(repo_path, ["--grep=^Mentions"]) == ["fourth"]
    assert log_subjects(repo_path, ["--grep=^fourth.*needle"]) == []


def test_several_greps_are_alternatives(repo_path):
    assert log_subjects(repo_path, ["--grep=first", "--grep", "third"]) == [
        "third",
        "first",
    ]


def test_grep_never_reads_the_author(repo_path):
    assert log_subjects(repo_path, ["--grep=Test Author"]) == []


def test_the_count_applies_after_grep_and_before_reverse(repo_path):
    assert log_subjects(repo_path, ["--grep=ir", "--max-count=1"]) == ["third"]
    assert log_subjects(
        repo_path, ["--grep=ir", "--max-count=2", "--reverse"]
    ) == ["first", "third"]


@pytest.mark.parametrize("flag", ["-i", "--regexp-ignore-case"])
def test_ignore_case_reaches_grep_author_and_pickaxe(repo_path, flag):
    assert log_subjects(repo_path, ["--grep=THIRD"]) == []
    assert log_subjects(repo_path, ["--grep=THIRD", flag]) == ["third"]
    assert log_subjects(repo_path, ["--author=TEST AUTHOR"]) == []
    assert log_subjects(repo_path, ["--author=TEST AUTHOR", flag]) == [
        "third",
        "second",
        "first",
    ]
    assert log_subjects(repo_path, ["-S", "ONE"]) == []
    assert log_subjects(repo_path, ["-S", "ONE", flag]) == ["first"]


def test_author_and_grep_must_both_match(repo_path):
    assert log_subjects(repo_path, ["--author=Test", "--grep=second"]) == [
        "second"
    ]
    assert log_subjects(repo_path, ["--author=absent", "--grep=second"]) == []


@pytest.mark.parametrize(
    "argv,expected",
    [
        (["-E", "--grep=first|third"], ["third", "first"]),
        (["-E", "-F", "--grep=first|third"], []),
        (["-F", "-E", "--grep=first|third"], ["third", "first"]),
        (["--basic-regexp", "--grep=first|third"], []),
        (["-P", r"--grep=^\p{Ll}hird$"], ["third"]),
        (["-P", r"--grep=[\d]"], []),
        (["-P", "--grep=[[:alpha:]]irst"], ["first"]),
        (["-P", "--grep=f(?=irst)"], ["first"]),
        (["-P", "-i", "--grep=^THIRD$"], ["third"]),
        (["-P", "--grep=(?i)^THIRD$"], ["third"]),
        (["-P", r"--grep=\Athird\z"], ["third"]),
    ],
)
def test_the_last_pattern_syntax_reads_every_pattern(
    repo_path, argv, expected
):
    assert log_subjects(repo_path, argv) == expected


@pytest.mark.parametrize(
    "argv,message",
    [
        (["--grep=\\("], "command line, '\\(': Unmatched ( or \\("),
        (["--author=\\("], "header, '\\(': Unmatched ( or \\("),
        (["--committer=\\("], "header, '\\(': Unmatched ( or \\("),
    ],
)
def test_a_refused_pattern_names_where_it_came_from(argv, message):
    spec = next(node for node in GIT.subcommands if node.name == "log")
    kwargs = parse_to_kwargs(parse_command(spec, argv, "/"))
    with pytest.raises(GitError) as caught:
        parse_flags(FlagView(kwargs))
    assert str(caught.value) == message


@pytest.mark.parametrize(
    "pattern,line",
    [
        (r"a\-b\_c\ d", "a-b_c d"),
        ("[]x]", "]"),
        ("a{x}", "a{x}"),
    ],
)
def test_perl_punctuation_escapes_are_literal(pattern, line):
    flags = parse_flags(FlagView({"perl_regexp": True, "grep": [pattern]}))
    assert flags.greps[0].search(line)


@pytest.mark.parametrize(
    ("value", "style"),
    [
        (b"short", Decoration.SHORT),
        (b"full", Decoration.FULL),
        (b"no", Decoration.NONE),
        (b"", Decoration.NONE),
        (b"1", Decoration.SHORT),
        (b"auto", Decoration.NONE),
        (b"bogus", None),
        (b"Full", None),
    ],
)
def test_decoration_style_names_git_styles(
    value: bytes, style: Decoration | None
):
    assert decoration_style(value) is style

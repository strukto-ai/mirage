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

from mirage.commands.cli.builtin.git.errors import BadDateError
from mirage.commands.cli.builtin.git.format import subject
from mirage.commands.cli.builtin.git.history import parse_flags, select
from mirage.commands.spec.types import FlagView

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
    assert subjects(repo_path, {"n": 2}) == ["third", "second"]


def test_reverse_flips_the_whole_walk(repo_path):
    assert subjects(repo_path,
                    {"reverse": True}) == ["first", "second", "third"]


def test_limit_applies_before_reverse(repo_path):
    # git cuts to -n against the newest commits and only then reverses,
    # so this is the newest one, not the oldest.
    assert subjects(repo_path, {"n": 1, "reverse": True}) == ["third"]


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
    assert subjects(repo_path, {"S": "one", "n": 1}) == ["first"]


def test_since_drops_everything_older(repo_path):
    with Repo(str(repo_path)) as repo:
        newest = head_of(repo).commit_time
    assert subjects(repo_path, {"since": str(newest + 60)}) == []

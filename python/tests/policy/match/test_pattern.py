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

from mirage.policy.match.pattern import (
    pattern_matches,
    pattern_reaches,
    split_pattern,
)


def test_split_pattern_drops_trailing_wildcards_only():
    assert split_pattern("git push") == ("git", "push")
    assert split_pattern("git *") == ("git",)
    assert split_pattern("git * *") == ("git",)
    assert split_pattern("git * --hard") == ("git", "*", "--hard")
    assert split_pattern("  rm  ") == ("rm",)
    assert split_pattern("*") == ()


def test_pattern_matches_is_a_token_prefix():
    assert pattern_matches("rm", ("rm", "-rf", "/x"))
    assert pattern_matches("rm", ("rm",))
    assert not pattern_matches("rm", ("rmdir",))
    assert pattern_matches("git push", ("git", "push", "origin", "main"))
    assert not pattern_matches("git push", ("git", "pull"))
    assert not pattern_matches("git push", ("git",))
    assert pattern_matches(
        "git reset --hard", ("git", "reset", "--hard", "HEAD")
    )
    assert not pattern_matches(
        "git reset --hard", ("git", "reset", "HEAD", "--hard")
    )
    # A wildcard token is any one token; trailing it is redundant.
    assert pattern_matches("git * --hard", ("git", "reset", "--hard"))
    assert not pattern_matches("git * --hard", ("git", "reset", "--soft"))
    assert pattern_matches("git *", ("git",))
    assert pattern_matches("*", ("anything", "at", "all"))


def test_pattern_reaches_a_command_a_line_of_it_starts():
    assert pattern_reaches("git log", ("git",))
    assert not pattern_reaches("git log", ("log",))
    assert pattern_reaches("*", ("rm",))


def test_pattern_reaches_reads_only_the_words_the_two_share():
    # The pattern runs past the path: one line of that group is
    # allowed, so the group is reachable.
    assert pattern_reaches("linear issue list", ("linear", "issue"))
    assert pattern_reaches("linear issue list", ("linear",))
    # The path runs past the pattern: already covered.
    assert pattern_reaches("linear issue", ("linear", "issue", "list"))
    # A word they share disagrees, at any depth.
    assert not pattern_reaches("linear issue list", ("linear", "team"))
    assert not pattern_reaches(
        "linear issue list", ("linear", "issue", "create")
    )
    assert not pattern_reaches("linear issue", ("gws", "issue"))
    # A wildcard is any one word, and a trailing one is dropped, so
    # `linear issue *` reaches every leaf of that group.
    assert pattern_reaches("linear * list", ("linear", "team", "list"))
    assert pattern_reaches("linear issue *", ("linear", "issue", "create"))
    assert pattern_reaches("*", ("anything", "at", "all"))
    # An empty path asks nothing, so nothing can refuse it.
    assert pattern_reaches("linear issue", ())

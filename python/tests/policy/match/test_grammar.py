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

from mirage.commands.spec import SPECS
from mirage.commands.spec.types import Argument, CommandSpec
from mirage.policy.match.grammar import (
    allow_patterns,
    bind,
    pattern_reads,
    read_pattern,
)
from mirage.policy.types import (
    AdmissionRules,
    AllowFlags,
    CommandRule,
    FlagFact,
    Grammar,
)

RM = Grammar(SPECS["rm"])

GIT = Grammar(
    CommandSpec(
        name="git",
        subcommands=(
            CommandSpec(name="log"),
            CommandSpec(
                name="push",
                arguments=(
                    Argument("-f", "--force", action="store_true"),
                    Argument("remote", nargs="?"),
                ),
            ),
            CommandSpec(
                name="add",
                arguments=(
                    Argument("-f", "--force", action="store_true"),
                    Argument("paths", nargs="*"),
                ),
            ),
        ),
    ),
    tree=True,
)


@pytest.mark.parametrize(
    "words",
    [
        ("rm", "-rf"),
        ("rm", "-fr"),
        ("rm", "-r", "-f"),
        ("rm", "-R", "--force"),
        ("rm", "--recursive", "--force"),
    ],
)
def test_every_spelling_of_an_option_reads_as_its_canonical_name(words):
    read = read_pattern(RM, words)
    assert read is not None
    assert read.path == ("rm",)
    assert {f.name for f in read.flags} == {"--recursive", "--force"}


def test_a_pattern_keeps_an_option_value_and_a_bare_option_matches_any():
    head = Grammar(SPECS["head"])
    valued = read_pattern(head, ("head", "-n", "2"))
    bare = read_pattern(head, ("head", "-n"))
    assert valued is not None and bare is not None
    assert valued.flags == (FlagFact("--lines", ("2",)),)
    assert bare.flags == (FlagFact("--lines"),)


def test_a_long_option_written_by_a_prefix_is_not_read():
    assert read_pattern(RM, ("rm", "--rec")) is None


def test_a_subcommand_star_binds_to_the_lines_subcommand():
    assert bind(GIT, ("git", "*", "--force"), ("git", "push")) == (
        ("git", "push", "--force"),
        True,
    )
    assert bind(GIT, ("git", "*"), ("git",)) is None
    assert bind(RM, ("rm", "*"), ("rm",)) == (("rm", "*"), False)


def test_a_star_pattern_on_a_leaf_without_the_option_reads_as_none():
    rules = AdmissionRules(
        deny=(CommandRule(reason="no", commands=("git * --force",)),)
    )
    reads = dict(pattern_reads(rules, ("git", "log"), GIT))
    assert reads == {"git * --force": None}
    reads = dict(pattern_reads(rules, ("git", "add"), GIT))
    read = reads["git * --force"]
    assert read is not None
    assert read.path == ("git", "add")


def test_a_pattern_the_grammar_refuses_is_left_to_word_matching():
    rules = AdmissionRules(
        deny=(CommandRule(reason="no", commands=("rm --rec", "rm -f")),)
    )
    reads = dict(pattern_reads(rules, ("rm",), RM))
    assert "rm --rec" not in reads
    assert reads["rm -f"] is not None


def test_allow_patterns_expand_groups_and_join_a_flag_set():
    rules = AdmissionRules(
        allow=("gh pr {view,diff}", AllowFlags("rm", ("-f", "-v")))
    )
    assert allow_patterns(rules) == ("gh pr view", "gh pr diff", "rm -f -v")

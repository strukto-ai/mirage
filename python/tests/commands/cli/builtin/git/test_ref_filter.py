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

from mirage.commands.cli.builtin.git import GIT
from mirage.commands.cli.builtin.git.ref_filter import (
    FilterWord,
    filter_words,
    list_mode_option,
    without_filter_values,
)
from mirage.commands.cli.types import CLIInvocation


def _words(verb: str, *argv: str) -> list[FilterWord]:
    spec = next(node for node in GIT.spec.subcommands if node.name == verb)
    return filter_words(
        CLIInvocation(None, argv=(verb, *argv), texts=(), flags={}, spec=spec)
    )


# parse-options' LASTARG_DEFAULT: the next word, whatever it looks like,
# or HEAD when the option is the last word on the line.
def test_takes_the_next_word_as_the_commit_or_head_as_the_last_word():
    assert _words("branch", "--merged", "main", "--contains") == [
        FilterWord("--merged", "main", True),
        FilterWord("--contains", "HEAD", False),
    ]


def test_takes_a_dash_word_too_which_the_parser_read_as_an_option():
    assert _words("branch", "--merged", "--no-merged") == [
        FilterWord("--merged", "--no-merged", False),
    ]


def test_reads_an_attached_value_and_a_unique_prefix():
    assert _words("branch", "--cont=side", "--no-merged", "x") == [
        FilterWord("--contains", "side", False),
        FilterWord("--no-merged", "x", True),
    ]


def test_leaves_another_options_value_alone_even_one_spelling_a_filter():
    assert _words("tag", "-a", "-m", "--contains", "v1") == []
    assert _words("tag", "-m--contains", "--merged", "v1") == [
        FilterWord("--merged", "v1", True),
    ]


def test_stops_at_the_marker_where_the_parser_stops():
    assert _words("branch", "--", "--contains", "x") == []


def test_takes_points_at_as_a_value_option_the_parser_consumed():
    assert _words("tag", "--points-at", "HEAD") == [
        FilterWord("--points-at", "HEAD", False),
    ]


def test_drops_the_values_the_parser_left_among_the_operands_once_each():
    found = _words("branch", "--contains", "side", "side", "x*")
    assert without_filter_values(("side", "side", "x*"), found) == (
        "side",
        "x*",
    )


def test_names_the_filter_git_refuses_first_in_gits_order():
    assert (
        list_mode_option(_words("tag", "--merged", "a", "--contains", "b"))
        == "--contains"
    )
    assert list_mode_option([]) is None

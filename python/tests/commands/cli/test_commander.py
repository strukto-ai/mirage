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

from mirage.commands.cli.commander import (
    edit_distance,
    excess_arguments,
    missing_value,
    option_flags,
    suggest_similar,
    unknown_option,
)
from mirage.commands.spec.types import Argument, CommandSpec

LEAF = CommandSpec(
    name="search",
    arguments=(
        Argument("--depth", metavar="value"),
        Argument("--max-results", metavar="n"),
        Argument("--max-chars", metavar="n"),
        Argument("-o", "--output", nargs="?", metavar="file"),
        Argument("--json", action="store_true"),
    ),
)


def test_a_transposition_is_one_edit():
    assert edit_distance("dpeth", "depth") == 1
    assert edit_distance("dept", "depth") == 1
    assert edit_distance("abc", "abcdefgh") == 8


def test_the_closest_option_is_suggested():
    assert suggest_similar("--dept", ["--depth", "--json"]) == (
        "\n(Did you mean --depth?)"
    )


def test_options_at_the_same_distance_are_all_named_in_order():
    assert suggest_similar("--max-char", ["--max-results", "--max-chars"]) == (
        "\n(Did you mean --max-chars?)"
    )
    assert suggest_similar("--ab", ["--ac", "--aa"]) == (
        "\n(Did you mean one of --aa, --ac?)"
    )


def test_nothing_close_suggests_nothing():
    assert suggest_similar("--zzzzzz", ["--depth", "--json"]) == ""


def test_an_unknown_long_option_names_its_close_match():
    assert unknown_option("--jsn", [LEAF]) == (
        "error: unknown option '--jsn'\n(Did you mean --json?)\n"
    )


def test_an_unknown_short_option_gets_no_suggestion():
    assert unknown_option("-j", [LEAF]) == "error: unknown option '-j'\n"


def test_an_option_is_spelled_with_its_value_shape():
    assert option_flags(LEAF.arguments[1]) == "--max-results <n>"
    assert option_flags(LEAF.arguments[3]) == "-o, --output [file]"
    assert option_flags(LEAF.arguments[4]) == "--json"


def test_a_value_left_off_names_the_option_as_its_help_spells_it():
    assert missing_value("--max-results", LEAF) == (
        "error: option '--max-results <n>' argument missing\n"
    )
    assert missing_value("--nope", LEAF) is None


def test_stray_operands_are_counted_and_listed():
    assert excess_arguments(["frob", "x"]) == (
        "error: too many arguments. Expected 0 arguments but got 2: frob, x.\n"
    )
    assert excess_arguments(["a"], "auth") == (
        "error: too many arguments for 'auth'. Expected 0 arguments but "
        "got 1: a.\n"
    )

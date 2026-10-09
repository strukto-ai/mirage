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

from mirage.commands.spec import SPECS, parse_command, parse_to_kwargs
from mirage.commands.spec.constants import OPERAND, REFUSED
from mirage.commands.spec.flag_view import FlagBag, FlagView, spec_flag_names
from mirage.commands.spec.types import Argument, CommandSpec
from mirage.types import PathSpec


def test_flag_view_typed_reads():
    path = PathSpec.from_str_path("hidden/../file", cwd="/repo")
    fl = FlagView(
        {
            "i": True,
            "m": "5",
            "type": "py",
            "e": ["a", "b"],
            "file": path,
            "files": [path],
        }
    )
    assert fl.as_bool("i") is True
    assert fl.as_bool("v") is False
    assert fl.as_int("m") == 5
    assert fl.as_int("A") is None
    assert fl.as_str("type") == "py"
    assert fl.as_str("glob") is None
    assert fl.as_list("e") == ["a", "b"]
    assert fl.as_list("f") == []
    assert fl.as_path("file") is path
    assert fl.as_paths("files") == [path]
    assert fl.as_str("file") is None
    assert fl.as_list("files") == []


def test_flag_view_list_coerces_single_string():
    fl = FlagView({"e": "solo"})
    assert fl.as_list("e") == ["solo"]


def test_flag_view_without_spec_is_lenient():
    fl = FlagView({"anything": True})
    assert fl.as_bool("anything") is True
    assert fl.as_bool("missing") is False


def test_flag_view_with_spec_rejects_unknown_names():
    fl = FlagView({"i": True}, spec=SPECS["grep"])
    assert fl.as_bool("i") is True
    with pytest.raises(KeyError, match="ignorecase"):
        fl.as_bool("ignorecase")
    with pytest.raises(KeyError):
        fl.as_int("max_count")
    with pytest.raises(KeyError):
        fl.as_list("patterns")


def test_spec_flag_names_are_canonical_and_ambiguous_mapped():
    # One name per option: the long spelling wins when both exist, so a
    # stale short-name read raises through FlagView instead of silently
    # reading False after dest unification.
    spec = CommandSpec(
        arguments=(
            Argument("-l", action="store_true"),
            Argument("-m", "--max-count"),
            Argument("--hidden", action="store_true"),
        )
    )
    names = spec_flag_names(spec)
    assert names == frozenset({"args_l", "max_count", "hidden"})


def test_flag_view_count_value_reads_as_int_and_bool():
    fl = FlagView({"verbose": 3})
    assert fl.as_int("verbose") == 3
    assert fl.as_bool("verbose") is True
    assert FlagView({"verbose": 0}).as_bool("verbose") is False


def test_flag_view_bool_never_reads_as_int():
    fl = FlagView({"append": True})
    assert fl.as_int("append") is None
    assert fl.as_bool("append") is True


def test_flag_view_float_reads():
    fl = FlagView({"ratio": "2.5", "rate": "1e3", "verbose": 3})
    assert fl.as_float("ratio") == 2.5
    assert fl.as_float("rate") == 1000.0
    assert fl.as_float("verbose") == 3.0
    assert fl.as_float("missing") is None
    assert FlagView({"append": True}).as_float("append") is None


def test_flag_view_typed_order_follows_bag_insertion():
    fl = FlagView({"exclude": ["a"], "n": True, "include": ["b"]})
    assert fl.typed_order("include", "exclude") == ["exclude", "include"]
    assert fl.typed_order("include") == ["include"]
    assert fl.typed_order("color") == []


def _jq_view(*words: str) -> FlagView:
    return FlagView(
        parse_to_kwargs(parse_command(SPECS["jq"], list(words), "/", "jq")),
        spec=SPECS["jq"],
    )


def test_occurrences_read_operands_where_they_were_typed():
    fl = _jq_view("-c", ".", "--args", "a", "--jsonargs", "1")
    assert fl.occurrences("args", "jsonargs", OPERAND) == [
        (OPERAND, "."),
        ("args", True),
        (OPERAND, "a"),
        ("jsonargs", True),
        (OPERAND, "1"),
    ]
    assert fl.occurrences(OPERAND) == [
        (OPERAND, "."),
        (OPERAND, "a"),
        (OPERAND, "1"),
    ]


def test_occurrences_read_refusals_where_they_were_typed():
    fl = _jq_view("-n", ".", "--bogus", "--args", "a")
    assert fl.occurrences("args", OPERAND, REFUSED) == [
        (OPERAND, "."),
        (REFUSED, "--bogus"),
        ("args", True),
        (OPERAND, "a"),
    ]
    assert fl.occurrences("args") == [("args", True)]


def test_occurrences_leave_operands_out_unless_asked():
    fl = _jq_view(".", "--args", "a", "-c")
    assert fl.occurrences("compact_output", "args") == [
        ("args", True),
        ("compact_output", True),
    ]


def test_occurrences_of_keyword_flags_have_no_operands():
    fl = FlagView({"args": True}, spec=SPECS["jq"])
    assert fl.occurrences("args", OPERAND) == [("args", True)]


def test_a_copied_bag_keeps_its_operands():
    bag = parse_to_kwargs(
        parse_command(SPECS["jq"], [".", "--args", "a"], "/", "jq")
    )
    assert FlagBag(bag).occurrences == [
        (OPERAND, "."),
        ("args", True),
        (OPERAND, "a"),
    ]

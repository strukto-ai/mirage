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

from mirage.commands.spec.compile import (
    compile_spec,
    expand_git_long,
    expand_long,
    expand_table_long,
)
from mirage.commands.spec.constants import TAR_LONG_OPTIONS
from mirage.commands.spec.types import Argument, CommandSpec


def test_dest_prefers_long_and_keeps_short_only_identity():
    spec = CommandSpec(
        arguments=(
            Argument("-a", "--append", action="store_true"),
            Argument("-e", action="append"),
            Argument("--color", nargs="?", attached_only=True),
        )
    )
    cs = compile_spec(spec)
    assert cs.dest_of("-a") == "--append"
    assert cs.dest_of("--append") == "--append"
    assert cs.dest_of("-e") == "-e"
    assert cs.dest_of("--color") == "--color"


def test_multiple_dests_are_canonical():
    spec = CommandSpec(arguments=(Argument("-k", "--key", action="append"),))
    cs = compile_spec(spec)
    assert cs.multiple_dests == frozenset({"--key"})


def test_value_spellings_ordered_longest_first():
    # -name must win an attached match over -n, deterministically, not by
    # set iteration order.
    spec = CommandSpec(
        arguments=(
            Argument("-n"),
            Argument("-name"),
        )
    )
    cs = compile_spec(spec)
    assert cs.value_spellings == ("-name", "-n")


def test_numeric_dest_is_canonical():
    spec = CommandSpec(
        arguments=(Argument("-n", "--lines", numeric_shorthand=True),)
    )
    cs = compile_spec(spec)
    assert cs.numeric_dest == "--lines"


def test_kind_tables_split_spelling_and_dest():
    spec = CommandSpec(
        arguments=(
            Argument("-f", "--file", type="path"),
            Argument("texts", nargs="*", metavar=""),
        )
    )
    cs = compile_spec(spec)
    assert cs.kind_of["-f"] == "path"
    assert cs.kind_of["--file"] == "path"
    assert cs.kind_by_dest == {"--file": "path"}
    assert cs.rest_kind == "str"


def test_compile_is_cached_per_spec():
    spec = CommandSpec(arguments=(Argument("-x", action="store_true"),))
    assert compile_spec(spec) is compile_spec(spec)


def test_option_requires_a_spelling():
    with pytest.raises(ValueError, match="requires a name or option spelling"):
        compile_spec(CommandSpec(arguments=(Argument(action="store_true"),)))


@pytest.mark.parametrize(
    "options",
    (
        (Argument("-m", action="store_true"), Argument("-m")),
        (
            Argument("--mode", action="store_true"),
            Argument("--mode"),
        ),
    ),
)
def test_duplicate_option_spellings_are_spec_errors(options):
    with pytest.raises(ValueError, match="duplicate option spelling"):
        compile_spec(CommandSpec(arguments=(*options,)))


def test_count_choices_required_default_tables():
    spec = CommandSpec(
        arguments=(
            Argument("-v", "--verbose", action="count"),
            Argument("--mode", choices=("a", "b"), default="a"),
            Argument("--out", required=True),
        )
    )
    cs = compile_spec(spec)
    assert cs.count_dests == frozenset({"--verbose"})
    assert cs.choices_by_dest == {"--mode": ("a", "b")}
    assert cs.required_dests == ("--out",)
    assert cs.defaults == {"--mode": "a"}


def test_count_cannot_consume_values():
    spec = CommandSpec(
        arguments=(Argument("--level", action="count", nargs=1),)
    )
    try:
        compile_spec(spec)
    except ValueError as exc:
        assert "zero-token actions cannot declare nargs" in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_choices_on_a_boolean_flag_is_a_spec_error():
    spec = CommandSpec(
        arguments=(
            Argument("--quiet", action="store_true", choices=("a", "b")),
        )
    )
    try:
        compile_spec(spec)
    except ValueError as exc:
        assert "require a value flag" in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_default_outside_choices_is_a_spec_error():
    spec = CommandSpec(
        arguments=(Argument("--mode", choices=("a", "b"), default="c"),)
    )
    try:
        compile_spec(spec)
    except ValueError as exc:
        assert "not one of its choices" in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_type_float_default_must_be_a_number():
    with pytest.raises(ValueError, match="is not a number"):
        compile_spec(
            CommandSpec(
                arguments=(Argument("--ratio", type="float", default="fast"),)
            )
        )


def test_type_int_default_must_be_an_integer():
    with pytest.raises(ValueError, match="is not an integer"):
        compile_spec(
            CommandSpec(
                arguments=(Argument("--port", type="int", default="auto"),)
            )
        )


def test_expand_long_exact_prefix_ambiguous_and_unknown():
    cs = compile_spec(
        CommandSpec(
            arguments=(
                Argument("--binary", action="store_true"),
                Argument("--binary-files"),
                Argument("--count", action="store_true"),
            )
        )
    )
    assert expand_long(cs, "--binary") == ("--binary",)
    assert expand_long(cs, "--bin") == ("--binary", "--binary-files")
    assert expand_long(cs, "--co") == ("--count",)
    assert expand_long(cs, "--zz") == ()
    assert expand_long(cs, "--") == ()


def test_expand_long_folds_only_named_synonyms():
    # Two options of one shape are still two options; only a named synonym
    # folds a shared prefix into one (glibc's entries sharing one `val`).
    cs = compile_spec(
        CommandSpec(
            arguments=(
                Argument("--color", action="store_true"),
                Argument("--colour", action="store_true"),
                Argument("--count", action="store_true"),
            )
        )
    )
    assert expand_long(cs, "--col") == ("--color", "--colour")
    same = {"--colour": "--color"}
    assert expand_long(cs, "--col", same) == ("--color",)
    assert expand_long(cs, "--co", same) == ("--color", "--colour", "--count")


def test_pair_on_a_boolean_flag_is_a_spec_error():
    spec = CommandSpec(
        arguments=(Argument("--arg", action="store_true", nargs=2),)
    )
    with pytest.raises(
        ValueError, match="zero-token actions cannot declare nargs"
    ):
        compile_spec(spec)


# git 2.50.1's `branch` and `show-ref` tables, as far as these cases reach.
BRANCH = (
    "[no-]verbose",
    "[no-]color",
    "contains",
    "no-contains",
    "[no-]move",
    "merged",
    "no-merged",
)
SHOW_REF = ("[no-]heads", "[no-]head")


def test_git_long_lets_an_exact_name_win_over_a_longer_one():
    assert expand_git_long(SHOW_REF, "--head") == "--head"


def test_git_long_expands_a_unique_abbreviation_no_included():
    assert expand_git_long(BRANCH, "--verb") == "--verbose"
    assert expand_git_long(BRANCH, "--no-verb") == "--no-verbose"
    assert expand_git_long(BRANCH, "--no-cont") == "--no-contains"


def test_git_long_names_the_last_two_candidates_of_an_ambiguity():
    assert expand_git_long(BRANCH, "--no-m") == ("--no-move", "--no-merged")
    assert expand_git_long(SHOW_REF, "--hea") == ("--heads", "--head")


def test_git_long_answers_nothing_for_a_word_no_option_starts_with():
    assert expand_git_long(BRANCH, "--zzz") is None
    assert expand_git_long((), "--verb") is None


@pytest.mark.parametrize(
    "typed,found",
    [
        # An entry spelled exactly names its option, an alias its primary.
        ("--file", ("--file",)),
        ("--get", ("--extract",)),
        ("--ungzip", ("--gzip",)),
        # A prefix one option owns resolves, its aliases included.
        ("--crea", ("--create",)),
        ("--gun", ("--gzip",)),
        ("--dir", ("--directory",)),
        ("--vers", ("--version",)),
        # A prefix of two options is ambiguous in table order, an option
        # mirage never declared included (GNU tar 1.35's own lines).
        ("--fil", ("--file", "--files-from")),
        ("--li", ("--list", "--listed-incremental")),
        ("--us", ("--use-compress-program", "--usage")),
        (
            "--ver",
            ("--verify", "--verbose", "--verbatim-files-from", "--version"),
        ),
        ("--to", ("--to-stdout", "--to-command", "--touch", "--totals")),
        ("--zzz", ()),
        ("--", ()),
    ],
)
def test_table_long_resolves_as_the_programs_getopt_long_does(typed, found):
    assert expand_table_long(TAR_LONG_OPTIONS, typed) == found


def test_table_long_lists_every_later_candidate_naming_another_option():
    # glibc compares each later match with the FIRST one only, so a later
    # alias of a third option is listed beside its own primary.
    table = (("--apple",), ("--apricot", "--apron"), ("--ape",))
    assert expand_table_long(table, "--ap") == (
        "--apple",
        "--apricot",
        "--apron",
        "--ape",
    )
    assert expand_table_long((("--apricot", "--apron"),), "--apr") == (
        "--apricot",
    )


@pytest.mark.parametrize(
    "argument, message",
    [
        (Argument("name", "--name"), "cannot mix positional"),
        (
            Argument("name", required=True),
            "requiredness is expressed with nargs",
        ),
        (Argument("--color", attached_only=True), "attached_only requires"),
        (Argument("--value", nargs=0), "invalid nargs"),
        (Argument("--value", nargs="*"), "variadic nargs belongs"),
    ],
)
def test_unified_argument_rejects_ambiguous_declarations(argument, message):
    with pytest.raises(ValueError, match=message):
        compile_spec(CommandSpec(arguments=(argument,)))


def test_variadic_positional_must_be_terminal():
    spec = CommandSpec(
        arguments=(Argument("files", nargs="*"), Argument("destination"))
    )
    with pytest.raises(ValueError, match="must be last"):
        compile_spec(spec)


def test_positional_default_is_rejected_until_supported():
    with pytest.raises(
        ValueError, match="positional defaults are not supported"
    ):
        compile_spec(
            CommandSpec(arguments=(Argument("path", nargs="?", default="."),))
        )

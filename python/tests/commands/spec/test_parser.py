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
from mirage.commands.spec.builtin_specs import registered_spec
from mirage.commands.spec.compile import compile_spec
from mirage.commands.spec.parser import parse_command, parse_to_kwargs
from mirage.commands.spec.types import CommandSpec, Operand, Option


def _registered(name: str) -> CommandSpec:
    """The spec the registry parses for a builtin, --help/--version and all.

    Args:
        name (str): the builtin's name.
    """
    return registered_spec(name, SPECS[name])


def test_grep_positional_pattern_then_path():
    parsed = parse_command(SPECS["grep"], ["orange", "/data/a.txt"], "/")
    assert parsed.texts() == ["orange"]
    assert parsed.paths() == ["/data/a.txt"]


def test_grep_dash_e_frees_positional_slot_for_path():
    parsed = parse_command(SPECS["grep"], ["-e", "orange", "/data/a.txt"], "/")
    assert parsed.flags["-e"] == ["orange"]
    assert parsed.texts() == []
    assert parsed.paths() == ["/data/a.txt"]


def test_grep_dash_e_with_flags_and_multiple_paths():
    parsed = parse_command(SPECS["grep"],
                           ["-n", "-e", "pat", "/a.txt", "/b.txt"], "/")
    assert parsed.flags["-n"] is True
    assert parsed.flags["-e"] == ["pat"]
    assert parsed.paths() == ["/a.txt", "/b.txt"]


def test_grep_dash_e_without_path_leaves_args_empty():
    parsed = parse_command(SPECS["grep"], ["-e", "orange"], "/")
    assert parsed.texts() == []
    assert parsed.paths() == []


def test_zgrep_dash_e_frees_positional_slot_for_path():
    parsed = parse_command(SPECS["zgrep"], ["-e", "orange", "/data/a.gz"], "/")
    assert parsed.flags["-e"] == ["orange"]
    assert parsed.texts() == []
    assert parsed.paths() == ["/data/a.gz"]


def test_grep_repeated_dash_e_accumulates_newline_joined():
    parsed = parse_command(SPECS["grep"], ["-e", "foo", "-e", "bar", "/a.txt"],
                           "/")
    assert parsed.flags["-e"] == ["foo", "bar"]
    assert parsed.texts() == []
    assert parsed.paths() == ["/a.txt"]


def test_grep_repeated_dash_e_attached_value_accumulates():
    parsed = parse_command(SPECS["grep"], ["-e", "foo", "-ebar", "/a.txt"],
                           "/")
    assert parsed.flags["-e"] == ["foo", "bar"]
    assert parsed.paths() == ["/a.txt"]


def test_non_multiple_value_flag_keeps_last_value():
    parsed = parse_command(SPECS["grep"], ["-m", "1", "-m", "2", "pat"], "/")
    assert parsed.flags["-m"] == "2"


def test_provided_by_only_skips_slot_when_flag_present():
    spec = CommandSpec(
        options=(Option(short="-e", type="str"), ),
        positional=(Operand(type="str", provided_by=("-e", )), ),
        rest=Operand(type="path"),
    )
    with_flag = parse_command(spec, ["-e", "pat", "/x"], "/")
    assert with_flag.paths() == ["/x"]
    without_flag = parse_command(spec, ["pat", "/x"], "/")
    assert without_flag.texts() == ["pat"]
    assert without_flag.paths() == ["/x"]


def test_grep_dash_f_frees_positional_and_routes_pattern_file():
    parsed = parse_command(SPECS["grep"], ["-f", "pats.txt", "a.txt"], "/data")
    assert parsed.flags["--file"] == ["/data/pats.txt"]
    assert parsed.texts() == []
    assert parsed.paths() == ["/data/a.txt"]
    assert "/data/pats.txt" in parsed.routing_paths()


def test_optional_long_path_value_routes_attached_argument():
    parsed = parse_command(SPECS["mktemp"], ["--tmpdir=staging", "file.XXXX"],
                           "/data")
    assert parsed.flags["--tmpdir"] == "/data/staging"
    assert parsed.path_flag_values == ["/data/staging"]


def test_grep_dash_e_and_dash_f_together():
    parsed = parse_command(SPECS["grep"],
                           ["-e", "foo", "-f", "/p.txt", "/a.txt"], "/")
    assert parsed.flags["-e"] == ["foo"]
    assert parsed.flags["--file"] == ["/p.txt"]
    assert parsed.paths() == ["/a.txt"]


def test_grep_repeated_dash_f_accumulates_and_routes_each_file():
    parsed = parse_command(SPECS["grep"],
                           ["-f", "p1.txt", "-f", "p2.txt", "a.txt"], "/data")
    assert parsed.flags["--file"] == ["/data/p1.txt", "/data/p2.txt"]
    assert parsed.paths() == ["/data/a.txt"]
    assert "/data/p1.txt" in parsed.routing_paths()
    assert "/data/p2.txt" in parsed.routing_paths()


def test_rg_dash_e_frees_positional_and_accumulates():
    parsed = parse_command(SPECS["rg"], ["-e", "foo", "-e", "bar", "/x"], "/")
    assert parsed.flags["--regexp"] == ["foo", "bar"]
    assert parsed.texts() == []
    assert parsed.paths() == ["/x"]


def test_rg_dash_f_dash_stays_stdin_as_grep_does():
    # Resolved against the cwd, `-` became a pattern file named `/-`.
    parsed = parse_command(SPECS["rg"], ["-f", "-", "/a.txt"],
                           "/data",
                           cmd_name="rg")
    assert parsed.flags["--file"] == ["-"]
    assert parsed.paths() == ["/a.txt"]


def test_long_value_flag_equals_syntax():
    parsed = parse_command(SPECS["du"], ["--max-depth=1", "/data"], "/")
    assert parsed.flags["--max-depth"] == "1"
    assert parsed.paths() == ["/data"]


def test_long_value_flag_equals_syntax_rg():
    parsed = parse_command(SPECS["rg"], ["--type=md", "pat", "/x"], "/")
    assert parsed.flags["--type"] == ["md"]
    assert parsed.texts() == ["pat"]
    assert parsed.paths() == ["/x"]


def test_unknown_long_flag_reported_as_invalid():
    parsed = parse_command(SPECS["grep"], ["--bogus=x", "pat", "/a.txt"], "/")
    assert "--bogus" not in parsed.flags
    assert parsed.texts() == ["pat"]
    assert parsed.paths() == ["/a.txt"]
    assert parsed.invalid_options == ["--bogus=x"]
    assert parsed.warnings == []


def test_cluster_ending_in_value_flag_consumes_next_arg():
    parsed = parse_command(SPECS["grep"], ["-ne", "pat", "/a.txt"], "/")
    assert parsed.flags["-n"] is True
    assert parsed.flags["-e"] == ["pat"]
    assert parsed.texts() == []
    assert parsed.paths() == ["/a.txt"]


def test_cluster_ending_in_value_flag_with_attached_value():
    parsed = parse_command(SPECS["grep"], ["-nepat", "/a.txt"], "/")
    assert parsed.flags["-n"] is True
    assert parsed.flags["-e"] == ["pat"]
    assert parsed.paths() == ["/a.txt"]


def test_cluster_bool_then_count_flag_value():
    parsed = parse_command(SPECS["grep"], ["-im1", "pat", "/a.txt"], "/")
    assert parsed.flags["-i"] is True
    assert parsed.flags["-m"] == "1"
    assert parsed.texts() == ["pat"]
    assert parsed.paths() == ["/a.txt"]


def test_cluster_with_unknown_char_reports_offending_char():
    parsed = parse_command(SPECS["grep"], ["-nx", "pat", "/a.txt"], "/")
    assert "-n" not in parsed.flags
    assert parsed.texts() == ["pat"]
    assert parsed.paths() == ["/a.txt"]
    assert parsed.invalid_options == ["x"]


def test_unknown_long_flag_reported_bare():
    parsed = parse_command(SPECS["grep"], ["--bogus", "pat", "/a.txt"], "/")
    assert parsed.texts() == ["pat"]
    assert parsed.paths() == ["/a.txt"]
    assert parsed.invalid_options == ["--bogus"]


def test_missing_value_reported_short_and_long():
    parsed = parse_command(SPECS["grep"], ["-m"], "/")
    assert parsed.needs_value_options == ["m"]
    parsed = parse_command(SPECS["du"], ["--max-depth"], "/")
    assert parsed.needs_value_options == ["--max-depth"]
    parsed = parse_command(SPECS["grep"], ["-ne"], "/")
    assert parsed.needs_value_options == ["e"]


def test_an_operand_class_command_keeps_unknown_dash_tokens():
    parsed = parse_command(SPECS["expr"], ["-x", "hello"], "/", "expr")
    assert parsed.texts() == ["-x", "hello"]
    assert parsed.warnings == []


# The rest operand's kind used to decide this and cannot: basename,
# dirname, csplit, numfmt and sleep all declare a TEXT rest and all five
# report an option they do not know (measured on coreutils 9.4).
def test_a_text_rest_command_reports_an_unknown_long_option():
    parsed = parse_command(SPECS["basename"], ["--zzz"], "/", "basename")
    assert parsed.invalid_options == ["--zzz"]
    assert parsed.option_error_kinds == ["invalid"]
    assert parsed.texts() == []


def test_a_text_rest_command_reports_an_unknown_short_option():
    parsed = parse_command(SPECS["basename"], ["-Q"], "/", "basename")
    assert parsed.invalid_options == ["Q"]
    assert parsed.texts() == []


# An unnamed parse gets the rule, not the exception: the sets are keyed
# by command name and "" is in neither.
def test_an_unnamed_parse_is_a_strict_getopt_long_parse():
    parsed = parse_command(SPECS["basename"], ["--zzz"], "/")
    assert parsed.invalid_options == ["--zzz"]


# unknown_is_operand is what an installed CLI's node is parsed under:
# the program owns whatever mirage does not declare, so an undeclared
# dash word lands in the node's textual rest slot and no abbreviation is
# expanded on the program's behalf.
def test_unknown_is_operand_forwards_dash_words_into_the_rest_slot():
    spec = CommandSpec(options=(Option(long="--width", type="int"), ),
                       rest=Operand(type="str"))
    parsed = parse_command(spec, ["--widt", "80", "-n", "x"],
                           "/",
                           "pager",
                           unknown_is_operand=True)
    assert parsed.flags == {}
    assert parsed.invalid_options == []
    assert parsed.texts() == ["--widt", "80", "-n", "x"]


# With no slot to forward into, the same parse refuses it: the program
# cannot be handed a word the node has nowhere to put.
def test_unknown_is_operand_without_a_rest_slot_still_refuses():
    spec = CommandSpec(options=(Option(long="--width", type="int"), ))
    parsed = parse_command(spec, ["--frobnicate"],
                           "/",
                           "pager",
                           unknown_is_operand=True)
    assert parsed.invalid_options == ["--frobnicate"]


# The very same spec parsed without the flag is the other answer, which
# is what makes the call the deciding fact: nothing about the grammar,
# and nothing carried on the spec, tells the two apart.
def test_the_same_spec_parsed_strictly_refuses_the_dash_word():
    spec = CommandSpec(options=(Option(long="--width", type="int"), ),
                       rest=Operand(type="str"))
    parsed = parse_command(spec, ["--widt", "80", "-n", "x"], "/", "pager")
    assert parsed.flags == {"--width": "80"}
    assert parsed.invalid_options == ["n"]


def test_numeric_dash_token_stays_operand():
    parsed = parse_command(SPECS["grep"], ["-5", "pat"], "/")
    assert parsed.texts() == ["-5"]
    assert parsed.warnings == []


def test_known_flags_produce_no_warnings():
    parsed = parse_command(SPECS["grep"], ["-n", "-e", "pat", "/a.txt"], "/")
    assert parsed.warnings == []


def test_find_multichar_short_flag_still_works():
    parsed = parse_command(SPECS["find"], ["/data", "-name", "*.txt"], "/")
    assert parsed.flags["-name"] == ["*.txt"]


def test_cluster_into_multiple_flag_accumulates():
    parsed = parse_command(SPECS["grep"],
                           ["-ne", "foo", "-e", "bar", "/a.txt"], "/")
    assert parsed.flags["-n"] is True
    assert parsed.flags["-e"] == ["foo", "bar"]
    assert parsed.paths() == ["/a.txt"]


def test_long_equals_and_separate_multiple_accumulate():
    spec = CommandSpec(
        options=(Option(long="--tag", type="str", multiple=True), ),
        rest=Operand(type="path"),
    )
    parsed = parse_command(spec, ["--tag=a", "--tag", "b", "/x"], "/")
    assert parsed.flags["--tag"] == ["a", "b"]
    assert parsed.paths() == ["/x"]


def test_awk_repeated_dash_v_accumulates():
    parsed = parse_command(
        SPECS["awk"],
        ["-v", "a=1", "-v", "b=2", "{print a, b}", "/data/x.txt"], "/")
    assert parsed.flags["-v"] == ["a=1", "b=2"]
    assert parsed.texts() == ["{print a, b}"]
    assert parsed.paths() == ["/data/x.txt"]


def test_awk_dash_f_frees_positional_slot_for_paths():
    parsed = parse_command(SPECS["awk"],
                           ["-f", "/prog.awk", "/data/a.txt", "/data/b.txt"],
                           "/")
    assert parsed.texts() == []
    assert parsed.paths() == ["/data/a.txt", "/data/b.txt"]


def test_awk_repeated_dash_f_accumulates_and_routes_each_file():
    parsed = parse_command(SPECS["awk"],
                           ["-f", "/p1.awk", "-f", "/p2.awk", "/data/a.txt"],
                           "/")
    assert parsed.flags["-f"] == ["/p1.awk", "/p2.awk"]
    assert parsed.texts() == []
    assert parsed.paths() == ["/data/a.txt"]


def test_value_optional_bare_is_boolean():
    parsed = parse_command(SPECS["grep"], ["--color", "world", "/a.txt"], "/")
    assert parsed.flags["--color"] is True
    assert parsed.texts() == ["world"]
    assert parsed.paths() == ["/a.txt"]
    assert parsed.warnings == []


def test_value_optional_equals_form_carries_value():
    parsed = parse_command(SPECS["grep"], ["--color=auto", "world", "/a.txt"],
                           "/")
    assert parsed.flags["--color"] == "auto"
    assert parsed.texts() == ["world"]
    assert parsed.warnings == []


def test_value_optional_never_consumes_next_token():
    parsed = parse_command(SPECS["ls"], ["--color", "/data"], "/")
    assert parsed.flags["--color"] is True
    assert parsed.paths() == ["/data"]


def test_short_value_false_keeps_short_boolean_and_clusterable():
    # GNU cp -b never takes an argument: -bv is a cluster, never -b=v.
    # Both spellings land on the canonical long dest.
    clustered = parse_command(SPECS["cp"], ["-bv", "/a", "/b"], "/")
    assert clustered.flags["--backup"] is True
    assert clustered.flags["--verbose"] is True
    bare = parse_command(SPECS["cp"], ["-u", "/a", "/b"], "/")
    assert bare.flags["--update"] is True
    assert bare.paths() == ["/a", "/b"]
    valued = parse_command(SPECS["cp"], ["--backup=numbered", "/a", "/b"], "/")
    assert valued.flags["--backup"] == "numbered"


def test_short_value_optional_uses_only_attached_value():
    # date's -I[FMT] is getopt's `I::`: the value only rides attached,
    # and a detached word stays an operand (coreutils 9.7).
    bare = parse_command(SPECS["date"], ["-I", "-d", "now", "+%F"], "/")
    attached = parse_command(SPECS["date"], ["-Is", "+%F"], "/")
    assert bare.flags["--iso-8601"] is True
    assert bare.flags["--date"] == "now"
    assert bare.texts() == ["+%F"]
    assert attached.flags["--iso-8601"] == "seconds"


def test_optional_value_short_takes_the_rest_of_a_cluster():
    # getopt's `I::` inside a cluster: whatever follows the letter is its
    # value, and nothing after it leaves it bare (coreutils 9.7:
    # `date -uIs` is `date -u -Is`, `date -uI` is `date -u -I`).
    valued = parse_command(SPECS["date"], ["-uIs"], "/")
    assert valued.flags["--utc"] is True
    assert valued.flags["--iso-8601"] == "seconds"
    assert valued.invalid_options == []
    bare = parse_command(SPECS["date"], ["-uI"], "/")
    assert bare.flags["--iso-8601"] is True


def test_plain_short_of_an_optional_long_refuses_an_attached_value():
    # GNU mkdir's -Z takes no argument, only --context= does, so -vZ is a
    # cluster and -Zfoo refuses the `f` (coreutils 9.7).
    clustered = parse_command(SPECS["mkdir"], ["-vZ", "/d"], "/")
    assert clustered.flags["--verbose"] is True
    assert clustered.flags["--context"] is True
    attached = parse_command(SPECS["mkdir"], ["-Zfoo", "/d"], "/")
    assert attached.invalid_options == ["f"]
    valued = parse_command(SPECS["mkdir"], ["--context=ctx", "/d"], "/")
    assert valued.flags["--context"] == "ctx"


def test_overflow_operands_pass_through_like_last_slot():
    parsed = parse_command(SPECS["uniq"], ["a.txt", "b.txt", "c.txt"],
                           cwd="/data")
    assert [k for _, k in parsed.args] == ["path"] * 3

    parsed = parse_command(SPECS["tr"], ["a", "b", "extra.txt"], cwd="/data")
    assert [k for _, k in parsed.args] == ["str"] * 3


def test_spellings_share_one_dest_and_honor_command_line_order():
    # GNU treats -u and --update as one option, so the last occurrence on
    # the line decides regardless of spelling (pinned against GNU
    # coreutils 9.7). One canonical key, no per-spelling mirror.
    short_last = parse_command(SPECS["cp"], ["--update=all", "-u", "/a", "/b"],
                               "/")
    assert short_last.flags["--update"] is True
    assert "-u" not in short_last.flags
    long_last = parse_command(SPECS["cp"], ["-u", "--update=all", "/a", "/b"],
                              "/")
    assert long_last.flags["--update"] == "all"


def test_multiple_accumulates_across_spellings_in_line_order():
    # sort -k/--key is ONE option: values interleave in true command-line
    # order. The old per-spelling lists lost interleaving (-k1 --key=2 -k3
    # concatenated as [1, 3, 2]).
    parsed = parse_command(SPECS["sort"], ["-k1", "--key=2", "-k3", "/f"], "/")
    assert parsed.flags["--key"] == ["1", "2", "3"]
    assert "-k" not in parsed.flags


def test_attached_short_value_lands_on_canonical_dest():
    # The attached-value spelling (`-Ih`) unifies too, so last-wins holds
    # for `--long=` and the short form alike.
    attached = parse_command(SPECS["date"], ["-Ih"], "/")
    assert attached.flags["--iso-8601"] == "hours"
    assert "-I" not in attached.flags
    short_last = parse_command(SPECS["date"], ["--iso-8601=ns", "-Ih"], "/")
    assert short_last.flags["--iso-8601"] == "hours"
    long_last = parse_command(SPECS["date"], ["-Ih", "--iso-8601=ns"], "/")
    assert long_last.flags["--iso-8601"] == "ns"


def test_digit_options_build_split_line_count():
    # split's getopt string lists the digits: those of one word build the
    # count wherever they sit, a later word replaces it, and -d stays a
    # plain flag (coreutils 9.7: `split -d10` is -d and ten lines).
    for argv in (["-d10"], ["-10d"], ["-1d0"], ["-d", "-10"]):
        parsed = parse_command(SPECS["split"], argv + ["/in"], "/", "split")
        assert parsed.flags["--numeric-suffixes"] is True, argv
        assert parsed.flags["--lines"] == "10", argv
        assert parsed.invalid_options == [], argv
    later = parse_command(SPECS["split"], ["-12", "-5", "/in"], "/", "split")
    assert later.flags["--lines"] == "5"
    valued = parse_command(SPECS["split"], ["--numeric-suffixes=3", "/in"],
                           "/", "split")
    assert valued.flags["--numeric-suffixes"] == "3"


def test_digit_options_are_the_builtin_programs_own():
    # A mount's own command borrowing the name gets getopt's plain rule.
    spec = CommandSpec(options=(Option(
        short="-d"), Option(short="-l", type="str", numeric_shorthand=True)))
    parsed = parse_command(spec, ["-d10"], "/", "split")
    assert parsed.invalid_options == ["1"]


def test_count_flag_accumulates_occurrences():
    spec = CommandSpec(options=(Option(short="-v",
                                       long="--verbose",
                                       count=True), ),
                       rest=Operand(type="path"))
    packed = parse_command(spec, ["-vvv", "/f"], "/")
    assert packed.flags["--verbose"] == 3
    separate = parse_command(spec, ["-v", "--verbose", "-v", "/f"], "/")
    assert separate.flags["--verbose"] == 3
    absent = parse_command(spec, ["/f"], "/")
    assert "--verbose" not in absent.flags


def test_choices_violation_is_reported_not_raised():
    parsed = parse_command(SPECS["tee"], ["--output-error=bogus", "/f"], "/",
                           "tee")
    assert parsed.invalid_value_options == [
        ("--output-error", "bogus", ("warn", "warn-nopipe", "exit",
                                     "exit-nopipe")),
    ]
    ok = parse_command(SPECS["tee"], ["--output-error=warn", "/f"], "/", "tee")
    assert ok.invalid_value_options == []


# `tee --output-error` is one of the three spec-declared choices sets
# that really are gnulib ARGMATCH tables, so the parser resolves a
# prefix and rewrites the bag to the canonical word. Measured on
# coreutils 9.7: `tee --output-error=exit-n` exits 0 (exit-nopipe) and
# `=w` is `ambiguous argument 'w'`.
def test_an_unambiguous_prefix_resolves_to_the_canonical_word():
    parsed = parse_command(SPECS["tee"], ["--output-error=warn-", "/f"], "/",
                           "tee")
    assert parsed.flags["--output-error"] == "warn-nopipe"
    assert parsed.invalid_value_options == []
    assert parsed.ambiguous_value_options == []


def test_an_exact_word_is_left_alone_and_not_read_as_a_prefix():
    parsed = parse_command(SPECS["tee"], ["--output-error=warn", "/f"], "/",
                           "tee")
    assert parsed.flags["--output-error"] == "warn"
    assert parsed.invalid_value_options == []


# The second table, so the rule is the option's and not one command's:
# measured on 9.7, `numfmt --to=s` is `si` and `--to=ie` is ambiguous
# between `iec` and `iec-i`.
def test_the_other_argmatch_table_resolves_its_own_prefixes():
    parsed = parse_command(SPECS["numfmt"], ["--to=s", "1"], "/", "numfmt")
    assert parsed.flags["--to"] == "si"
    assert parsed.ambiguous_value_options == []
    ambiguous = parse_command(SPECS["numfmt"], ["--to=ie", "1"], "/", "numfmt")
    assert ambiguous.option_error_kinds == ["ambiguous_value"]
    assert ambiguous.ambiguous_value_options == [
        ("--to", "ie", ("none", "si", "iec", "iec-i")),
    ]


def test_an_ambiguous_prefix_lands_in_its_own_list_and_on_the_tape():
    parsed = parse_command(SPECS["tee"], ["--output-error=w", "/f"], "/",
                           "tee")
    assert parsed.option_error_kinds == ["ambiguous_value"]
    assert parsed.ambiguous_value_options == [
        ("--output-error", "w", ("warn", "warn-nopipe", "exit",
                                 "exit-nopipe")),
    ]
    assert parsed.invalid_value_options == []
    # The value the line typed stays in the bag: nothing resolved it, and
    # the renderer names the word as typed.
    assert parsed.flags["--output-error"] == "w"


def test_the_empty_value_is_reported_ambiguous_not_invalid():
    parsed = parse_command(SPECS["tee"], ["--output-error=", "/f"], "/", "tee")
    assert parsed.ambiguous_value_options == [
        ("--output-error", "", ("warn", "warn-nopipe", "exit", "exit-nopipe")),
    ]


def test_prefix_matching_is_case_sensitive():
    parsed = parse_command(SPECS["tee"], ["--output-error=W", "/f"], "/",
                           "tee")
    assert parsed.invalid_value_options == [
        ("--output-error", "W", ("warn", "warn-nopipe", "exit",
                                 "exit-nopipe")),
    ]


# Prefix matching is opt-in per (command, option), so a choices set that
# is NOT one of the three compares the whole word, which is argparse's
# own rule for `choices`. CPython is the measured case: on 3.11.15
# `--check-hash-based-pycs a` and `al` are both refused where gnulib
# would have resolved them to `always`.
def test_a_choices_set_outside_the_table_takes_no_prefix():
    parsed = parse_command(SPECS["python3"],
                           ["--check-hash-based-pycs=a", "-c", "x"], "/",
                           "python3")
    assert parsed.flags["--check-hash-based-pycs"] == "a"
    assert parsed.invalid_value_options == [
        ("--check-hash-based-pycs", "a", ("always", "default", "never")),
    ]


def test_a_choices_set_outside_the_table_still_takes_the_exact_word():
    parsed = parse_command(SPECS["python3"],
                           ["--check-hash-based-pycs=always", "-c", "x"], "/",
                           "python3")
    assert parsed.flags["--check-hash-based-pycs"] == "always"
    assert parsed.invalid_value_options == []


# The empty word has no ambiguity wording to reach outside the table:
# nothing is an exact match, so it is invalid like any other
# non-candidate, and ambiguous_value_options stays empty.
def test_a_choices_set_outside_the_table_reports_the_empty_word_invalid():
    parsed = parse_command(SPECS["python3"],
                           ["--check-hash-based-pycs=", "-c", "x"], "/",
                           "python3")
    assert parsed.invalid_value_options == [
        ("--check-hash-based-pycs", "", ("always", "default", "never")),
    ]
    assert parsed.ambiguous_value_options == []


# A mount author's own command is not a GNU program, so its choices are
# argparse's: `--mode=rem` is refused rather than resolved to `remove`.
# Nothing the author can write opts a custom spec into the table, which
# names three builtin Option OBJECTS and is tested by identity.
def test_a_custom_spec_never_inherits_argmatch():
    spec = CommandSpec(
        options=(Option(long="--mode", type="str", choices=("read",
                                                            "remove")), ))
    parsed = parse_command(spec, ["--mode=rem"], "/", "mycmd")
    assert parsed.flags["--mode"] == "rem"
    assert parsed.invalid_value_options == [
        ("--mode", "rem", ("read", "remove")),
    ]
    # Even naming it after a real ARGMATCH option changes nothing.
    named = CommandSpec(
        options=(Option(long="--to", type="str", choices=("none", "si")), ))
    assert parse_command(named, ["--to=s"], "/",
                         "mycmd").invalid_value_options == [
                             ("--to", "s", ("none", "si")),
                         ]


# A mount may register a command under a builtin's own name, so the
# name is not the identity. A custom `tee` that reproduces GNU tee's
# `--output-error` field for field still compares the whole word: the
# option it declares is its own object, not the one the builtin spec
# holds. Option is a frozen dataclass, so this lookalike is `==` to the
# builtin's and hashes with it -- only `is` tells them apart, which is
# why the table is not a frozenset of options.
def test_a_command_that_borrows_a_builtin_name_does_not_borrow_argmatch():
    lookalike = Option(long="--output-error",
                       type="str",
                       value_optional=True,
                       choices=("warn", "warn-nopipe", "exit", "exit-nopipe"))
    builtin = next(o for o in SPECS["tee"].options
                   if o.long == "--output-error")
    assert lookalike == builtin and lookalike is not builtin
    parsed = parse_command(CommandSpec(options=(lookalike, )),
                           ["--output-error=exit-n"], "/", "tee")
    assert parsed.flags["--output-error"] == "exit-n"
    assert parsed.invalid_value_options == [
        ("--output-error", "exit-n", ("warn", "warn-nopipe", "exit",
                                      "exit-nopipe")),
    ]


# The registry never hands the parser the spec the builtin declared: it
# appends --help/--version and parses the COPY (commands/config.py), so
# `spec is SPECS[name]` is False for every builtin by the time a line is
# read. Identity of the Option survives that copy, which is the whole
# reason the table names options rather than specs -- keying on the spec
# would disable ARGMATCH everywhere while every unit test that passes
# SPECS[name] straight in kept passing.
def test_argmatch_survives_the_copy_the_registry_parses():
    tee = SPECS["tee"]
    registered = registered_spec("tee", tee)
    assert registered is not tee
    parsed = parse_command(registered, ["--output-error=exit-n"], "/", "tee")
    assert parsed.flags["--output-error"] == "exit-nopipe"
    assert parsed.invalid_value_options == []


# compile_spec caches on a frozen dataclass, so its key is STRUCTURAL: a
# spec built to look exactly like tee's shares the builtin's CompiledSpec
# object. The ARGMATCH decision is therefore read off the spec and never
# stored in there -- stored, it would be whichever of the two compiled
# first, and the order is whatever the process happened to do. Both
# directions are checked because the wrong one is order-dependent: the
# clone inheriting argmatch, and the real tee losing it.
def test_a_structural_twin_of_a_builtin_spec_shares_no_argmatch():
    tee = SPECS["tee"]
    twin = CommandSpec(options=tuple(
        Option(**{f: getattr(o, f)
                  for f in o.__dataclass_fields__}) for o in tee.options),
                       rest=tee.rest,
                       description=tee.description)
    assert twin == tee and twin is not tee
    assert compile_spec(twin) is compile_spec(tee)
    assert parse_command(twin, ["--output-error=exit-n"], "/",
                         "tee").invalid_value_options == [
                             ("--output-error", "exit-n",
                              ("warn", "warn-nopipe", "exit", "exit-nopipe")),
                         ]
    # and the builtin still resolves, whichever was compiled first
    assert parse_command(tee, ["--output-error=exit-n"], "/",
                         "tee").flags["--output-error"] == "exit-nopipe"


# An installed CLI's node is outside the table for the same reason, so
# `gh issue list --state=o` is refused where GNU would resolve it. The
# CLI's group level already enforces its choices exactly
# (walk._finish_node), so a leaf that prefix-matched would make one
# Option.choices mean two things inside one tree. unknown_is_operand
# says nothing about this: it governs the dash word, not the value.
def test_a_cli_node_compares_the_whole_choice_word():
    spec = CommandSpec(options=(
        Option(long="--state", type="str", choices=("open", "closed",
                                                    "all")), ))
    parsed = parse_command(spec, ["--state=o"],
                           "/",
                           "gh",
                           unknown_is_operand=True)
    assert parsed.flags["--state"] == "o"
    assert parsed.invalid_value_options == [
        ("--state", "o", ("open", "closed", "all")),
    ]
    exact = parse_command(spec, ["--state=open"],
                          "/",
                          "gh",
                          unknown_is_operand=True)
    assert exact.flags["--state"] == "open"
    assert exact.invalid_value_options == []
    # The same spec parsed without the flag answers identically, which
    # is the point: the choice rule is the table's, not the call's.
    strict = parse_command(spec, ["--state=o"], "/", "gh")
    assert strict.invalid_value_options == [
        ("--state", "o", ("open", "closed", "all")),
    ]


def test_choices_exempt_bare_optional_value_form():
    parsed = parse_command(SPECS["tee"], ["--output-error", "/f"], "/", "tee")
    assert parsed.flags["--output-error"] is True
    assert parsed.invalid_value_options == []


def test_choices_check_every_value_of_a_multiple_flag():
    spec = CommandSpec(options=(
        Option(short="-m", type="str", multiple=True, choices=("x", "y")), ))
    parsed = parse_command(spec, ["-m", "x", "-m", "z"], "/")
    assert parsed.invalid_value_options == [("-m", "z", ("x", "y"))]


def test_every_occurrence_of_an_argmatch_flag_is_resolved_as_it_is_read():
    # Each occurrence goes through the table as it is scanned, so the one
    # the bag drops is still refused and the one it keeps is still
    # rewritten to its candidate.
    parsed = parse_command(SPECS["numfmt"], ["--to=ie", "--to=s", "1"], "/",
                           "numfmt")
    assert parsed.flags["--to"] == "si"
    assert parsed.ambiguous_value_options == [
        ("--to", "ie", ("none", "si", "iec", "iec-i")),
    ]


def test_choices_check_every_occurrence_of_a_scalar_flag():
    # GNU refuses the argument as it is scanned (`numfmt --to=bogus
    # --to=si` is refused for bogus), so the value the bag dropped is
    # checked too, in line order.
    parsed = parse_command(SPECS["numfmt"], ["--to=bogus", "--to=si", "1"],
                           "/")
    assert parsed.flags["--to"] == "si"
    assert parsed.invalid_value_options == [
        ("--to", "bogus", ("none", "si", "iec", "iec-i")),
    ]
    ok = parse_command(SPECS["numfmt"], ["--to=si", "--to=si", "1"], "/")
    assert ok.invalid_value_options == []


def test_the_first_refused_value_on_the_line_is_reported_first():
    # GNU stops at the first bad argument it reads, whatever its option
    # and whatever check refuses it, so the kinds tape carries each
    # refusal's tag in scan order for the reporter to follow.
    spec = CommandSpec(options=(
        Option(short="-n", type="int"),
        Option(long="--mode", type="str", choices=("a", "b")),
    ))
    parsed = parse_command(spec, ["--mode", "bad", "-n", "abc"], "/")
    assert parsed.option_error_kinds == ["value", "int"]
    assert parsed.invalid_value_options == [("--mode", "bad", ("a", "b"))]
    assert parsed.invalid_int_options == [("-n", "abc")]
    parsed = parse_command(SPECS["numfmt"], ["--from=bad1", "--to=bad2", "1"],
                           "/")
    assert parsed.option_error_kinds == ["value", "value"]
    assert [dest for dest, _, _ in parsed.invalid_value_options
            ] == ["--from", "--to"]


def test_int_check_covers_every_occurrence_of_a_scalar_flag():
    spec = CommandSpec(options=(Option(short="-n", type="int"), ))
    parsed = parse_command(spec, ["-n", "abc", "-n", "3"], "/")
    assert parsed.flags["-n"] == "3"
    assert parsed.invalid_int_options == [("-n", "abc")]


def test_required_option_reported_when_absent():
    spec = CommandSpec(
        options=(Option(long="--out", type="str", required=True), ))
    missing = parse_command(spec, [], "/")
    assert missing.missing_required_options == ["--out"]
    present = parse_command(spec, ["--out", "x"], "/")
    assert present.missing_required_options == []


def test_default_lands_as_if_typed_and_satisfies_required():
    spec = CommandSpec(options=(
        Option(long="--mode", type="str", required=True, default="fast"), ))
    parsed = parse_command(spec, [], "/")
    assert parsed.flags["--mode"] == "fast"
    assert parsed.missing_required_options == []
    typed = parse_command(spec, ["--mode", "slow"], "/")
    assert typed.flags["--mode"] == "slow"


def test_path_default_resolves_and_routes():
    spec = CommandSpec(
        options=(Option(long="--file", type="path", default="cfg.txt"), ))
    parsed = parse_command(spec, [], "/data")
    assert parsed.flags["--file"] == "/data/cfg.txt"
    assert parsed.path_flag_values == ["/data/cfg.txt"]


def test_multiple_default_lands_as_one_element_list():
    spec = CommandSpec(options=(Option(short="-f",
                                       long="--file",
                                       type="path",
                                       multiple=True,
                                       default="cfg.txt"), ))
    parsed = parse_command(spec, [], "/data")
    assert parsed.flags["--file"] == ["/data/cfg.txt"]
    assert parsed.path_flag_values == ["/data/cfg.txt"]
    typed = parse_command(spec, ["-f", "a", "-f", "b"], "/data")
    assert typed.flags["--file"] == ["/data/a", "/data/b"]


def test_unique_long_prefix_expands_like_getopt_long():
    spec = CommandSpec(options=(Option(long="--recursive"),
                                Option(long="--count")))
    parsed = parse_command(spec, ["--rec", "x"], "/")
    assert parsed.flags["--recursive"] is True
    assert parsed.invalid_options == []
    assert parsed.ambiguous_options == []


def test_ambiguous_long_prefix_reports_possibilities_in_order():
    spec = CommandSpec(
        options=(Option(long="--context", type="str"),
                 Option(long="--color", value_optional=True, type="str"),
                 Option(long="--count")))
    parsed = parse_command(spec, ["--c"], "/")
    assert parsed.ambiguous_options == [("--c", ("--context", "--color",
                                                 "--count"))]
    assert parsed.invalid_options == []


def test_exact_long_wins_over_a_longer_spelling():
    spec = CommandSpec(options=(Option(long="--binary"),
                                Option(long="--binary-files", type="str")))
    parsed = parse_command(spec, ["--binary"], "/")
    assert parsed.flags["--binary"] is True
    assert parsed.ambiguous_options == []


def test_abbreviated_long_carries_an_attached_value():
    spec = CommandSpec(
        options=(Option(long="--color", value_optional=True, type="str"), ))
    parsed = parse_command(spec, ["--colo=never"], "/")
    assert parsed.flags["--color"] == "never"


def test_abbreviated_value_long_takes_the_next_word():
    spec = CommandSpec(options=(Option(long="--exclude", type="str"), ))
    parsed = parse_command(spec, ["--excl", "tmp"], "/")
    assert parsed.flags["--exclude"] == "tmp"


# A program with no long-option parser at all (bash's echo builtin,
# Info-ZIP unzip) never expands an abbreviation, because there is no
# table to expand against.
def test_a_program_with_no_long_option_parser_matches_exactly():
    parsed = parse_command(_registered("echo"), ["--hel", "hi"], "/", "echo")
    assert parsed.flags == {}
    assert parsed.texts() == ["--hel", "hi"]


def test_the_same_line_expands_the_abbreviation_for_a_getopt_command():
    parsed = parse_command(_registered("basename"), ["--hel", "hi"], "/",
                           "basename")
    assert parsed.flags["--help"] is True
    assert parsed.texts() == ["hi"]


# Both tables describe one real program, so a spec that is not that
# program's own grammar does not get the rule however the line names it.
# A mount may register a command under a builtin's name: nothing refuses
# that, and here the rule would swallow the flag the author declared.
def test_a_custom_spec_never_inherits_a_per_program_parsing_rule():
    spec = CommandSpec(options=(Option(long="--mode", type="str"), ),
                       rest=Operand(type="str"))
    parsed = parse_command(spec, ["--mode=x", "value"], "/", "expr")
    assert parsed.flags == {"--mode": "x"}
    assert parsed.texts() == ["value"]
    # ... and the same spec keeps its long options where echo has none.
    lenient = CommandSpec(options=(Option(long="--verbose"), ),
                          rest=Operand(type="str"))
    assert parse_command(lenient, ["--verb", "hi"], "/",
                         "echo").flags["--verbose"] is True


# expr's long options are the two the registry injects into every spec,
# so the spec has to be the registered one: the declaration carries
# neither, and a hand-built lookalike is no longer expr's grammar.
_EXPR_SPEC = _registered("expr")


# gnulib's parse_long_options guards on `argc == 2`, so expr reads a long
# option only when it is the whole line. Measured on coreutils 9.4:
# `expr --help` helps, `expr --help x` is a syntax error on `x`, and
# `expr -- --help` prints `--help`.
def test_a_sole_argument_long_option_is_read_as_an_option():
    parsed = parse_command(_EXPR_SPEC, ["--help"], "/", "expr")
    assert parsed.flags["--help"] is True
    assert parsed.texts() == []


def test_a_sole_argument_long_option_prefix_resolves():
    parsed = parse_command(_EXPR_SPEC, ["--h"], "/", "expr")
    assert parsed.flags["--help"] is True


def test_a_sole_argument_word_that_prefixes_nothing_is_an_operand():
    parsed = parse_command(_EXPR_SPEC, ["--hex"], "/", "expr")
    assert parsed.flags == {}
    assert parsed.invalid_options == []
    assert parsed.texts() == ["--hex"]


def test_a_long_option_outside_the_window_is_an_operand():
    parsed = parse_command(_EXPR_SPEC, ["--help", "x"], "/", "expr")
    assert parsed.flags == {}
    assert parsed.invalid_options == []
    assert parsed.texts() == ["--help", "x"]


def test_dash_dash_puts_the_sole_argument_outside_the_window():
    parsed = parse_command(_EXPR_SPEC, ["--", "--help"], "/", "expr")
    assert parsed.flags == {}
    assert parsed.texts() == ["--help"]


def test_int_typed_value_is_reported_not_raised():
    spec = CommandSpec(options=(Option(long="--port", type="int"), ))
    parsed = parse_command(spec, ["--port", "abc"], "/")
    assert parsed.invalid_int_options == [("--port", "abc")]
    ok = parse_command(spec, ["--port", "-42"], "/")
    assert ok.invalid_int_options == []
    assert ok.flags["--port"] == "-42"


def test_int_typed_multiple_checks_every_value():
    spec = CommandSpec(
        options=(Option(long="--id", multiple=True, type="int"), ))
    parsed = parse_command(spec, ["--id", "1", "--id", "x"], "/")
    assert parsed.invalid_int_options == [("--id", "x")]


def test_typed_values_reject_unicode_digits():
    # python's \d also matches Unicode digits (int('١٢') is 12), which
    # JS /\d/ and GNU's C-locale parsers reject — both languages must
    # report the same strings invalid.
    int_spec = CommandSpec(options=(Option(long="--port", type="int"), ))
    parsed = parse_command(int_spec, ["--port", "١٢"], "/")
    assert parsed.invalid_int_options == [("--port", "١٢")]
    float_spec = CommandSpec(options=(Option(long="--q", type="float"), ))
    parsed = parse_command(float_spec, ["--q", "٣.٥"], "/")
    assert parsed.invalid_float_options == [("--q", "٣.٥")]


def test_synonym_spellings_resolve_a_shared_prefix_like_glibc():
    parsed = parse_command(SPECS["grep"], ["--colo", "pat", "/a.txt"], "/",
                           "grep")
    assert parsed.ambiguous_options == []
    assert parsed.flags["--color"] is True
    attached = parse_command(SPECS["grep"], ["--colo=never", "pat", "/a.txt"],
                             "/", "grep")
    assert attached.flags["--color"] == "never"
    utc = parse_command(SPECS["date"], ["--u"], "/", "date")
    assert utc.flags["--utc"] is True


def test_distinct_options_sharing_a_prefix_are_ambiguous():
    # Two declared options are two options, whatever their shape, so a
    # prefix of both is ambiguous, listed in GNU's table order
    # (coreutils 9.7).
    cases = [
        ("ls", ["--re", "/"], ("--reverse", "--recursive")),
        ("uname", ["--k"], ("--kernel-name", "--kernel-release",
                            "--kernel-version")),
        ("mv", ["--no-c", "/a", "/b"], ("--no-clobber", "--no-copy")),
        ("md5sum", ["--st", "/f"], ("--status", "--strict")),
        ("sort", ["--m", "/f"], ("--merge", "--month-sort")),
    ]
    for name, argv, possible in cases:
        parsed = parse_command(SPECS[name], argv, "/", name)
        assert parsed.ambiguous_options == [(argv[0], possible)], name


def test_ambiguity_lists_synonyms_like_gnu():
    spec = CommandSpec(
        options=(Option(long="--context", type="str"),
                 Option(long="--color", value_optional=True, type="str"),
                 Option(long="--colour", value_optional=True, type="str"),
                 Option(long="--count")))
    parsed = parse_command(spec, ["--c"], "/")
    assert parsed.ambiguous_options == [("--c", ("--context", "--color",
                                                 "--colour", "--count"))]


def test_option_error_kinds_keep_scan_order():
    spec = CommandSpec(options=(Option(long="--context", type="str"),
                                Option(long="--count")))
    parsed = parse_command(spec, ["--c", "--bogus"], "/")
    assert parsed.option_error_kinds == ["ambiguous", "invalid"]
    flipped = parse_command(spec, ["--bogus", "--c"], "/")
    assert flipped.option_error_kinds == ["invalid", "ambiguous"]


def test_float_typed_value_is_reported_not_raised():
    spec = CommandSpec(options=(Option(long="--ratio", type="float"), ))
    parsed = parse_command(spec, ["--ratio", "5x"], "/")
    assert parsed.invalid_float_options == [("--ratio", "5x")]
    for good in ("2.5", "-3", ".5", "1e3", "+0.25"):
        ok = parse_command(spec, ["--ratio", good], "/")
        assert ok.invalid_float_options == []
        assert ok.flags["--ratio"] == good
    for bad in ("inf", "nan", "1_000", "5x", "."):
        refused = parse_command(spec, ["--ratio", bad], "/")
        assert refused.invalid_float_options == [("--ratio", bad)]


def test_pair_option_consumes_two_tokens():
    parsed = parse_command(SPECS["jq"], ["--arg", "v", "hello", "-n", "$v"],
                           "/")
    assert parsed.flags["--arg"] == ["v", "hello"]
    assert parsed.texts() == ["$v"]
    assert parsed.paths() == []


def test_pair_option_accumulates_flattened_across_occurrences():
    parsed = parse_command(SPECS["jq"],
                           ["--arg", "a", "1", "--argjson", "b", "2", "."],
                           "/")
    assert parsed.flags["--arg"] == ["a", "1"]
    assert parsed.flags["--argjson"] == ["b", "2"]
    assert parsed.texts() == ["."]


def test_pair_option_value_is_never_taken_as_a_path():
    parsed = parse_command(SPECS["jq"],
                           ["--arg", "v", "/etc/passwd", ".", "/d/a.json"],
                           "/")
    assert parsed.flags["--arg"] == ["v", "/etc/passwd"]
    assert parsed.paths() == ["/d/a.json"]


def test_pair_option_short_of_a_token_needs_a_value():
    parsed = parse_command(SPECS["jq"], ["--arg", "v"], "/")
    assert parsed.needs_value_options == ["--arg"]


def test_pair_option_has_no_equals_form():
    parsed = parse_command(SPECS["jq"], ["--arg=v", "hello", "."], "/")
    assert parsed.invalid_options == ["--arg=v"]


def test_pair_option_can_carry_a_path_value():
    parsed = parse_command(SPECS["jq"],
                           ["--rawfile", "body", "f.txt", "-n", "$body"],
                           "/data")
    # Only the value resolves: the name is not a path.
    assert parsed.flags["--rawfile"] == ["body", "/data/f.txt"]
    assert parsed.path_flag_values == ["/data/f.txt"]


def test_args_turns_later_operands_into_text():
    parsed = parse_command(SPECS["jq"], ["--args", ".", "a", "/etc/passwd"],
                           "/")
    assert parsed.texts() == [".", "a", "/etc/passwd"]
    assert parsed.paths() == []


def test_jsonargs_turns_later_operands_into_text():
    parsed = parse_command(SPECS["jq"], ["--jsonargs", ".", "1"], "/")
    assert parsed.texts() == [".", "1"]
    assert parsed.paths() == []


def test_operands_stay_paths_without_the_args_flags():
    parsed = parse_command(SPECS["jq"], [".", "/d/a.json"], "/")
    assert parsed.texts() == ["."]
    assert parsed.paths() == ["/d/a.json"]


def test_tar_old_style_cluster_parses_as_flags():
    parsed = parse_command(SPECS["tar"], ["xzf", "/data/a.tgz"], "/")
    assert parsed.flags["-x"] is True
    assert parsed.flags["-z"] is True
    assert parsed.flags["-f"] == "/data/a.tgz"
    assert parsed.paths() == []
    assert parsed.path_flag_values == ["/data/a.tgz"]


def test_tar_old_style_cluster_word_is_text_not_a_path():
    # The cluster carries no dash, so without a TEXT kind the shape
    # heuristic would classify it and dispatch would re-read it as a
    # resolved path instead of letters.
    parsed = parse_command(SPECS["tar"], ["xzf", "/data/a.tgz"], "/")
    assert parsed.word_kinds == ["str", "path"]


def test_tar_old_style_operands_keep_their_argv_slots():
    parsed = parse_command(
        SPECS["tar"], ["czf", "/data/a.tgz", "/data/one.txt", "/data/two.txt"],
        "/")
    assert parsed.paths() == ["/data/one.txt", "/data/two.txt"]
    assert parsed.word_kinds == ["str", "path", "path", "path"]


def test_tar_old_style_two_value_letters_bind_in_letter_order():
    parsed = parse_command(SPECS["tar"], ["xfC", "/data/a.tgz", "/data/out"],
                           "/")
    assert parsed.flags["-f"] == "/data/a.tgz"
    assert parsed.flags["-C"] == ["/data/out"]


def test_tar_old_style_value_letter_before_bool_letter():
    parsed = parse_command(SPECS["tar"], ["cfz", "/data/a.tgz"], "/")
    assert parsed.flags["-f"] == "/data/a.tgz"
    assert parsed.flags["-z"] is True


def test_tar_old_style_missing_argument_is_reported_not_raised():
    parsed = parse_command(SPECS["tar"], ["xzf"], "/")
    assert parsed.old_option_needs_value == "f"


def test_tar_old_style_undeclared_letter_reports_the_char():
    parsed = parse_command(SPECS["tar"], ["xQz", "/data/a.tgz"], "/")
    assert parsed.invalid_options == ["Q"]
    assert parsed.old_option_needs_value is None


def test_tar_dashed_line_reports_no_old_option():
    parsed = parse_command(SPECS["tar"], ["-x", "-z", "-f", "/data/a.tgz"],
                           "/")
    assert parsed.old_option_needs_value is None
    assert parsed.word_kinds == ["str", "str", "str", "path"]


def test_tar_old_style_still_accepts_long_options_after_the_cluster():
    parsed = parse_command(
        SPECS["tar"],
        ["xzf", "/data/a.tgz", "--strip-components", "1", "-C", "/data/out"],
        "/")
    assert parsed.flags["--strip-components"] == "1"
    assert parsed.flags["-C"] == ["/data/out"]


def test_old_option_style_is_off_for_every_other_command():
    # A first word with no dash stays an operand everywhere else.
    parsed = parse_command(SPECS["gzip"], ["dkf"], "/")
    assert parsed.paths() == ["/dkf"]
    assert parsed.old_option_needs_value is None


@pytest.mark.parametrize("argv", [
    ["-o/data/s1.txt", "/data/in.txt"],
    ["-uo/data/s1.txt", "/data/in.txt"],
    ["--output=/data/s1.txt", "/data/in.txt"],
])
def test_option_word_carrying_its_path_is_text(argv):
    # A None kind sent the word to the shape heuristic, which read
    # `-o/data/s1.txt` as the relative path <cwd>/-o/data/s1.txt, so sort
    # got a phantom input file and no output option at all.
    parsed = parse_command(SPECS["sort"], argv, "/")
    assert parsed.word_kinds == ["str", "path"]
    assert parsed.path_flag_values == ["/data/s1.txt"]
    assert parsed.paths() == ["/data/in.txt"]


def test_value_word_keeps_its_option_kind():
    parsed = parse_command(SPECS["sort"],
                           ["-o", "/data/s1.txt", "/data/in.txt"], "/")
    assert parsed.word_kinds == ["str", "path", "path"]


def test_invalid_option_word_is_text():
    # GNU refuses the letter: `sort: invalid option -- '/'`. Read as a
    # path, the word reached dispatch resolved and was opened instead.
    parsed = parse_command(SPECS["sort"], ["-/data/x.txt", "/data/in.txt"],
                           "/")
    assert parsed.word_kinds == ["str", "path"]
    assert parsed.invalid_options == ["/"]


def test_dash_word_that_is_an_operand_keeps_the_operand_kind():
    after_end = parse_command(SPECS["head"], ["--", "-o/data/x.txt"], "/")
    assert after_end.word_kinds == ["str", "path"]
    # unzip has no long-option parser, so an undeclared `--` word is its
    # archive operand.
    lenient = parse_command(SPECS["unzip"], ["--a/b.zip"],
                            "/",
                            cmd_name="unzip")
    assert lenient.word_kinds == ["path"]


def test_required_operand_is_reported_not_raised():
    # The parser classifies and reports; the dialect that words the
    # refusal is the caller's choice, which is why this is a list of
    # names rather than an exception.
    spec = CommandSpec(
        positional=(Operand(type="str", name="PAGE_ID", required=True), ))
    empty = parse_command(spec, [], "/")
    assert empty.missing_required_operands == ["PAGE_ID"]
    filled = parse_command(spec, ["abc"], "/")
    assert filled.missing_required_operands == []


def test_a_flag_that_supplies_a_slot_satisfies_required():
    # provided_by is the declarative form of grep's `if (!pattern_given)`:
    # the slot is skipped, so it cannot also be missing.
    spec = CommandSpec(
        options=(Option(long="--expr", short="-e", type="str"), ),
        positional=(Operand(type="str",
                            name="PATTERN",
                            required=True,
                            provided_by=("-e", )), ),
    )
    assert parse_command(spec, [],
                         "/").missing_required_operands == ["PATTERN"]
    supplied = parse_command(spec, ["-e", "x"], "/")
    assert supplied.missing_required_operands == []


def test_typed_dests_exclude_defaults_and_keep_scan_order():
    spec = CommandSpec(options=(
        Option(long="--limit", type="int", default="25"),
        Option(long="--sort", type="str"),
        Option(long="--json", type="bool"),
    ))
    # --limit is present in flags (the default landed) but was never
    # typed, which is the whole distinction a clap usage line needs.
    parsed = parse_command(spec, ["--json", "--sort", "x"], "/")
    assert parsed.flags["--limit"] == "25"
    assert parsed.typed_dests == ["--json", "--sort"]


def test_operand_base_rebases_the_operands_typed_after_it():
    # GNU tar's -C is a chdir for the operands that follow it, so the
    # archive (-f) stays relative to the session cwd while the files move.
    parsed = parse_command(
        SPECS["tar"], ["-czf", "out.tgz", "-C", "/work/check", "my_paper"],
        cwd="/home")
    assert parsed.paths() == ["/work/check/my_paper"]
    assert parsed.flags["-f"] == "/home/out.tgz"
    assert parsed.flags["-C"] == ["/work/check"]


def test_operand_base_is_cumulative_like_a_real_chdir():
    parsed = parse_command(
        SPECS["tar"], ["-cf", "a.tar", "-C", "d1", "x", "-C", "../d2", "y"],
        cwd="/work")
    assert parsed.paths() == ["/work/d1/x", "/work/d2/y"]
    # Every occurrence is kept in order: GNU chdirs at each one.
    assert parsed.flags["-C"] == ["/work/d1", "/work/d2"]


def test_operand_base_only_moves_what_follows_it():
    parsed = parse_command(
        SPECS["tar"], ["-cf", "a.tar", "top.txt", "-C", "/work/e", "e.txt"],
        cwd="/work")
    assert parsed.paths() == ["/work/top.txt", "/work/e/e.txt"]


def test_operand_base_survives_the_old_style_cluster():
    parsed = parse_command(SPECS["tar"], ["czf", "a.tgz", "-C", "sub", "x"],
                           cwd="/work")
    assert parsed.paths() == ["/work/sub/x"]
    assert parsed.word_bases[-1] == "/work/sub"


def test_word_bases_are_empty_without_an_operand_base():
    parsed = parse_command(SPECS["cat"], ["a.txt"], cwd="/work")
    assert parsed.word_bases == [None]


PYTHON_LIKE = CommandSpec(
    options=(Option(short="-c", type="str"), Option(short="-u")),
    rest=Operand(type="str", remainder=True),
)


def test_remainder_rejects_an_unknown_flag_before_the_operand():
    parsed = parse_command(PYTHON_LIKE, ["-z", "-c", "print(1)"], "/")
    assert parsed.invalid_options == ["z"]


def test_remainder_keeps_dash_words_after_the_operand_verbatim():
    parsed = parse_command(PYTHON_LIKE, ["s.py", "--foo", "-z"], "/")
    assert parsed.texts() == ["s.py", "--foo", "-z"]
    assert parsed.invalid_options == []


def test_remainder_consumes_the_marker_that_hands_off_the_line():
    # The router writes the `--`; the parser eats exactly that one, so
    # the words after it are the program's argv.
    parsed = parse_command(PYTHON_LIKE, ["-c", "print(1)", "--", "-u", "x"],
                           "/")
    assert parsed.flags["-c"] == "print(1)"
    assert parsed.flags.get("-u") is not True
    assert parsed.texts() == ["-u", "x"]


@pytest.mark.parametrize("cmd", ["js", "node", "python", "python3"])
def test_every_interpreter_stops_parsing_flags_at_the_stdin_operand(cmd):
    # `node - -e x` and `python3 - -c x` both run the piped program and
    # hand it the rest as argv (node 22.8.0, CPython 3.12). Pinning all
    # four together is what keeps js from drifting off python again.
    parsed = parse_command(SPECS[cmd], ["-", "-e", "PROG"], "/")
    assert parsed.flags == {}
    assert parsed.texts() == ["-", "-e", "PROG"]


@pytest.mark.parametrize("cmd", ["js", "node", "python", "python3"])
def test_every_interpreter_hands_a_script_its_own_flags(cmd):
    parsed = parse_command(SPECS[cmd], ["s.js", "-m", "--module"], "/")
    assert parsed.flags == {}
    assert parsed.texts() == ["s.js", "-m", "--module"]


def test_js_flags_before_the_first_operand_are_still_the_interpreters():
    parsed = parse_command(SPECS["js"], ["-m", "-e", "CODE", "a"], "/")
    assert parsed.flags["--module"] is True
    assert parsed.flags["-e"] == "CODE"
    assert parsed.texts() == ["a"]


# There is no per-occurrence record beside the bag. GNU validates every
# value as getopt hands it over, so a scalar dest checks the value it is
# about to drop before the next one replaces it (the int and choices tests
# above), and a command that must see every value declares the option
# `multiple` (argparse's append).
def test_an_accumulating_option_keeps_every_value_for_the_command():
    parsed = parse_command(SPECS["nl"], ["-w", "abc", "-v", "xyz", "-w", "3"],
                           "/")
    assert parse_to_kwargs(parsed) == {
        "number_width": ["abc", "3"],
        "starting_line_number": ["xyz"],
    }


def test_the_kwargs_bag_carries_only_the_line_s_options():
    parsed = parse_command(SPECS["grep"],
                           ["-e", "a", "-e", "b", "-m", "1", "-m", "2", "x"],
                           "/")
    kwargs = parse_to_kwargs(parsed)
    assert kwargs["e"] == ["a", "b"]
    assert kwargs["m"] == "2"
    assert set(kwargs) == {"e", "m"}


# A boolean long handed a value is reported as its own kind, not as an
# unrecognized option: getopt_long recognized the option and refused the
# value. The entry carries the CANONICAL spelling plus the typed value,
# because GNU names the canonical one even for an abbreviation.
def test_boolean_long_with_a_value_is_its_own_report():
    parsed = parse_command(SPECS["grep"], ["--byte-offset=2", "x"], "/")
    assert parsed.invalid_options == ["--byte-offset=2"]
    assert parsed.option_error_kinds == ["unexpected_value"]


def test_boolean_long_with_a_value_expands_an_abbreviation():
    """Measured: `grep --byte=2` answers for `--byte-offset`."""
    parsed = parse_command(SPECS["grep"], ["--byte=2", "x"], "/")
    assert parsed.invalid_options == ["--byte-offset=2"]
    assert parsed.option_error_kinds == ["unexpected_value"]


def test_boolean_long_with_an_empty_value_is_still_refused():
    parsed = parse_command(SPECS["grep"], ["--line-buffered=", "x"], "/")
    assert parsed.invalid_options == ["--line-buffered="]
    assert parsed.option_error_kinds == ["unexpected_value"]


def test_an_undeclared_long_with_a_value_stays_unrecognized():
    """The control: the two reports must not collapse into one.

    `grep --bogus=2` is `unrecognized option '--bogus=2'` with the value
    quoted, which is a different GNU message from the one above.
    """
    parsed = parse_command(SPECS["grep"], ["--bogus=2", "x"], "/")
    assert parsed.invalid_options == ["--bogus=2"]
    assert parsed.option_error_kinds == ["invalid"]


def test_an_optional_value_long_still_takes_its_value():
    """A control: only a BOOLEAN long refuses `=value`."""
    parsed = parse_command(SPECS["nl"], ["--number-width=3"], "/")
    assert parsed.invalid_options == []
    assert parsed.option_error_kinds == []


@pytest.mark.parametrize("argv,kinds", [
    (["--bogus", "--byte-offset=2"], ["invalid", "unexpected_value"]),
    (["--byte-offset=2", "--bogus"], ["unexpected_value", "invalid"]),
])
def test_the_two_reports_keep_scan_order(argv, kinds):
    """GNU stops at the first offending token, so order decides."""
    parsed = parse_command(SPECS["grep"], [*argv, "x"], "/")
    assert parsed.option_error_kinds == kinds


@pytest.mark.parametrize("argv", [["-O", "-"], ["-O-"]])
def test_wget_stdout_is_not_a_path_operand(argv):
    parsed = parse_command(SPECS["wget"],
                           argv + ["https://example.test/"],
                           "/data",
                           cmd_name="wget")
    assert parsed.flags["-O"] == "-"
    assert parsed.path_flag_values == []
    literal = parse_command(SPECS["wget"],
                            ["-O", "./-", "https://example.test/"],
                            "/data",
                            cmd_name="wget")
    assert literal.flags["-O"] == "/data/-"
    assert literal.path_flag_values == ["/data/-"]

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

from mirage.commands.spec import SPECS
from mirage.commands.spec.parser import parse_command
from mirage.commands.spec.types import (CommandSpec, Operand, OperandKind,
                                        Option)


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
        options=(Option(short="-e", value_kind=OperandKind.TEXT), ),
        positional=(Operand(kind=OperandKind.TEXT, provided_by=("-e", )), ),
        rest=Operand(kind=OperandKind.PATH),
    )
    with_flag = parse_command(spec, ["-e", "pat", "/x"], "/")
    assert with_flag.paths() == ["/x"]
    without_flag = parse_command(spec, ["pat", "/x"], "/")
    assert without_flag.texts() == ["pat"]
    assert without_flag.paths() == ["/x"]


def test_grep_dash_f_frees_positional_and_routes_pattern_file():
    parsed = parse_command(SPECS["grep"], ["-f", "pats.txt", "a.txt"], "/data")
    assert parsed.flags["-f"] == ["/data/pats.txt"]
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
    assert parsed.flags["-f"] == ["/p.txt"]
    assert parsed.paths() == ["/a.txt"]


def test_grep_repeated_dash_f_accumulates_and_routes_each_file():
    parsed = parse_command(SPECS["grep"],
                           ["-f", "p1.txt", "-f", "p2.txt", "a.txt"], "/data")
    assert parsed.flags["-f"] == ["/data/p1.txt", "/data/p2.txt"]
    assert parsed.paths() == ["/data/a.txt"]
    assert "/data/p1.txt" in parsed.routing_paths()
    assert "/data/p2.txt" in parsed.routing_paths()


def test_rg_dash_e_frees_positional_and_accumulates():
    parsed = parse_command(SPECS["rg"], ["-e", "foo", "-e", "bar", "/x"], "/")
    assert parsed.flags["-e"] == ["foo", "bar"]
    assert parsed.texts() == []
    assert parsed.paths() == ["/x"]


def test_long_value_flag_equals_syntax():
    parsed = parse_command(SPECS["du"], ["--max-depth=1", "/data"], "/")
    assert parsed.flags["--max-depth"] == "1"
    assert parsed.paths() == ["/data"]


def test_long_value_flag_equals_syntax_rg():
    parsed = parse_command(SPECS["rg"], ["--type=md", "pat", "/x"], "/")
    assert parsed.flags["--type"] == "md"
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


def test_text_rest_keeps_unknown_dash_tokens():
    parsed = parse_command(SPECS["python"], ["-x", "hello"], "/")
    assert parsed.texts() == ["-x", "hello"]
    assert parsed.warnings == []


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
        options=(Option(long="--tag",
                        value_kind=OperandKind.TEXT,
                        multiple=True), ),
        rest=Operand(kind=OperandKind.PATH),
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
    bare = parse_command(SPECS["split"],
                         ["-d", "-l", "2", "/input", "/prefix"], "/")
    attached = parse_command(SPECS["split"], ["-d10", "/input"], "/")
    assert bare.flags["--numeric-suffixes"] is True
    assert bare.flags["--lines"] == "2"
    assert bare.paths() == ["/input", "/prefix"]
    assert attached.flags["--numeric-suffixes"] == "10"


def test_overflow_operands_pass_through_like_last_slot():
    parsed = parse_command(SPECS["uniq"], ["a.txt", "b.txt", "c.txt"],
                           cwd="/data")
    assert [k for _, k in parsed.args] == [OperandKind.PATH] * 3

    parsed = parse_command(SPECS["tr"], ["a", "b", "extra.txt"], cwd="/data")
    assert [k for _, k in parsed.args] == [OperandKind.TEXT] * 3


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
    # The attached-value spelling (`-d10`) unifies too, so last-wins holds
    # for `--long=` and the short form alike.
    attached = parse_command(SPECS["split"], ["-d10", "/in", "/pre"], "/")
    assert attached.flags["--numeric-suffixes"] == "10"
    assert "-d" not in attached.flags
    short_last = parse_command(SPECS["split"],
                               ["--numeric-suffixes=3", "-d10", "/in", "/p"],
                               "/")
    assert short_last.flags["--numeric-suffixes"] == "10"
    long_last = parse_command(SPECS["split"],
                              ["-d10", "--numeric-suffixes=3", "/in", "/p"],
                              "/")
    assert long_last.flags["--numeric-suffixes"] == "3"


def test_count_flag_accumulates_occurrences():
    spec = CommandSpec(options=(Option(short="-v",
                                       long="--verbose",
                                       count=True), ),
                       rest=Operand(kind=OperandKind.PATH))
    packed = parse_command(spec, ["-vvv", "/f"], "/")
    assert packed.flags["--verbose"] == 3
    separate = parse_command(spec, ["-v", "--verbose", "-v", "/f"], "/")
    assert separate.flags["--verbose"] == 3
    absent = parse_command(spec, ["/f"], "/")
    assert "--verbose" not in absent.flags


def test_choices_violation_is_reported_not_raised():
    parsed = parse_command(SPECS["tee"], ["--output-error=bogus", "/f"], "/")
    assert parsed.invalid_value_options == [
        ("--output-error", "bogus", ("warn", "warn-nopipe", "exit",
                                     "exit-nopipe")),
    ]
    ok = parse_command(SPECS["tee"], ["--output-error=warn", "/f"], "/")
    assert ok.invalid_value_options == []


def test_choices_exempt_bare_optional_value_form():
    parsed = parse_command(SPECS["tee"], ["--output-error", "/f"], "/")
    assert parsed.flags["--output-error"] is True
    assert parsed.invalid_value_options == []


def test_choices_check_every_value_of_a_multiple_flag():
    spec = CommandSpec(options=(Option(short="-m",
                                       value_kind=OperandKind.TEXT,
                                       multiple=True,
                                       choices=("x", "y")), ))
    parsed = parse_command(spec, ["-m", "x", "-m", "z"], "/")
    assert parsed.invalid_value_options == [("-m", "z", ("x", "y"))]


def test_required_option_reported_when_absent():
    spec = CommandSpec(options=(
        Option(long="--out", value_kind=OperandKind.TEXT, required=True), ))
    missing = parse_command(spec, [], "/")
    assert missing.missing_required_options == ["--out"]
    present = parse_command(spec, ["--out", "x"], "/")
    assert present.missing_required_options == []


def test_default_lands_as_if_typed_and_satisfies_required():
    spec = CommandSpec(options=(Option(long="--mode",
                                       value_kind=OperandKind.TEXT,
                                       required=True,
                                       default="fast"), ))
    parsed = parse_command(spec, [], "/")
    assert parsed.flags["--mode"] == "fast"
    assert parsed.missing_required_options == []
    typed = parse_command(spec, ["--mode", "slow"], "/")
    assert typed.flags["--mode"] == "slow"


def test_path_default_resolves_and_routes():
    spec = CommandSpec(options=(Option(
        long="--file", value_kind=OperandKind.PATH, default="cfg.txt"), ))
    parsed = parse_command(spec, [], "/data")
    assert parsed.flags["--file"] == "/data/cfg.txt"
    assert parsed.path_flag_values == ["/data/cfg.txt"]


def test_multiple_default_lands_as_one_element_list():
    spec = CommandSpec(options=(Option(short="-f",
                                       long="--file",
                                       value_kind=OperandKind.PATH,
                                       multiple=True,
                                       default="cfg.txt"), ))
    parsed = parse_command(spec, [], "/data")
    assert parsed.flags["--file"] == ["/data/cfg.txt"]
    assert parsed.path_flag_values == ["/data/cfg.txt"]
    typed = parse_command(spec, ["-f", "a", "-f", "b"], "/data")
    assert typed.flags["--file"] == ["/data/a", "/data/b"]

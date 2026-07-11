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


def test_non_repeatable_value_flag_keeps_last_value():
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


def test_cluster_into_repeatable_flag_accumulates():
    parsed = parse_command(SPECS["grep"],
                           ["-ne", "foo", "-e", "bar", "/a.txt"], "/")
    assert parsed.flags["-n"] is True
    assert parsed.flags["-e"] == ["foo", "bar"]
    assert parsed.paths() == ["/a.txt"]


def test_long_equals_and_separate_repeatable_accumulate():
    spec = CommandSpec(
        options=(Option(long="--tag",
                        value_kind=OperandKind.TEXT,
                        repeatable=True), ),
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

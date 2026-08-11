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
from mirage.commands.spec.types import CommandSpec, Option
from mirage.workspace.executor.command.flags import (option_error, parse_flags,
                                                     synthesize_path_spec)


def test_synthesized_spec_leaves_the_backend_key_to_the_mount():
    spec = synthesize_path_spec("/data/sub/x.txt")
    assert spec.virtual == "/data/sub/x.txt"
    assert spec.directory == "/data/sub/"
    # The mount stamps resource_path at execute time; a parse-time
    # value is dead (proven by the sentinel run in both languages).
    assert spec.resource_path == ""
    assert spec.resolved is True


def test_synthesized_spec_for_a_bare_name_roots_the_directory():
    assert synthesize_path_spec("x.txt").directory == "/"


def test_no_spec_separates_parts_by_type():
    path = synthesize_path_spec("/data/a.txt")
    parsed = parse_flags([path, "hello"], None, "unknown", "/")
    assert parsed.paths == [path]
    assert parsed.texts == ["hello"]
    assert parsed.flag_kwargs == {}


def test_classified_path_wins_over_synthesis():
    path = synthesize_path_spec("/data/a.txt")
    parsed = parse_flags([path], SPECS["cat"], "cat", "/")
    assert parsed.paths[0] is path


def test_option_error_reports_the_first_scan_error_like_gnu():
    spec = CommandSpec(options=(Option(long="--context", type="str"),
                                Option(long="--count")))
    ambiguous_first = parse_flags(["--c", "--bogus", "x"], spec, "grep", "/")
    refusal = option_error("grep", ambiguous_first)
    assert refusal is not None
    assert refusal[0].startswith(b"grep: option '--c' is ambiguous")
    invalid_first = parse_flags(["--bogus", "--c", "x"], spec, "grep", "/")
    refusal = option_error("grep", invalid_first)
    assert refusal is not None
    assert refusal[0].startswith(b"grep: unrecognized option '--bogus'")


def test_option_error_reports_numeric_conversion_before_choices():
    # Numeric-typed values before choices, argparse's order, matching
    # the walk's _finish_node: a non-numeric value on a float option
    # that also declares choices refuses the conversion, not the list.
    spec = CommandSpec(
        options=(Option(long="--ratio", type="float", choices=("0.5",
                                                               "1.0")), ))
    parsed = parse_flags(["--ratio", "5x", "p"], spec, "cmd", "/")
    refusal = option_error("cmd", parsed)
    assert refusal is not None
    assert b"invalid float value: '5x'" in refusal[0]


def test_old_option_missing_argument_outranks_an_undeclared_letter():
    # GNU tar counts the cluster's argument needs before argp validates a
    # letter, so `tar Qf` and `tar fQ` both name f.
    for argv in (["Qf"], ["fQ"]):
        parsed = parse_flags(argv, SPECS["tar"], "tar", "/")
        refusal = option_error("tar", parsed)
        assert refusal is not None
        assert refusal[0] == (b"tar: Old option 'f' requires an argument.\n"
                              b"Try 'tar --help' for more information.\n")
        assert refusal[1] == 2


def test_old_style_cluster_with_its_argument_is_no_refusal():
    parsed = parse_flags(["xzf", "/data/a.tgz"], SPECS["tar"], "tar", "/")
    assert option_error("tar", parsed) is None
    assert parsed.flag_kwargs["x"] is True
    assert parsed.flag_kwargs["z"] is True

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

from dataclasses import replace

from mirage.commands.spec import SPECS
from mirage.commands.spec.builtin_specs import registered_spec
from mirage.commands.spec.types import CommandSpec, Operand, Option
from mirage.workspace.executor.command.flags import (option_error, parse_flags,
                                                     synthesize_path_spec)


def test_synthesized_spec_leaves_the_backend_key_to_the_mount():
    spec = synthesize_path_spec("/data/sub/x.txt")
    assert spec.virtual == "/data/sub/x.txt"
    assert spec.directory == "/data/sub/"
    # The mount stamps vfs_path at execute time; a parse-time
    # value is dead (proven by the sentinel run in both languages).
    assert spec.vfs_path == ""
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


def test_option_error_reports_a_refused_value_before_a_later_bad_option():
    # GNU stops at the first offending token whatever kind it is:
    # coreutils 9.7 `tee --output-error=bad --bogus f` names the value,
    # the reversed line names --bogus, and a value option that ran out
    # of line loses to a value refused before it.
    spec = CommandSpec(options=(Option(long="--mode",
                                       type="str",
                                       choices=("warn", "exit")),
                                Option(long="--count", type="int")),
                       rest=Operand(type="path"))
    value_first = parse_flags(["--mode=bad", "--bogus", "f"], spec, "tee", "/")
    refusal = option_error("tee", value_first)
    assert refusal is not None
    assert refusal[0].startswith(b"tee: invalid argument 'bad' for '--mode'")
    option_first = parse_flags(["--bogus", "--mode=bad", "f"], spec, "tee",
                               "/")
    refusal = option_error("tee", option_first)
    assert refusal is not None
    assert refusal[0].startswith(b"tee: unrecognized option '--bogus'")
    trailing = parse_flags(["--mode=bad", "--count"], spec, "tee", "/")
    refusal = option_error("tee", trailing)
    assert refusal is not None
    assert refusal[0].startswith(b"tee: invalid argument 'bad' for '--mode'")
    needy = parse_flags(["--mode=warn", "--count"], spec, "tee", "/")
    refusal = option_error("tee", needy)
    assert refusal is not None
    assert b"'--count' requires an argument" in refusal[0]


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


def test_two_spellings_of_one_path_keep_their_own_spelling():
    # `ls -d 2026/ lnk/` with lnk -> 2026: both operands resolve to one
    # virtual path, and a lookup keyed by that path handed the second
    # spelling to both rows.
    first = replace(synthesize_path_spec("/data/2026"), raw_path="2026/")
    second = replace(synthesize_path_spec("/data/2026"), raw_path="lnk/")
    parsed = parse_flags(["-d", first, second], SPECS["ls"], "ls", "/data")
    assert parsed.paths[0] is first
    assert parsed.paths[1] is second


def test_an_operand_after_a_chdir_option_keeps_its_own_spelling():
    # `tar -cf out.tar -C dir .`: the option's value and the operand
    # resolve to one path, and the operand's spelling names the members
    # (GNU tar 1.35 stores `./f.txt`, not `dir/f.txt`).
    out = replace(synthesize_path_spec("/data/out.tar"), raw_path="out.tar")
    base = replace(synthesize_path_spec("/data/dir"), raw_path="dir")
    dot = replace(synthesize_path_spec("/data/dir"), raw_path=".")
    parsed = parse_flags(["-cf", out, "-C", base, dot], SPECS["tar"], "tar",
                         "/data")
    assert parsed.paths[0] is dot
    assert parsed.flag_kwargs["C"][0] is base


def test_the_string_flag_view_takes_the_option_word_off_the_queue_too():
    # Cross-mount dispatch keeps flag paths as strings, and the operand
    # still has to get its own word.
    base = replace(synthesize_path_spec("/data/dir"), raw_path="dir")
    dot = replace(synthesize_path_spec("/data/dir"), raw_path=".")
    parsed = parse_flags(["-c", "-C", base, dot],
                         SPECS["tar"],
                         "tar",
                         "/data",
                         str_flag_paths=True)
    assert parsed.paths[0] is dot


def test_a_word_the_parser_normalized_is_synthesized_not_paired():
    # A followed link whose target climbs through `..` reaches the parse
    # as `/data/b/../a/f.txt`; the parser resolves that to `/data/a/f.txt`
    # and a keyed backend can only read the resolved spelling.
    climbing = replace(synthesize_path_spec("/data/b/../a/f.txt"),
                       raw_path="/data/b/link")
    parsed = parse_flags([climbing], SPECS["cat"], "cat", "/data")
    assert parsed.paths[0].virtual == "/data/a/f.txt"


# The spec-driven ARGMATCH path, end to end through the executor's
# renderer. Measured on coreutils 9.4: `tee --output-error=warn-` exits
# 0, `=w` is `ambiguous argument 'w'` and `=zzz` is
# `invalid argument 'zzz'`, over one shared candidate block.
def test_option_error_accepts_an_unambiguous_prefix():
    parsed = parse_flags(["--output-error=warn-", "/f"], SPECS["tee"], "tee",
                         "/")
    assert option_error("tee", parsed) is None
    assert parsed.flag_kwargs["output_error"] == "warn-nopipe"


def test_option_error_words_an_ambiguous_value_as_gnu_does():
    parsed = parse_flags(["--output-error=w", "/f"], SPECS["tee"], "tee", "/")
    refusal = option_error("tee", parsed)
    assert refusal is not None
    message, code = refusal
    assert message == (b"tee: ambiguous argument 'w' for '--output-error'\n"
                       b"Valid arguments are:\n"
                       b"  - 'warn'\n  - 'warn-nopipe'\n"
                       b"  - 'exit'\n  - 'exit-nopipe'\n"
                       b"Try 'tee --help' for more information.\n")
    assert code == 1


# The two wordings are one report, so the FIRST refused value on the
# LINE wins whichever wording it carries. Ordering them by which list
# they landed in would make a later invalid value outrank an earlier
# ambiguous one, which no other report here does. numfmt declares both
# ARGMATCH tables, so one line can carry one of each.
def test_argmatch_refusals_follow_line_order():
    parsed = parse_flags(["--from=ie", "--to=bogus", "1"], SPECS["numfmt"],
                         "numfmt", "/")
    refusal = option_error("numfmt", parsed)
    assert refusal is not None
    assert refusal[0].startswith(
        b"numfmt: ambiguous argument 'ie' for '--from'\n")
    parsed = parse_flags(["--from=bogus", "--to=ie", "1"], SPECS["numfmt"],
                         "numfmt", "/")
    refusal = option_error("numfmt", parsed)
    assert refusal is not None
    assert refusal[0].startswith(
        b"numfmt: invalid argument 'bogus' for '--from'\n")


def test_the_two_argmatch_refusals_differ_only_in_the_first_line():
    ambiguous = option_error(
        "tee", parse_flags(["--output-error=w", "/f"], SPECS["tee"], "tee",
                           "/"))
    invalid = option_error(
        "tee",
        parse_flags(["--output-error=zzz", "/f"], SPECS["tee"], "tee", "/"))
    assert ambiguous is not None and invalid is not None
    assert ambiguous[0].split(b"\n", 1)[1] == invalid[0].split(b"\n", 1)[1]
    assert ambiguous[1] == invalid[1] == 1


# The parser settles whose grammar a line was read against and the door
# reads that bit, never the spelling: a mount may register its own
# command under a builtin's name (nothing refuses it), and the measured
# per-program tables describe one real program each.
BORROWED = CommandSpec(options=(Option(long="--mode", type="str"), ),
                       rest=Operand(type="str"))


def test_parse_flags_carries_the_parsers_builtin_bit():
    assert parse_flags(["x"], registered_spec("grep", SPECS["grep"]), "grep",
                       "/").builtin
    assert parse_flags(["x"], SPECS["grep"], "grep", "/").builtin
    assert not parse_flags(["x"], BORROWED, "grep", "/").builtin
    assert not parse_flags(["x"], None, "grep", "/").builtin


def test_a_borrowed_name_is_refused_like_any_custom_command():
    for name in ("grep", "diff", "python3", "curl", "tar"):
        refusal = option_error(
            name, parse_flags(["--bogus", "x"], BORROWED, name, "/"))
        assert refusal == (
            f"{name}: unrecognized option '--bogus'\n"
            f"Try '{name} --help' for more information.\n".encode(), 1), name
    refusal = option_error("grep",
                           parse_flags(["x"], SPECS["grep"], "grep", "/"))
    assert refusal is None
    refusal = option_error(
        "grep", parse_flags(["--bogus", "x"], SPECS["grep"], "grep", "/"))
    assert refusal is not None and refusal[1] == 2


# The find exemption is the builtin's: its expression is validated by
# parse_find_expression. A borrowed `find` has no such parser, so its
# undeclared option is refused rather than silently dropped.
def test_a_borrowed_find_is_not_exempt_from_option_refusal():
    parsed = parse_flags(["--bogus", "x"], BORROWED, "find", "/")
    refusal = option_error("find", parsed)
    assert refusal is not None
    assert refusal[0].startswith(b"find: unrecognized option '--bogus'\n")
    builtin = parse_flags(["-name", "x"], SPECS["find"], "find", "/")
    assert option_error("find", builtin) is None

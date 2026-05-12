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

from mirage.commands.spec import (SPECS, CommandSpec, Operand, OperandKind,
                                  Option, ParsedArgs, parse_command,
                                  parse_to_kwargs)


def test_parse_simple_path_args():
    spec = CommandSpec(rest=Operand(kind=OperandKind.PATH))
    parsed = parse_command(spec, ["a.txt", "b.txt"], cwd="/home")
    assert parsed.args == [("/home/a.txt", OperandKind.PATH),
                           ("/home/b.txt", OperandKind.PATH)]
    assert parsed.flags == {}


def test_parse_absolute_path():
    spec = CommandSpec(rest=Operand(kind=OperandKind.PATH))
    parsed = parse_command(spec, ["/data/file.csv"], cwd="/home")
    assert parsed.args == [("/data/file.csv", OperandKind.PATH)]


def test_parse_bool_flags():
    spec = CommandSpec(options=(Option(short="-r"), Option(short="-f"),
                                Option(short="-v")),
                       rest=Operand(kind=OperandKind.PATH))
    parsed = parse_command(spec, ["-rf", "file.txt"], cwd="/")
    assert parsed.flags == {"-r": True, "-f": True}
    assert parsed.args == [("/file.txt", OperandKind.PATH)]


def test_parse_value_flag_space():
    spec = CommandSpec(options=(Option(short="-n",
                                       value_kind=OperandKind.TEXT), ),
                       rest=Operand(kind=OperandKind.PATH))
    parsed = parse_command(spec, ["-n", "10", "file.txt"], cwd="/")
    assert parsed.flags == {"-n": "10"}
    assert parsed.args == [("/file.txt", OperandKind.PATH)]


def test_parse_value_flag_joined():
    spec = CommandSpec(options=(Option(short="-n",
                                       value_kind=OperandKind.TEXT), ),
                       rest=Operand(kind=OperandKind.PATH))
    parsed = parse_command(spec, ["-n10", "file.txt"], cwd="/")
    assert parsed.flags == {"-n": "10"}
    assert parsed.args == [("/file.txt", OperandKind.PATH)]


def test_parse_long_bool_flag():
    spec = CommandSpec(options=(Option(long="--hidden"), ),
                       rest=Operand(kind=OperandKind.PATH))
    parsed = parse_command(spec, ["--hidden", "dir/"], cwd="/")
    assert parsed.flags == {"--hidden": True}
    assert parsed.args == [("/dir", OperandKind.PATH)]


def test_parse_long_value_flag():
    spec = CommandSpec(options=(Option(long="--type",
                                       value_kind=OperandKind.TEXT), ),
                       rest=Operand(kind=OperandKind.PATH))
    parsed = parse_command(spec, ["--type", "py", "src/"], cwd="/")
    assert parsed.flags == {"--type": "py"}
    assert parsed.args == [("/src", OperandKind.PATH)]


def test_parse_positional_text_then_path():
    spec = CommandSpec(
        options=(Option(short="-i"), Option(short="-v")),
        positional=(Operand(kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.PATH),
    )
    parsed = parse_command(spec, ["-i", "pattern", "file1.txt", "file2.txt"],
                           cwd="/data")
    assert parsed.flags == {"-i": True}
    assert parsed.args == [
        ("pattern", OperandKind.TEXT),
        ("/data/file1.txt", OperandKind.PATH),
        ("/data/file2.txt", OperandKind.PATH),
    ]


def test_parse_double_dash_stops_flags():
    spec = CommandSpec(options=(Option(short="-r"), ),
                       rest=Operand(kind=OperandKind.PATH))
    parsed = parse_command(spec, ["--", "-r"], cwd="/")
    assert parsed.flags == {}
    assert parsed.args == [("/-r", OperandKind.PATH)]


def test_parse_text_rest():
    spec = CommandSpec(rest=Operand(kind=OperandKind.TEXT))
    parsed = parse_command(spec, ["hello", "world"], cwd="/")
    assert parsed.args == [("hello", OperandKind.TEXT),
                           ("world", OperandKind.TEXT)]


def test_parsed_args_paths():
    p = ParsedArgs(flags={},
                   args=[("/a", OperandKind.PATH), ("text", OperandKind.TEXT),
                         ("/b", OperandKind.PATH)])
    assert p.paths() == ["/a", "/b"]


def test_parsed_args_texts():
    p = ParsedArgs(flags={},
                   args=[("/a", OperandKind.PATH), ("text", OperandKind.TEXT)])
    assert p.texts() == ["text"]


def test_parsed_args_flag():
    p = ParsedArgs(flags={"-n": "10", "-r": True}, args=[])
    assert p.flag("-n") == "10"
    assert p.flag("-r") is True
    assert p.flag("-x") is None
    assert p.flag("-x", "default") == "default"


def test_parse_combined_bool_and_value():
    spec = CommandSpec(options=(Option(short="-r"), Option(short="-i"),
                                Option(short="-m",
                                       value_kind=OperandKind.TEXT)),
                       rest=Operand(kind=OperandKind.PATH))
    parsed = parse_command(spec, ["-ri", "-m", "5", "file.txt"], cwd="/")
    assert parsed.flags == {"-r": True, "-i": True, "-m": "5"}
    assert parsed.args == [("/file.txt", OperandKind.PATH)]


def test_clustered_flags_with_unknown_short_falls_through_misclassifying_args(
):
    # Regression: a real user ran `grep -RIl "Base3\|base3" /r2/Review` and
    # the pattern + path got swapped because `-I` was missing from the spec.
    # The parser walks each char in `-RIl`, finds `-I` not registered, and
    # bails on the whole cluster — pushing `-RIl` itself as the first
    # positional and shifting everything after.
    spec_missing_I = CommandSpec(
        options=(Option(short="-R"),
                 Option(short="-l")),  # -I deliberately missing
        positional=(Operand(kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.PATH),
    )
    parsed = parse_command(spec_missing_I,
                           ["-RIl", "Base3\\|base3", "/r2/Review"],
                           cwd="/")
    assert parsed.texts() == ["-RIl"]
    assert parsed.paths() == ["/Base3\\|base3", "/r2/Review"]


def test_clustered_flags_with_all_known_short_classifies_correctly():
    spec_full = CommandSpec(
        options=(Option(short="-R"), Option(short="-I"), Option(short="-l")),
        positional=(Operand(kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.PATH),
    )
    parsed = parse_command(spec_full, ["-RIl", "Base3\\|base3", "/r2/Review"],
                           cwd="/")
    assert parsed.flags == {"-R": True, "-I": True, "-l": True}
    assert parsed.texts() == ["Base3\\|base3"]
    assert parsed.paths() == ["/r2/Review"]


def test_grep_spec_recognizes_capital_I_for_ignore_binary():
    grep_spec = SPECS["grep"]
    parsed = parse_command(grep_spec, ["-RIl", "Base3\\|base3", "/r2/Review"],
                           cwd="/")
    assert parsed.flags.get("-I") is True
    assert parsed.flags.get("-R") is True
    assert parsed.flags.get("-l") is True
    assert parsed.texts() == ["Base3\\|base3"]
    assert parsed.paths() == ["/r2/Review"]


def test_all_commands_have_specs():
    expected = {
        "ls",
        "stat",
        "pwd",
        "find",
        "tree",
        "du",
        "cat",
        "head",
        "tail",
        "wc",
        "md5",
        "diff",
        "file",
        "nl",
        "grep",
        "rg",
        "sort",
        "uniq",
        "cut",
        "mkdir",
        "touch",
        "cp",
        "mv",
        "rm",
        "sed",
        "echo",
        "tee",
        "tr",
        "curl",
        "wget",
        "jq",
        "awk",
        "base64",
        "bash",
        "tar",
        "gzip",
        "gunzip",
        "zip",
        "unzip",
        "sha256sum",
        "tac",
        "paste",
        "ln",
        "readlink",
        "basename",
        "dirname",
        "realpath",
        "printf",
        "seq",
        "split",
        "xxd",
        "patch",
        "shuf",
        "comm",
        "column",
        "fold",
        "fmt",
        "cmp",
        "iconv",
        "strings",
        "rev",
        "zcat",
        "zgrep",
        "mktemp",
        "bc",
        "expr",
        "date",
        "csplit",
        "expand",
        "unexpand",
        "tsort",
        "look",
        "sleep",
        "join",
        "python",
        "python3",
        "history",
    }
    assert set(SPECS.keys()) == expected


def test_grep_spec_parses_correctly():
    spec = SPECS["grep"]
    parsed = parse_command(spec, ["-rni", "pattern", "/data/file.txt"],
                           cwd="/")
    assert parsed.flags["-r"] is True
    assert parsed.flags["-n"] is True
    assert parsed.flags["-i"] is True
    assert parsed.args[0] == ("pattern", OperandKind.TEXT)
    assert parsed.args[1] == ("/data/file.txt", OperandKind.PATH)


def test_head_spec_parses_n_flag():
    spec = SPECS["head"]
    parsed = parse_command(spec, ["-n", "20", "file.txt"], cwd="/data")
    assert parsed.flag("-n") == "20"
    assert parsed.paths() == ["/data/file.txt"]


def test_head_spec_parses_joined_n():
    spec = SPECS["head"]
    parsed = parse_command(spec, ["-n20", "file.txt"], cwd="/")
    assert parsed.flag("-n") == "20"
    assert parsed.paths() == ["/file.txt"]


def test_echo_spec_text_args():
    spec = SPECS["echo"]
    parsed = parse_command(spec, ["hello", "world"], cwd="/")
    assert parsed.texts() == ["hello", "world"]


def test_rm_spec_combined_flags():
    spec = SPECS["rm"]
    parsed = parse_command(spec, ["-rf", "a", "b", "c"], cwd="/data")
    assert parsed.flags["-r"] is True
    assert parsed.flags["-f"] is True
    assert parsed.paths() == ["/data/a", "/data/b", "/data/c"]


def test_cp_spec():
    spec = SPECS["cp"]
    parsed = parse_command(spec, ["-r", "src/", "dst/"], cwd="/data")
    assert parsed.flags["-r"] is True
    assert parsed.paths() == ["/data/src", "/data/dst"]


def test_rg_spec_with_long_flags():
    spec = SPECS["rg"]
    parsed = parse_command(spec,
                           ["--type", "py", "--hidden", "pattern", "src/"],
                           cwd="/")
    assert parsed.flag("--type") == "py"
    assert parsed.flag("--hidden") is True
    assert parsed.args[0] == ("pattern", OperandKind.TEXT)
    assert parsed.args[1] == ("/src", OperandKind.PATH)


def test_find_spec():
    spec = SPECS["find"]
    parsed = parse_command(spec, ["/data", "-name", "*.py", "-type", "f"],
                           cwd="/")
    assert parsed.paths() == ["/data"]
    assert parsed.flag("-name") == "*.py"
    assert parsed.flag("-type") == "f"


def test_curl_spec():
    spec = SPECS["curl"]
    parsed = parse_command(spec, ["-H", "Accept: json", "http://example.com"],
                           cwd="/")
    assert parsed.flag("-H") == "Accept: json"
    assert parsed.texts() == ["http://example.com"]


def test_wget_spec():
    spec = SPECS["wget"]
    parsed = parse_command(spec, ["http://example.com/file.zip", "out.zip"],
                           cwd="/data")
    assert parsed.args[0] == ("http://example.com/file.zip", OperandKind.TEXT)
    assert parsed.args[1] == ("/data/out.zip", OperandKind.PATH)


def test_sed_spec():
    spec = SPECS["sed"]
    parsed = parse_command(spec, ["-i", "s/foo/bar/", "file.txt"], cwd="/data")
    assert parsed.flag("-i") is True
    assert parsed.args[0] == ("s/foo/bar/", OperandKind.TEXT)
    assert parsed.args[1] == ("/data/file.txt", OperandKind.PATH)


def test_sort_spec():
    spec = SPECS["sort"]
    parsed = parse_command(spec, ["-k", "2", "-t", ",", "-rn", "data.csv"],
                           cwd="/")
    assert parsed.flag("-k") == "2"
    assert parsed.flag("-t") == ","
    assert parsed.flag("-r") is True
    assert parsed.flag("-n") is True
    assert parsed.paths() == ["/data.csv"]


def test_parse_to_kwargs_short_bool():
    parsed = ParsedArgs(flags={"-l": True, "-a": True}, args=[])
    kw = parse_to_kwargs(parsed)
    assert kw == {"args_l": True, "a": True}


def test_parse_to_kwargs_short_value():
    parsed = ParsedArgs(flags={"-n": "5"}, args=[])
    kw = parse_to_kwargs(parsed)
    assert kw == {"n": "5"}


def test_parse_to_kwargs_long_flags():
    parsed = ParsedArgs(flags={"--hidden": True, "--type": "py"}, args=[])
    kw = parse_to_kwargs(parsed)
    assert kw == {"hidden": True, "type": "py"}


def test_parse_to_kwargs_mixed():
    parsed = ParsedArgs(flags={
        "-i": True,
        "--glob": "*.py",
        "-m": "10"
    },
                        args=[])
    kw = parse_to_kwargs(parsed)
    assert kw == {"i": True, "glob": "*.py", "m": "10"}


def test_parse_to_kwargs_ambiguous_names():
    parsed = ParsedArgs(flags={"-l": True, "-O": True, "-I": True}, args=[])
    kw = parse_to_kwargs(parsed)
    assert kw == {"args_l": True, "args_O": True, "args_I": True}


def test_parse_to_kwargs_dash_one_maps_to_args_1():
    parsed = ParsedArgs(flags={"-1": True}, args=[])
    kw = parse_to_kwargs(parsed)
    assert kw == {"args_1": True}


def test_ls_spec_parses_dash_one_and_dash_l_together():
    parsed = parse_command(SPECS["ls"], ["-1", "-l", "/data"], cwd="/")
    kw = parse_to_kwargs(parsed)
    assert kw["args_1"] is True
    assert kw["args_l"] is True


def test_parse_to_kwargs_empty():
    parsed = ParsedArgs(flags={}, args=[])
    kw = parse_to_kwargs(parsed)
    assert kw == {}


def test_cache_flag_single_path():
    spec = SPECS["grep"]
    parsed = parse_command(spec,
                           ["pattern", "file.txt", "--cache", "file.txt"], "/")
    assert parsed.cache_paths == ["/file.txt"]


def test_cache_flag_multiple_paths():
    spec = SPECS["grep"]
    parsed = parse_command(
        spec, ["pattern", "f1.txt", "--cache", "f1.txt", "f2.txt"], "/")
    assert parsed.cache_paths == ["/f1.txt", "/f2.txt"]


def test_cache_flag_empty():
    spec = SPECS["cat"]
    parsed = parse_command(spec, ["file.txt"], "/")
    assert parsed.cache_paths == []


def test_cache_flag_with_other_flags():
    spec = SPECS["grep"]
    parsed = parse_command(
        spec, ["-i", "pattern", "file.txt", "--cache", "file.txt"], "/")
    assert parsed.cache_paths == ["/file.txt"]
    assert parsed.flags.get("-i") is True


def test_option_bool_flag():
    opt = Option(short="-v")
    assert opt.short == "-v"
    assert opt.long is None
    assert opt.value_kind == OperandKind.NONE


def test_option_value_flag():
    opt = Option(short="-n", value_kind=OperandKind.TEXT)
    assert opt.value_kind == OperandKind.TEXT


def test_option_long_with_alias():
    opt = Option(short="-r", long="--recursive")
    assert opt.short == "-r"
    assert opt.long == "--recursive"


def test_option_path_value():
    opt = Option(short="-f", value_kind=OperandKind.PATH)
    assert opt.value_kind == OperandKind.PATH


def test_operand_default():
    op = Operand()
    assert op.kind == OperandKind.PATH


def test_operand_text():
    op = Operand(kind=OperandKind.TEXT)
    assert op.kind == OperandKind.TEXT


def test_command_spec_new_style():
    spec = CommandSpec(
        options=(
            Option(short="-r"),
            Option(short="-n", value_kind=OperandKind.TEXT),
            Option(long="--hidden"),
        ),
        positional=(Operand(kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.PATH),
    )
    assert len(spec.options) == 3
    assert len(spec.positional) == 1
    assert spec.rest.kind == OperandKind.PATH


def test_parse_new_spec_bool_flag():
    spec = CommandSpec(
        options=(Option(short="-r"), Option(short="-f")),
        rest=Operand(kind=OperandKind.PATH),
    )
    parsed = parse_command(spec, ["-rf", "file.txt"], cwd="/")
    assert parsed.flags == {"-r": True, "-f": True}
    assert parsed.args == [("/file.txt", OperandKind.PATH)]


def test_parse_new_spec_value_flag():
    spec = CommandSpec(
        options=(Option(short="-n", value_kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.PATH),
    )
    parsed = parse_command(spec, ["-n", "10", "file.txt"], cwd="/")
    assert parsed.flags == {"-n": "10"}
    assert parsed.args == [("/file.txt", OperandKind.PATH)]


def test_parse_new_spec_long_flags():
    spec = CommandSpec(
        options=(
            Option(long="--hidden"),
            Option(long="--type", value_kind=OperandKind.TEXT),
        ),
        rest=Operand(kind=OperandKind.PATH),
    )
    parsed = parse_command(spec, ["--hidden", "--type", "py", "src/"], cwd="/")
    assert parsed.flags == {"--hidden": True, "--type": "py"}
    assert parsed.args == [("/src", OperandKind.PATH)]


def test_parse_new_spec_aliased_option():
    spec = CommandSpec(
        options=(Option(short="-r", long="--recursive"), ),
        rest=Operand(kind=OperandKind.PATH),
    )
    parsed = parse_command(spec, ["--recursive", "dir/"], cwd="/")
    assert parsed.flags == {"--recursive": True}

    parsed2 = parse_command(spec, ["-r", "dir/"], cwd="/")
    assert parsed2.flags == {"-r": True}


def test_parse_new_spec_path_value_flag():
    spec = CommandSpec(
        options=(
            Option(short="-c"),
            Option(short="-f", value_kind=OperandKind.PATH),
        ),
        rest=Operand(kind=OperandKind.PATH),
    )
    parsed = parse_command(spec, ["-c", "-f", "archive.tar", "file.txt"],
                           cwd="/data")
    assert parsed.flags == {"-c": True, "-f": "/data/archive.tar"}
    assert parsed.paths() == ["/data/file.txt"]
    assert parsed.path_flag_values == ["/data/archive.tar"]


def test_parse_new_spec_positional_text_then_path():
    spec = CommandSpec(
        options=(Option(short="-i"), ),
        positional=(Operand(kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.PATH),
    )
    parsed = parse_command(spec, ["-i", "pattern", "file1.txt"], cwd="/data")
    assert parsed.flags == {"-i": True}
    assert parsed.args == [
        ("pattern", OperandKind.TEXT),
        ("/data/file1.txt", OperandKind.PATH),
    ]


def test_parse_new_spec_no_rest():
    spec = CommandSpec(positional=(Operand(kind=OperandKind.TEXT),
                                   Operand(kind=OperandKind.TEXT)), )
    parsed = parse_command(spec, ["hello", "world", "extra"], cwd="/")
    assert parsed.args == [
        ("hello", OperandKind.TEXT),
        ("world", OperandKind.TEXT),
    ]


def test_parse_new_spec_joined_value_flag():
    spec = CommandSpec(
        options=(Option(short="-n", value_kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.PATH),
    )
    parsed = parse_command(spec, ["-n10", "file.txt"], cwd="/")
    assert parsed.flags == {"-n": "10"}
    assert parsed.args == [("/file.txt", OperandKind.PATH)]


def test_numeric_shorthand_treats_dash_n_as_flag():
    spec = CommandSpec(
        options=(Option(short="-n",
                        value_kind=OperandKind.TEXT,
                        numeric_shorthand=True), ),
        rest=Operand(kind=OperandKind.PATH),
    )
    parsed = parse_command(spec, ["-3", "file.txt"], cwd="/")
    assert parsed.flags == {"-n": "3"}
    assert parsed.args == [("/file.txt", OperandKind.PATH)]


def test_numeric_shorthand_keeps_dash_n_value_form():
    spec = CommandSpec(
        options=(Option(short="-n",
                        value_kind=OperandKind.TEXT,
                        numeric_shorthand=True), ),
        rest=Operand(kind=OperandKind.PATH),
    )
    parsed = parse_command(spec, ["-n", "3", "file.txt"], cwd="/")
    assert parsed.flags == {"-n": "3"}


def test_numeric_shorthand_opt_in_only():
    spec = CommandSpec(
        options=(Option(short="-n", value_kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.PATH),
    )
    parsed = parse_command(spec, ["-3", "file.txt"], cwd="/")
    assert "-n" not in parsed.flags


def test_head_spec_supports_numeric_shorthand():
    parsed = parse_command(SPECS["head"], ["-3", "/file.txt"], cwd="/")
    assert parsed.flags.get("-n") == "3"
    assert parsed.paths() == ["/file.txt"]


def test_tail_spec_supports_numeric_shorthand():
    parsed = parse_command(SPECS["tail"], ["-5", "/file.txt"], cwd="/")
    assert parsed.flags.get("-n") == "5"
    assert parsed.paths() == ["/file.txt"]


def test_option_description_default_none():
    opt = Option(short="-v")
    assert opt.description is None


def test_option_description_round_trip():
    opt = Option(short="-v", description="Verbose output.")
    assert opt.description == "Verbose output."


def test_command_spec_description_default_none():
    spec = CommandSpec()
    assert spec.description is None


def test_command_spec_description_round_trip():
    spec = CommandSpec(description="Do a thing.")
    assert spec.description == "Do a thing."

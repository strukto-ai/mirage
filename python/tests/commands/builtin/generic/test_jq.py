import asyncio

import pytest

from mirage.commands.builtin.generic.jq import (
    exit_code,
    indent_width,
    input_name,
    jq,
    jq_generic,
    option_refusal,
    parse_flags,
    positional_value,
    read_options,
    run_status,
)
from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS, parse_command, parse_to_kwargs
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.standard import help_page, version_line
from mirage.commands.spec.types import FlagValue
from mirage.core.jq import JqError, JqHalt, JqOptions, JqRun
from mirage.io.stream import yield_bytes
from mirage.io.types import IOResult, materialize
from mirage.types import PathSpec

FILES = {
    "/d/prog.jq": b".name\n",
    "/d/a.json": b'{"a":1}\n',
    "/d/b.json": b'{"b":2}\n',
    "/d/four.json": b"1\n2\n3\n4\n",
    "/d/bad.json": b'{"a":1}\n{"a":2}\n[',
    "/d/mid.json": b"1\n[1 2]\n3\n4\n",
    "/d/one.json": b"1",
    "/d/two.json": b" 2\n",
    "/d/-": b"42\n",
}

DIRS = {"/d/dir"}

HINT = (
    "Use jq --help for help with command-line options,\n"
    "or see the jq manpage, or online docs at https://jqlang.org"
)


def _stored(path: PathSpec) -> bytes:
    if path.virtual in DIRS:
        raise IsADirectoryError(path.virtual)
    if path.virtual not in FILES:
        raise FileNotFoundError(path.virtual)
    return FILES[path.virtual]


async def _read_bytes(path: PathSpec) -> bytes:
    return _stored(path)


async def _read_stream(path: PathSpec):
    data = _stored(path)
    for at in range(0, len(data), 5):
        yield data[at : at + 5]


def _path(virtual: str) -> PathSpec:
    return PathSpec(virtual, virtual.rsplit("/", 1)[0], virtual.lstrip("/"))


def _spec_flags(**flags: FlagValue) -> FlagView:
    return FlagView(flags, spec=SPECS["jq"])


def _parsed_line(*words: str) -> tuple[dict, list[str]]:
    parsed = parse_command(SPECS["jq"], list(words), "/", "jq")
    bag = parse_to_kwargs(parsed)
    for dest in ("rawfile", "slurpfile"):
        pairs = bag.get(dest)
        if isinstance(pairs, list):
            bag[dest] = [
                _path(str(word)) if at % 2 else word
                for at, word in enumerate(pairs)
            ]
    return bag, parsed.texts()


async def _unread(path: PathSpec) -> bytes:
    raise AssertionError(f"{path.virtual} should not be read")


async def _walk(*words: str) -> JqOptions | bytes:
    bag, texts = _parsed_line(*words)
    return await read_options(
        FlagView(bag, spec=SPECS["jq"]), texts, "from_file" in bag, _read_bytes
    )


async def _options(*words: str) -> JqOptions:
    opts = await _walk(*words)
    assert isinstance(opts, JqOptions)
    return opts


async def _bound(**flags: FlagValue) -> dict[str, str]:
    opts = await read_options(_spec_flags(**flags), [], False, _unread)
    assert isinstance(opts, JqOptions)
    return dict(opts.named_args)


def _printed(*outputs: str) -> int:
    return run_status(JqRun(list(outputs)))


def _halted(code: float | None) -> int:
    return run_status(JqRun([False], JqHalt(None, False, code)))


_FAILED = run_status(JqRun(["1"], JqError("x", True)))


async def _run(paths: list[str], *texts: str, **flags: FlagValue) -> tuple:
    source, io = await jq(
        [_path(p) for p in paths],
        *texts,
        read_bytes=_read_bytes,
        read_stream=_read_stream,
        **flags,
    )
    return await materialize(source) if source is not None else b"", io


def test_join_and_nul_output_imply_raw():
    assert parse_flags(_spec_flags(join_output=True)).raw_output
    assert parse_flags(_spec_flags(raw_output0=True)).raw_output


@pytest.mark.asyncio
async def test_indent_minus_one_is_tab_indentation():
    opts = await read_options(_spec_flags(indent="-1"), [], False, _unread)
    assert opts.tab
    assert opts.indent == 2


@pytest.mark.parametrize(
    "sign, zeros, digit, width",
    [
        ("", 0, "3", 3),
        ("+", 0, "3", 3),
        ("", 1, "7", 7),
        ("-", 0, "0", 0),
        ("", 0, "0", 0),
        ("-", 0, "1", -1),
        ("", 5000, "7", 7),
        ("+", 5000, "3", 3),
        ("-", 5000, "1", -1),
        ("-", 5000, "0", 0),
        ("", 5000, "0", 0),
    ],
)
def test_indent_reads_its_word_as_jqs_strtol_does(sign, zeros, digit, width):
    assert indent_width(sign + "0" * zeros + digit) == width


@pytest.mark.parametrize(
    "word",
    [
        "x",
        "2x",
        "",
        " 3",
        "3 ",
        "3\n",
        "1.5",
        "0x3",
        "08",
        "-2",
        "99999999999999999999",
        *(
            pytest.param(
                sign + digits * 5000 + "8", id=f"{sign}{digits}x5000-8"
            )
            for sign, digits in [("", "9"), ("-", "9"), ("+", "9"), ("", "0")]
        ),
    ],
)
def test_indent_refuses_any_other_word_in_jqs_words(word):
    with pytest.raises(UsageError) as caught:
        indent_width(word)
    assert str(caught.value) == (
        f"jq: --indent takes a number between -1 and 7\n{HINT}"
    )
    assert caught.value.exit_code == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "words, layout",
    [
        (["-c", "--tab"], "tab"),
        (["--tab", "-c"], "compact"),
        (["--indent", "3", "-c"], "compact"),
        (["-c", "--indent", "3"], 3),
        (["--tab", "--indent", "3"], 3),
        (["--indent", "3", "--tab"], "tab"),
        (["--indent", "-1", "-c"], "compact"),
        (["-c", "--indent", "-1"], "tab"),
        (["-cr", "--tab"], "tab"),
        (["--tab", "-rc"], "compact"),
        (["--indent", "2", "--indent", "5"], 5),
    ],
)
async def test_the_last_layout_option_typed_wins(words, layout):
    opts = await _options(*words, ".")
    assert (
        "compact" if opts.compact else "tab" if opts.tab else opts.indent
    ) == layout


@pytest.mark.asyncio
async def test_a_later_indent_word_is_read_too():
    with pytest.raises(UsageError, match="--indent takes a number"):
        await _options("--indent", "2", "--indent", "x", ".")


@pytest.mark.asyncio
async def test_arg_binds_each_name_to_a_string():
    args = await _bound(arg=["a", "1", "b", 'x"y'])
    assert args == {"a": '"1"', "b": '"x\\"y"'}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "value, text",
    [
        (' {"b":1.000,"1":2} ', '{"b":1.000,"1":2}'),
        ('{"a":1}', '{"a":1}'),
        ("nan", "nan"),
    ],
)
async def test_argjson_keeps_its_value_as_the_text_jq_reads(value, text):
    assert await _bound(argjson=["v", value]) == {"v": text}


@pytest.mark.asyncio
@pytest.mark.parametrize("value", ["nope", "1 2"])
async def test_argjson_refuses_invalid_json_with_jq_1_8s_hint(value):
    with pytest.raises(UsageError) as caught:
        await _bound(argjson=["v", value])
    assert str(caught.value) == (
        f"jq: invalid JSON text passed to --argjson\n{HINT}"
    )


@pytest.mark.asyncio
async def test_bindings_keep_the_order_they_were_typed_in():
    opts = await _options(
        "-n",
        "--slurpfile",
        "s",
        "/d/four.json",
        "--arg",
        "a",
        "1",
        "--rawfile",
        "r",
        "/d/one.json",
        "--argjson",
        "b",
        "2",
        "$ARGS.named",
    )
    assert list(opts.named_args.items()) == [
        ("s", "[1,2,3,4]"),
        ("a", '"1"'),
        ("r", '"1"'),
        ("b", "2"),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "words, text",
    [
        (["--argjson", "v", "1", "--argjson", "v", "2"], "1"),
        (["--arg", "v", "1", "--argjson", "v", "2"], '"1"'),
        (["--rawfile", "v", "/d/one.json", "--arg", "v", "2"], '"1"'),
        (
            [
                "--slurpfile",
                "v",
                "/d/two.json",
                "--rawfile",
                "v",
                "/d/one.json",
            ],
            "[2]",
        ),
    ],
)
async def test_the_first_binding_of_a_name_wins(words, text):
    opts = await _options("-n", *words, "$v")
    assert opts.named_args == {"v": text}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "words",
    [
        ["--argjson", "v", "nope"],
        ["--rawfile", "v", "/d/missing.txt"],
        ["--slurpfile", "v", "/d/bad.json"],
    ],
)
async def test_a_binding_of_a_taken_name_is_never_read(words):
    bag, texts = _parsed_line("-n", "--arg", "v", "1", *words, "$v")
    opts = await read_options(
        FlagView(bag, spec=SPECS["jq"]), texts, False, _unread
    )
    assert opts.named_args == {"v": '"1"'}


@pytest.mark.parametrize(
    "statuses, exit_status, expected",
    [
        ([_printed("1", "false")], True, 1),
        ([_printed("false", "1")], True, 0),
        ([_printed("null")], True, 1),
        ([_printed('"false"'), _printed("0.0")], True, 0),
        ([], True, 4),
        ([], False, 0),
        ([_printed("null")], False, 0),
        ([_FAILED, _printed("1")], False, 0),
        ([_printed("1"), _FAILED], False, 5),
        ([_FAILED, _printed("false")], True, 1),
        ([_printed("false"), _printed()], True, 1),
        ([_printed("1"), _printed()], True, 0),
        ([_halted(None)], False, 0),
        ([_halted(2)], False, 2),
        ([_halted(-1)], False, 0),
        ([_halted(-1)], True, 1),
        ([_halted(1.5)], False, 1),
        ([_halted(300)], False, 44),
    ],
)
def test_exit_code_reads_the_runs_as_jq_does(statuses, exit_status, expected):
    assert exit_code(statuses, JqOptions(exit_status=exit_status)) == expected


def test_an_input_is_named_as_typed_and_dash_as_stdin():
    assert (
        input_name(PathSpec("/d/a.json", "/d", "d/a.json", raw_path="a.json"))
        == "a.json"
    )
    assert input_name(PathSpec("/d/a.json", "/d", "d/a.json")) == "/d/a.json"
    assert (
        input_name(PathSpec("/dev/stdin", "/dev", "dev/stdin", raw_path="-"))
        == "<stdin>"
    )


def test_args_reads_an_operand_as_a_string():
    assert positional_value("args", "1") == '"1"'


def test_jsonargs_keeps_each_operand_as_the_text_jq_reads():
    assert positional_value("jsonargs", "1.0") == "1.0"
    assert positional_value("jsonargs", '{"b":1,"1":2}') == '{"b":1,"1":2}'


def test_jsonargs_rejects_invalid_json_in_jqs_words():
    with pytest.raises(UsageError) as caught:
        positional_value("jsonargs", "nope")
    assert str(caught.value) == (
        f"jq: invalid JSON text passed to --jsonargs\n{HINT}"
    )
    assert caught.value.exit_code == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "words, positional",
    [
        (
            ["--args", "a", "--jsonargs", "1", "--args", "b"],
            ('"a"', "1", '"b"'),
        ),
        (["--jsonargs", "1", "--args", "a"], ("1", '"a"')),
        (["--args", "--jsonargs", "1"], ("1",)),
        (["--args", "{", "--jsonargs", "1"], ('"{"', "1")),
        (["/d/a.json", "--args", "x", "/d/b.json"], ('"x"', '"/d/b.json"')),
        (["--jsonargs", "1", "--arg", "x", "y", "2"], ("1", "2")),
        (["--args", "--", "-x", "--jsonargs"], ('"-x"', '"--jsonargs"')),
        (["/d/a.json"], ()),
    ],
)
async def test_each_operand_takes_the_mode_typed_last_before_it(
    words, positional
):
    opts = await _options("-n", ".", *words)
    assert opts.positional_args == positional


@pytest.mark.asyncio
async def test_the_program_comes_first_whatever_the_mode():
    opts = await _options(
        "-n", "--jsonargs", ".", "1", "--args", "2", "--jsonargs", "3"
    )
    assert opts.positional_args == ("1", '"2"', "3")


@pytest.mark.asyncio
async def test_a_from_file_program_leaves_every_operand_to_the_modes():
    opts = await _options(
        "-n", "-f", "/d/prog.jq", "/d/a.json", "--args", "b", "--jsonargs", "2"
    )
    assert opts.positional_args == ('"b"', "2")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "flags, has_program_file, texts, positional",
    [
        ({"args": True}, False, [".", "a", "1"], ('"a"', '"1"')),
        ({"args": True}, True, ["a", "b"], ('"a"', '"b"')),
        ({"args": True, "jsonargs": True}, False, [".", "1"], ("1",)),
        ({"jsonargs": True, "args": True}, False, [".", "1"], ('"1"',)),
        ({}, False, [".", "a"], ()),
    ],
)
async def test_keyword_operands_come_after_every_option(
    flags, has_program_file, texts, positional
):
    opts = await read_options(
        _spec_flags(**flags), texts, has_program_file, _unread
    )
    assert opts.positional_args == positional


async def _flagged(
    paths: list[str], program: str, **flags: FlagValue
) -> tuple[bytes, bytes, int]:
    out, io = await _run(paths, program, **flags)
    return out, await materialize(io.stderr), io.exit_code


@pytest.mark.asyncio
async def test_a_parse_error_closes_the_input_it_stopped_in():
    opened = []

    def tracked(path: PathSpec):
        stream = _read_stream(path)
        opened.append(stream)
        return stream

    source, io = await jq(
        [_path("/d/mid.json"), _path("/d/a.json")],
        ".",
        read_bytes=_read_bytes,
        read_stream=tracked,
    )
    assert await materialize(source) == b"1\n"
    assert io.exit_code == 5
    assert opened[0].ag_frame is None


def _live(data: bytes):
    # An input that holds `data` and never ends, like a producer that
    # stays open.

    async def read_stream(path: PathSpec):
        yield data
        await asyncio.Event().wait()

    return read_stream


@pytest.mark.asyncio
async def test_a_run_reads_no_further_than_its_input_takes():
    source, io = await jq(
        [_path("/d/live.json")],
        "input",
        read_bytes=_read_bytes,
        read_stream=_live(b"[1 2]\n"),
        null_input=True,
    )
    assert await asyncio.wait_for(materialize(source), 5) == b""
    assert (await materialize(io.stderr), io.exit_code) == (
        b"jq: error (at /d/live.json:1): Expected separator between values "
        b"at line 1, column 5\n",
        5,
    )
    source, io = await jq(
        [_path("/d/live.json")],
        "[., input]",
        read_bytes=_read_bytes,
        read_stream=_live(b"1\n2\n"),
        compact_output=True,
    )
    assert await asyncio.wait_for(anext(source), 5) == b"[1,2]\n"
    await source.aclose()


@pytest.mark.asyncio
async def test_slurpfile_with_bad_json_is_refused_in_jqs_words():
    with pytest.raises(UsageError) as caught:
        await _run(
            [], "$x", null_input=True, slurpfile=["x", _path("/d/bad.json")]
        )
    assert str(caught.value) == (
        "jq: Bad JSON in --slurpfile x /d/bad.json: Unfinished JSON term at "
        "EOF at line 3, column 1"
    )
    assert caught.value.exit_code == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("option", ["rawfile", "slurpfile"])
@pytest.mark.parametrize(
    "path, reason",
    [
        ("/d/nope.json", "No such file or directory"),
        ("/d/dir", "It's a directory"),
    ],
)
async def test_a_flag_file_that_cannot_be_read_is_refused_in_jqs_words(
    option, path, reason
):
    with pytest.raises(UsageError) as caught:
        await _run([], "$x", null_input=True, **{option: ["x", _path(path)]})
    assert str(caught.value) == (
        f"jq: Bad JSON in --{option} x {path}: Could not open {path}: {reason}"
    )
    assert caught.value.exit_code == 2


@pytest.mark.parametrize(
    "word, line",
    [
        ("-x", "Unknown option -x"),
        ("--indent=3", "Unknown option --indent=3"),
        ("--arg", "--arg takes two parameters (e.g. --arg varname value)"),
        (
            "--slurpfile",
            "--slurpfile takes two parameters (e.g. --slurpfile varname filename)",
        ),
        ("--indent", "--indent takes one parameter"),
    ],
)
def test_a_refused_option_is_worded_as_jq_words_it(word, line):
    assert str(option_refusal(word)) == f"jq: {line}\n{HINT}"


def test_an_f_the_line_ends_at_prints_jqs_short_usage():
    refusal = option_refusal("-f")
    assert str(refusal).startswith(
        "jq - commandline JSON processor [version 1.8.2]\n"
    )
    assert str(refusal).endswith(
        "For listing the command options, use jq --help."
    )
    assert refusal.exit_code == 2


# jq 1.8.2's loop stops at the first word it cannot take, so an option the
# parser refused waits its turn behind a bad value typed before it.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "words, refusal",
    [
        (
            ("--indent", "x", "--argjson", "a", "nope", "1"),
            "jq: --indent takes",
        ),
        (
            ("--argjson", "a", "nope", "--indent", "x", "1"),
            "jq: invalid JSON text",
        ),
        (
            (
                "--argjson",
                "a",
                "nope",
                "--slurpfile",
                "b",
                "/d/missing.json",
                "1",
            ),
            "jq: invalid JSON text",
        ),
        (
            (
                "--slurpfile",
                "b",
                "/d/missing.json",
                "--argjson",
                "a",
                "nope",
                "1",
            ),
            "jq: Bad JSON in --slurpfile b /d/missing.json",
        ),
        (
            (".", "--jsonargs", "nope", "--indent", "x"),
            "jq: invalid JSON text passed to --jsonargs",
        ),
        ((".", "--indent", "x", "--jsonargs", "nope"), "jq: --indent takes"),
        (
            (".", "--jsonargs", "nope", "--argjson", "a", "nope"),
            "jq: invalid JSON text passed to --jsonargs",
        ),
        (
            (".", "--argjson", "a", "nope", "--jsonargs", "nope"),
            "jq: invalid JSON text passed to --argjson",
        ),
        (
            (".", "--jsonargs", "nope", "--slurpfile", "b", "/d/missing.json"),
            "jq: invalid JSON text passed to --jsonargs",
        ),
        (
            (".", "--slurpfile", "b", "/d/missing.json", "--jsonargs", "nope"),
            "jq: Bad JSON in --slurpfile b /d/missing.json",
        ),
        (
            (".", "--jsonargs", "{", "--bogus"),
            f"jq: invalid JSON text passed to --jsonargs\n{HINT}",
        ),
        (
            (".", "--bogus", "--jsonargs", "{"),
            f"jq: Unknown option --bogus\n{HINT}",
        ),
        (
            (".", "--indent", "9", "--bogus"),
            f"jq: --indent takes a number between -1 and 7\n{HINT}",
        ),
        (
            (".", "--bogus", "--indent", "9"),
            f"jq: Unknown option --bogus\n{HINT}",
        ),
        (
            (".", "--argjson", "x", "{", "-Z"),
            f"jq: invalid JSON text passed to --argjson\n{HINT}",
        ),
    ],
)
async def test_the_first_refusal_typed_is_the_one_reported(words, refusal):
    with pytest.raises(UsageError) as caught:
        await _walk("-n", *words)
    assert str(caught.value).startswith(refusal)


@pytest.mark.asyncio
async def test_help_and_version_answer_where_the_loop_reaches_them():
    assert await _walk("--help", "--bogus") == help_page("jq", SPECS["jq"])
    assert await _walk("-hx") == help_page("jq", SPECS["jq"])
    assert await _walk("-n", ".", "-V", "--jsonargs", "{") == version_line(
        "jq"
    )
    for words in (("--bogus", "--help"), ("-n", ".", "--jsonargs", "{", "-V")):
        with pytest.raises(UsageError):
            await _walk(*words)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "option, expected",
    [
        ("from_file", b"42\n"),
        ("rawfile", b'"42\\n"\n'),
        ("slurpfile", b"[42]\n"),
    ],
)
async def test_dash_flag_file_reads_the_backend_without_a_dispatcher(
    option, expected
):
    path = PathSpec("/d/-", "/d", "-", raw_path="-")
    value = path if option == "from_file" else ["x", path]
    source, io = await jq(
        [],
        "$x",
        read_bytes=_read_bytes,
        read_stream=_read_stream,
        stdin=b"99\n",
        null_input=True,
        compact_output=True,
        **{option: value},
    )
    assert await materialize(source) == expected
    assert io.exit_code == 0
    assert await materialize(io.stderr) == b""


@pytest.mark.asyncio
@pytest.mark.parametrize("option", ["from_file", "rawfile", "slurpfile"])
@pytest.mark.parametrize("operand", [None, "-", "/dev/stdin"])
@pytest.mark.parametrize("streamed", [False, True])
async def test_stdin_consumed_by_a_flag_file_is_not_replayed_as_input(
    option, operand, streamed
):
    path = _path("/dev/stdin")
    value = path if option == "from_file" else ["x", path]
    paths = (
        []
        if operand is None
        else [PathSpec("/dev/stdin", "/dev", "stdin", raw_path=operand)]
    )
    source, io = await jq(
        paths,
        ".",
        read_bytes=_read_bytes,
        read_stream=_read_stream,
        stdin=yield_bytes(b"99\n") if streamed else b"99\n",
        **{option: value},
    )
    assert await materialize(source) == b""
    assert io.exit_code == 0
    assert await materialize(io.stderr) == b""


async def _run_program_file(*words: str) -> tuple[bytes, IOResult]:
    parsed = parse_command(SPECS["jq"], list(words), "/", "jq")
    bag = parse_to_kwargs(parsed)
    bag["from_file"] = _path(str(bag["from_file"]))
    source, io = await jq_generic(
        [], parsed.texts(), CommandOpts(flags=bag), _read_bytes, _read_stream
    )
    return (await materialize(source) if source is not None else b""), io


@pytest.mark.asyncio
async def test_the_program_file_is_read_after_the_option_loop():
    with pytest.raises(UsageError, match="Unknown option --bogus"):
        await _run_program_file("-n", "-f", "/d/missing.jq", "--bogus")
    _, io = await _run_program_file("-n", "-f", "/d/missing.jq")
    assert io.exit_code == 2
    assert b"Could not open" in await materialize(io.stderr)

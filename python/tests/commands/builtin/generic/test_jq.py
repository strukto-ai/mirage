import asyncio
import errno

import pytest

from mirage.commands.builtin.generic import jq as jq_module
from mirage.commands.builtin.generic.jq import (
    jq,
    jq_generic,
    option_tape,
)
from mirage.commands.config import Context
from mirage.commands.spec import SPECS, parse_command, parse_to_kwargs
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.standard import help_page, version_line
from mirage.commands.spec.types import FlagValue
from mirage.io.spool import ByteSpool
from mirage.io.stream import yield_bytes
from mirage.io.types import IOResult, materialize
from mirage.rs.errors import StreamRefusal
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
    "/d/spelled.json": b'{"b":1.000,"1":2}',
    "/d/origin.jq": b"[get_prog_origin, get_jq_origin]",
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
    if "from_file" in bag:
        bag["from_file"] = _path(str(bag["from_file"]))
    return bag, parsed.texts()


async def _line(*words: str, stream=None) -> tuple[bytes, bytes, int]:
    bag, texts = _parsed_line(*words)
    source, io = await jq_generic(
        [], texts, Context(flags=bag), stream or _read_stream
    )
    out = await materialize(source) if source is not None else b""
    return out, await materialize(io.stderr), io.exit_code


async def _unread(path: PathSpec):
    raise AssertionError(f"{path.virtual} should not be read")
    yield b""


async def _run(paths: list[str], *texts: str, **flags: FlagValue) -> tuple:
    source, io = await jq(
        [_path(p) for p in paths],
        *texts,
        stream=_read_stream,
        **flags,
    )
    return await materialize(source) if source is not None else b"", io


@pytest.mark.asyncio
async def test_outputs_keep_the_spelling_jq_gives_them():
    out, io = await _run(
        ["/d/spelled.json"],
        "., .b, (.b + 0), (1e17 * 1), -0, keys_unsorted",
        compact_output=True,
    )
    assert (out, io.exit_code) == (
        b'{"b":1.000,"1":2}\n1.000\n1\n1e+17\n0\n["b","1"]\n',
        0,
    )


def test_the_tape_takes_bindings_from_the_bag_and_names_files_as_typed():
    typed = PathSpec("/d/one.json", "/d", "d/one.json", raw_path="one.json")
    program = PathSpec("/d/p.jq", "/d", "d/p.jq", raw_path="p.jq")
    bag, texts = _parsed_line(
        "-n", "--arg", "a", "1", "--rawfile", "r", "x", "-f", "p", "--args"
    )
    bag["rawfile"] = ["r", typed]
    bag["from_file"] = program
    tape, files = option_tape(FlagView(bag, spec=SPECS["jq"]), texts)
    assert tape == [
        ("null_input", ""),
        ("arg", "a"),
        ("arg", "1"),
        ("rawfile", "r"),
        ("rawfile", "one.json"),
        ("from_file", "p.jq"),
        ("args", ""),
    ]
    assert files == {4: typed, 5: program}


def test_keyword_operands_come_after_every_option():
    fl = FlagView(
        {"args": True, "null_input": False, "slurpfile": ["s", "/d/a"]},
        spec=SPECS["jq"],
    )
    tape, files = option_tape(fl, [".", "a"])
    assert tape == [
        ("args", ""),
        ("slurpfile", "s"),
        ("slurpfile", "/d/a"),
        ("", "."),
        ("", "a"),
    ]
    assert files[2].virtual == "/d/a"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "words, out",
    [
        (["--indent", "-1"], b'{\n\t"a": [\n\t\t1\n\t]\n}\n'),
        (["-c", "--indent", "1"], b'{\n "a": [\n  1\n ]\n}\n'),
        (["--indent", "1", "-c"], b'{"a":[1]}\n'),
        (["--tab", "-j"], b'{\n\t"a": [\n\t\t1\n\t]\n}'),
    ],
)
async def test_the_layout_the_option_loop_decides_is_the_one_printed(
    words, out
):
    assert await _line("-n", *words, "{a: [1]}") == (out, b"", 0)


@pytest.mark.asyncio
async def test_bindings_reach_the_program_in_the_order_typed():
    out, err, code = await _line(
        "-nc",
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
        '{"x":1.000}',
        "--slurpfile",
        "s",
        "/d/missing.json",
        "$ARGS.named, $b",
    )
    assert (out, err, code) == (
        b'{"s":[1,2,3,4],"a":"1","r":"1","b":{"x":1.000}}\n{"x":1.000}\n',
        b"",
        0,
    )


@pytest.mark.asyncio
async def test_a_binding_of_a_taken_name_is_never_read():
    out, err, code = await _line(
        "-n",
        "--arg",
        "v",
        "1",
        "--slurpfile",
        "v",
        "/d/four.json",
        "$v",
        stream=_unread,
    )
    assert (out, err, code) == (b'"1"\n', b"", 0)


@pytest.mark.asyncio
async def test_operands_after_args_and_jsonargs_are_positional():
    out, err, code = await _line(
        "-nc",
        "$ARGS.positional",
        "/d/a.json",
        "--args",
        "x",
        "--jsonargs",
        '{"b":1.0}',
    )
    assert (out, err, code) == (b'["x",{"b":1.0}]\n', b"", 0)
    source, io = await jq(
        [], ".", "a", stream=_read_stream, null_input=True, args=True
    )
    assert await materialize(source) == b"null\n"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "words, stderr",
    [
        (
            ["--slurpfile", "x", "/d/bad.json"],
            b"jq: Bad JSON in --slurpfile x /d/bad.json: Unfinished JSON "
            b"term at EOF at line 3, column 1\n",
        ),
        (
            ["--rawfile", "x", "/d/nope.json"],
            b"jq: Bad JSON in --rawfile x /d/nope.json: Could not open "
            b"/d/nope.json: No such file or directory\n",
        ),
        (
            ["--slurpfile", "x", "/d/dir"],
            b"jq: Bad JSON in --slurpfile x /d/dir: Could not open /d/dir: "
            b"It's a directory\n",
        ),
        (
            ["--slurpfile", "x", "/d/nope.json", "--indent", "9"],
            b"jq: Bad JSON in --slurpfile x /d/nope.json: Could not open "
            b"/d/nope.json: No such file or directory\n",
        ),
        (
            ["--indent", "9", "--slurpfile", "x", "/d/nope.json"],
            f"jq: --indent takes a number between -1 and 7\n{HINT}\n".encode(),
        ),
        (
            ["--argjson", "x", "{", "--bogus"],
            f"jq: invalid JSON text passed to --argjson\n{HINT}\n".encode(),
        ),
        (["--bogus"], f"jq: Unknown option --bogus\n{HINT}\n".encode()),
    ],
)
async def test_the_first_refusal_typed_is_the_one_reported(words, stderr):
    assert await _line("-n", *words, "$x") == (b"", stderr, 2)


@pytest.mark.asyncio
async def test_help_and_version_answer_where_the_loop_reaches_them():
    help_text = help_page("jq", SPECS["jq"])
    assert await _line("--help", "--bogus") == (help_text, b"", 0)
    assert await _line("-hx") == (help_text, b"", 0)
    assert await _line("-n", ".", "-V", "--jsonargs", "{") == (
        version_line("jq"),
        b"",
        0,
    )
    _, err, code = await _line("--bogus", "--help")
    assert (err.startswith(b"jq: Unknown option --bogus"), code) == (True, 2)


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
        stream=tracked,
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
        stream=_live(b"[1 2]\n"),
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
        stream=_live(b"1\n2\n"),
        compact_output=True,
    )
    assert await asyncio.wait_for(anext(source), 5) == b"[1,2]\n"
    await source.aclose()


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
        stream=_read_stream,
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
        stream=_read_stream,
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
        [], parsed.texts(), Context(flags=bag), _read_stream
    )
    return (await materialize(source) if source is not None else b""), io


@pytest.mark.asyncio
async def test_the_program_file_is_read_after_the_option_loop():
    _, io = await _run_program_file("-n", "-f", "/d/missing.jq", "--bogus")
    assert io.exit_code == 2
    assert b"Unknown option --bogus" in await materialize(io.stderr)
    _, io = await _run_program_file("-n", "-f", "/d/missing.jq")
    assert io.exit_code == 2
    assert b"Could not open" in await materialize(io.stderr)


@pytest.mark.asyncio
async def test_a_program_that_never_ends_is_cancelled_on_this_thread():
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(
            _run([], "until(false; .)", null_input=True), timeout=0.2
        )
    out, io = await _run(["/d/a.json"], ".a + 1")
    assert (out, io.exit_code) == (b"2\n", 0)


@pytest.mark.asyncio
async def test_math_builtins_run_in_jq_eval():
    out, io = await _run(
        [], "5 | tgamma, (4 | lgamma_r)", null_input=True, compact_output=True
    )
    assert (out, io.exit_code) == (b"24\n[1.791759469228055,1]\n", 0)


@pytest.mark.asyncio
async def test_dates_and_the_clock_stay_on_the_loops_thread(monkeypatch):
    monkeypatch.setenv("TZ", "EST5EDT,M3.2.0,M11.1.0")
    out, io = await _run(
        [],
        "1425599507 | todate, (localtime | .[3]), (now | type)",
        null_input=True,
    )
    assert (out, io.exit_code) == (
        b'"2015-03-05T23:51:47Z"\n18\n"number"\n',
        0,
    )


@pytest.mark.asyncio
async def test_local_time_reads_the_sessions_zone_from_the_tz_database(
    monkeypatch,
):
    monkeypatch.setenv("TZ", "/usr/share/zoneinfo/Europe/Paris")
    program = (
        '1690000000 | strflocaltime("%H:%M %Z %z"), strftime("%Z"), '
        "(1 | debug | (0 | localtime) | .[3])"
    )
    out, io = await _run([], program, null_input=True)
    assert (out, io.exit_code) == (b'"06:26 CEST +0200"\n"GMT"\n1\n', 0)
    assert await materialize(io.stderr) == b'["DEBUG:",1]\n'
    bag = parse_to_kwargs(
        parse_command(SPECS["jq"], ["-n", program], "/", "jq")
    )
    source, _ = await jq_generic(
        [],
        [program],
        Context(flags=bag, env={"TZ": "Asia/Kolkata"}),
        _read_stream,
    )
    assert source is not None
    assert await materialize(source) == b'"09:56 IST +0530"\n"GMT"\n5\n'


@pytest.mark.asyncio
async def test_each_output_goes_out_before_its_run_ends():
    # An output is printed as its drain makes it, so the first of a run
    # that never ends can be read.
    source, io = await jq(
        [], "0, until(false; .)", stream=_read_stream, null_input=True
    )
    assert source is not None
    chunks = aiter(source)
    assert await asyncio.wait_for(anext(chunks), 10) == b"0\n"
    await chunks.aclose()


@pytest.mark.asyncio
async def test_a_raw_output0_refusal_stops_its_run_and_the_next_runs():
    # Pinned to jq 1.8.2: printf '1 2' | jq --raw-output0 'if . == 1 then
    # "x", "a\u0000b", (1 | debug), "y" else "c" end' prints x, refuses the
    # NUL string, leaves the debug line and y unwritten, and runs the second
    # document, whose run settles the exit status.
    out, io = await _run(
        [],
        'if . == 1 then "x", "a\\u0000b", (1 | debug), "y" else "c" end',
        stdin=b"1 2",
        raw_output0=True,
    )
    assert out == b"x\0c\0"
    assert io.exit_code == 0
    assert await materialize(io.stderr) == (
        b"jq: error (at <stdin>:0): Cannot dump a string containing NUL with"
        b" --raw-output0 option\n"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("program", "flags", "out", "err", "code"),
    [
        ("[., input]", {}, b"[1,2]\n[3,4]\n", b"", 0),
        ("first(inputs)", {}, b"2\n4\n", b"", 0),
        (
            "if . == 1 then [., input] else . end",
            {},
            b"[1,2]\n3\n4\n",
            b"",
            0,
        ),
        (
            "[., input, input]",
            {},
            b"[1,2,3]\n",
            b"jq: error (at /d/four.json:4): break\n",
            5,
        ),
        (
            "[input_filename, input_line_number]",
            {"null_input": True},
            b"[null,0]\n",
            b"",
            0,
        ),
        ("[inputs] | length", {"null_input": True}, b"4\n", b"", 0),
    ],
)
async def test_input_takes_each_document_when_the_program_asks(
    program, flags, out, err, code
):
    got, io = await _run(
        ["/d/four.json"], program, compact_output=True, **flags
    )
    assert (got, await materialize(io.stderr), io.exit_code) == (
        out,
        err,
        code,
    )


@pytest.mark.asyncio
async def test_input_meets_a_parse_error_and_the_reader_position():
    out, io = await _run(["/d/mid.json"], "[., input]", compact_output=True)
    assert (out, io.exit_code) == (b"[3,4]\n", 0)
    assert await materialize(io.stderr) == (
        b"jq: error (at /d/mid.json:2): Expected separator between values "
        b"at line 2, column 5\n"
    )
    out, _ = await _run(
        ["/d/a.json", "/d/b.json"],
        "[., input_filename, input_line_number, input, input_filename]",
        compact_output=True,
    )
    assert out == b'[{"a":1},"/d/a.json",1,{"b":2},"/d/b.json"]\n'


@pytest.mark.asyncio
async def test_debug_and_stderr_write_before_the_runs_report():
    out, io = await _run(
        [],
        '{"b":1,"a":2} | (debug | empty), ("x" | stderr | empty), '
        '({"c":3} | stderr | error)',
        null_input=True,
        sort_keys=True,
    )
    assert (out, io.exit_code) == (b"", 5)
    assert await materialize(io.stderr) == (
        b'["DEBUG:",{"a":2,"b":1}]\n'
        b'x{"c":3}jq: error (at <unknown>) (not a string): {"c":3}\n'
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("program", "out"),
    [
        (
            "[$ENV.HOME, env.HOME, ($ENV | length)]",
            b'["/home/agent","/home/agent",1]\n',
        ),
        (
            "[$ENV.HOME, env.HOME, ($ENV | length), (now | type)]",
            b'["/home/agent","/home/agent",1,"number"]\n',
        ),
    ],
)
async def test_env_reads_the_sessions_exported_environment(program, out):
    bag = parse_to_kwargs(
        parse_command(SPECS["jq"], ["-c", "-n", program], "/", "jq")
    )
    source, _ = await jq_generic(
        [],
        [program],
        Context(flags=bag, env={"HOME": "/home/agent"}),
        _read_stream,
    )
    assert source is not None
    assert await materialize(source) == out
    out, _ = await _run([], "$ENV", null_input=True)
    assert out == b"{}\n"


@pytest.mark.asyncio
async def test_jq_eval_reports_a_refused_program_as_jq_does():
    out, io = await _run([], "  $x | nosuch(1) +", null_input=True)
    assert (out, io.exit_code) == (b"", 3)
    assert await materialize(io.stderr) == (
        b"jq: error: syntax error, unexpected end of file at <top-level>,"
        b" line 1, column 18:\n      $x | nosuch(1) +\n"
        b"                     ^\njq: 1 compile error\n"
    )
    _, io = await _run([], "$x | nosuch(1)", null_input=True)
    assert await materialize(io.stderr) == (
        b"jq: error: $x is not defined at <top-level>, line 1, column 1:\n"
        b"    $x | nosuch(1)\n    ^^\n"
        b"jq: error: nosuch/1 is not defined at <top-level>, line 1,"
        b" column 6:\n    $x | nosuch(1)\n         ^^^^^^\n"
        b"jq: 2 compile errors\n"
    )


@pytest.mark.asyncio
async def test_get_prog_origin_is_the_program_files_directory_else_the_cwd():
    program = "[get_prog_origin, get_jq_origin]"
    bag = parse_to_kwargs(
        parse_command(SPECS["jq"], ["-c", "-n", program], "/", "jq")
    )
    source, _ = await jq_generic(
        [], [program], Context(flags=bag, cwd=_path("/d/dir")), _read_stream
    )
    assert source is not None
    assert await materialize(source) == b'["/d/dir","."]\n'
    out, io = await _run_program_file("-c", "-n", "-f", "/d/origin.jq")
    assert (out, io.exit_code) == (b'["/d","."]\n', 0)


@pytest.mark.asyncio
async def test_now_reads_the_clock_at_each_call():
    out, io = await _run(
        [], 'now as $s | until(now > $s; .) | "done"', null_input=True
    )
    assert (out, io.exit_code) == (b'"done"\n', 0)


def _patched(monkeypatch, method: str, replacement) -> None:
    # Patch one method of every jq run the command opens, its option loop
    # left as it is.
    opened = jq_module.open_stream

    def opening(kind, config):
        stream = opened(kind, config)
        if kind == "jq":
            setattr(stream, method, replacement)
        return stream

    monkeypatch.setattr(jq_module, "open_stream", opening)


@pytest.mark.asyncio
async def test_a_refused_read_is_not_read_past(monkeypatch):
    def respond(reply, data):
        raise StreamRefusal("reply fixture", b"")

    _patched(monkeypatch, "respond", respond)
    with pytest.raises(StreamRefusal, match="reply fixture"):
        await _run(["/d/one.json"], "input", null_input=True)


@pytest.mark.asyncio
async def test_an_unknown_request_is_refused_without_reading_input(
    monkeypatch,
):
    reads = 0

    async def counted(path: PathSpec):
        nonlocal reads
        reads += 1
        yield b"1"

    _patched(monkeypatch, "request", lambda: ({"op": "fixture"}, b""))
    source, _ = await jq(
        [_path("/d/one.json")], "input", stream=counted, null_input=True
    )
    with pytest.raises(ValueError, match="unknown host request"):
        await materialize(source)
    assert reads == 0


@pytest.mark.asyncio
async def test_a_spool_that_fails_still_closes_the_inputs_and_the_stream(
    monkeypatch,
):
    class Lost(ByteSpool):
        appends = 0

        async def append(self, data: bytes) -> None:
            self.appends += 1
            if self.appends >= 3:
                raise OSError(errno.ENOSPC, "No space left on device")
            await super().append(data)

    released = []
    close_stream = jq_module.close_stream

    async def closing(stream):
        released.append(stream)
        await close_stream(stream)

    finished = []

    async def endless(path: PathSpec):
        try:
            for _ in range(1000):
                yield b"1 "
        finally:
            finished.append(path)

    monkeypatch.setattr(jq_module, "ByteSpool", Lost)
    monkeypatch.setattr(jq_module, "close_stream", closing)
    source, _ = await jq([_path("/d/one.json")], ".", stream=endless)
    with pytest.raises(OSError, match="No space left"):
        await materialize(source)
    # The option loop's stream, the compile check's and the run's, and
    # the input.
    assert len(released) == 3
    assert len(finished) == 1

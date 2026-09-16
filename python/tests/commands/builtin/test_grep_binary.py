import re
from collections.abc import AsyncIterator

import pytest

from mirage.commands.builtin.generic.grep import parse_flags
from mirage.commands.builtin.grep_binary import PROBE_BLOCK_BYTES, grep_input
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.parser import parse_command, parse_to_kwargs
from mirage.commands.spec.types import FlagView
from mirage.io.types import IOResult, materialize


@pytest.mark.asyncio
@pytest.mark.parametrize("chunk_size", [1, 2, 7, 1024, PROBE_BLOCK_BYTES])
@pytest.mark.parametrize("mode,stdout,stderr,code", [
    ("binary", b"", b"grep: /remote/data.pdf: binary file matches\n", 0),
    ("without-match", b"", b"", 1),
    ("text", b"2:needle\0tail\n", b"", 0),
])
async def test_binary_result_is_independent_of_backend_chunks(
        chunk_size, mode, stdout, stderr, code):
    data = b"before\nneedle\0tail\n"

    async def source() -> AsyncIterator[bytes]:
        for offset in range(0, len(data), chunk_size):
            yield data[offset:offset + chunk_size]

    flags = parse_flags(
        FlagView({
            "binary_files": mode,
            "n": True
        }, spec=SPECS["grep"]), False)
    io = IOResult(exit_code=1)
    out = await materialize(
        grep_input(source(), re.compile("needle"), flags, "/remote/data.pdf",
                   False, io))
    assert (out, io.stderr or b"", io.exit_code) == (stdout, stderr, code)


@pytest.mark.asyncio
@pytest.mark.parametrize("chunk_size", [1, 2, 3, 7, PROBE_BLOCK_BYTES])
async def test_multibyte_text_survives_split_reads(chunk_size):
    data = "é needle 😀\n".encode()

    async def source() -> AsyncIterator[bytes]:
        for offset in range(0, len(data), chunk_size):
            yield data[offset:offset + chunk_size]

    flags = parse_flags(FlagView({}, spec=SPECS["grep"]), False)
    io = IOResult(exit_code=1)
    assert await materialize(
        grep_input(source(), re.compile("needle"), flags, "/doc.gdoc.json",
                   False, io)) == data
    assert io.exit_code == 0
    assert not io.stderr


@pytest.mark.asyncio
@pytest.mark.parametrize("flags", [{"args_I": True}, {"q": True}, {}])
async def test_binary_scan_stops_after_bounded_probe(flags):
    block = b"needle\0" + b"x" * (PROBE_BLOCK_BYTES - 7)

    closed = False

    async def source() -> AsyncIterator[bytes]:
        nonlocal closed
        try:
            yield block
            raise AssertionError("unnecessary remote read")
        finally:
            closed = True

    f = parse_flags(FlagView(flags, spec=SPECS["grep"]), False)
    io = IOResult(exit_code=1)
    assert await materialize(
        grep_input(source(), re.compile("needle"), f, "/remote/large.pdf",
                   False, io)) == b""
    assert closed


@pytest.mark.asyncio
async def test_max_count_does_not_read_past_the_probe_block():
    closed = False

    async def source() -> AsyncIterator[bytes]:
        nonlocal closed
        try:
            yield b"needle\n" + b"x" * (PROBE_BLOCK_BYTES - 7)
            raise AssertionError("read past the requested match")
        finally:
            closed = True

    f = parse_flags(FlagView({"m": 1}, spec=SPECS["grep"]), False)
    io = IOResult()
    assert await materialize(
        grep_input(source(), re.compile("needle"), f, "/remote/rows.jsonl",
                   False, io)) == b"needle\n"
    assert io.exit_code == 0
    assert closed


@pytest.mark.parametrize("flags, shown", [
    ({
        "B": "-1"
    }, "-1"),
    ({
        "A": "-1"
    }, "-1"),
    ({
        "C": "-1"
    }, "-1"),
    ({
        "A": "x"
    }, "x"),
    ({
        "B": "1.5"
    }, "1.5"),
    ({
        "B": -1
    }, "-1"),
    ({
        "B": "-1",
        "A": "x"
    }, "-1"),
    ({
        "A": "x",
        "B": "-1"
    }, "x"),
])
def test_invalid_context_length(flags, shown):
    with pytest.raises(
            UsageError,
            match=f"grep: {shown}: invalid context length argument"):
        parse_flags(FlagView(flags, spec=SPECS["grep"]), False)


@pytest.mark.parametrize("flags", [{"B": "-0"}, {"A": "0"}, {"C": 2}])
def test_valid_context_length(flags):
    parse_flags(FlagView(flags, spec=SPECS["grep"]), False)


@pytest.mark.parametrize("value", ["", "bogus"])
def test_invalid_binary_mode(value):
    with pytest.raises(UsageError, match="unknown binary-files type"):
        parse_flags(FlagView({"binary_files": value}, spec=SPECS["grep"]),
                    False)


@pytest.mark.asyncio
@pytest.mark.parametrize("chunk_size",
                         [1024, PROBE_BLOCK_BYTES, 2 * PROBE_BLOCK_BYTES])
@pytest.mark.parametrize("line_end", [b"", b"\n"])
@pytest.mark.parametrize("count_only", [False, True])
@pytest.mark.parametrize("binary_flag", [{
    "args_I": True
}, {
    "binary_files": "without-match"
}])
async def test_late_nul_discards_earlier_matches(chunk_size, line_end,
                                                 count_only, binary_flag):
    data = (b"needle\n" + b"x" * (PROBE_BLOCK_BYTES - 7 - len(line_end)) +
            line_end + b"\0tail\n")
    closed = False

    async def source() -> AsyncIterator[bytes]:
        nonlocal closed
        try:
            for offset in range(0, len(data), chunk_size):
                yield data[offset:offset + chunk_size]
            raise AssertionError("read past the binary block")
        finally:
            closed = True

    f = parse_flags(
        FlagView({
            **binary_flag, "c": count_only
        }, spec=SPECS["grep"]), False)
    io = IOResult()
    out = await materialize(
        grep_input(source(), re.compile("needle"), f, "/remote/late.txt", True,
                   io))
    # Streaming output already emitted before the NUL cannot be retracted.
    expected = (b"/remote/late.txt:0\n"
                if count_only else b"/remote/late.txt:needle\n")
    assert (out, io.stderr or b"", io.exit_code) == (expected, b"", 1)
    assert closed


@pytest.mark.asyncio
@pytest.mark.parametrize("flags,expected", [
    ({
        "m": 1,
        "c": True
    }, b"1\n"),
    ({
        "q": True
    }, b""),
    ({
        "args_l": True
    }, b"/remote/rows.jsonl\n"),
])
async def test_without_match_early_stop_does_not_read_ahead(flags, expected):
    closed = False

    async def source() -> AsyncIterator[bytes]:
        nonlocal closed
        try:
            yield b"needle\n" + b"x" * (PROBE_BLOCK_BYTES - 7)
            raise AssertionError("read past the requested match")
        finally:
            closed = True

    f = parse_flags(FlagView({
        "args_I": True,
        **flags
    }, spec=SPECS["grep"]), False)
    io = IOResult()
    out = await materialize(
        grep_input(source(), re.compile("needle"), f, "/remote/rows.jsonl",
                   False, io))
    assert (out, io.stderr or b"", io.exit_code) == (expected, b"", 0)
    assert closed


async def _lines(*rows: bytes):
    for row in rows:
        yield row


@pytest.mark.asyncio
@pytest.mark.parametrize("flags, after_output, expected", [
    ({
        "A": 1
    }, True, b"--\nf:a\nf-b\n"),
    ({
        "A": 1
    }, False, b"f:a\nf-b\n"),
    ({
        "B": 1
    }, True, b"--\nf:a\n"),
    ({
        "c": True,
        "A": 1
    }, True, b"f:1\n"),
    ({
        "o": True,
        "A": 1
    }, True, b"f:a\n"),
    ({}, True, b"f:a\n"),
])
async def test_context_group_after_an_earlier_input_opens_with_separator(
        flags, after_output, expected):
    f = parse_flags(FlagView(flags, spec=SPECS["grep"]), False)
    io = IOResult()
    out = await materialize(
        grep_input(_lines(b"a\nb\n"), re.compile("a"), f, "f", True, io,
                   after_output))
    assert out == expected


@pytest.mark.asyncio
@pytest.mark.parametrize("mode,stdout,stderr,code", [
    ("binary", b"needle\n", b"", 0),
    ("without-match", b"needle\n", b"", 1),
    ("text", b"needle\n", b"", 0),
])
async def test_nul_in_a_later_chunk_is_gnu_pipe_behavior(
        mode, stdout, stderr, code):
    # (printf 'needle\n'; sleep 1; printf '\0tail\n') | grep needle prints
    # the match under GNU 3.11 too; only a later match is suppressed, and
    # -I still reports 1. Merging chunks to avoid this would read ahead.
    closed = False

    async def source() -> AsyncIterator[bytes]:
        nonlocal closed
        try:
            yield b"needle\n"
            yield b"\0tail\n"
        finally:
            closed = True

    f = parse_flags(FlagView({"binary_files": mode}, spec=SPECS["grep"]),
                    False)
    io = IOResult(exit_code=1)
    out = await materialize(
        grep_input(source(), re.compile("needle"), f, "/remote/data.pdf",
                   False, io))
    assert (out, io.stderr or b"", io.exit_code) == (stdout, stderr, code)
    assert closed


@pytest.mark.asyncio
@pytest.mark.parametrize("data, pattern, stderr", [
    (b"a\0b\n", "^", b"grep: /data/z: binary file matches\n"),
    (b"a\0b\nzz\n", "z*", b"grep: /data/z: binary file matches\n"),
    (b"a\xffb\n", "^", b""),
])
async def test_zero_width_only_matching_still_notices_a_nul(
        data, pattern, stderr):
    f = parse_flags(FlagView({"o": True}, spec=SPECS["grep"]), False)
    io = IOResult(exit_code=1)
    out = await materialize(
        grep_input(_lines(data), re.compile(pattern), f, "/data/z", False, io))
    assert (out, io.stderr or b"", io.exit_code) == (b"", stderr, 0)


# -m0 selects no line and the whole command goes quiet, -c included.
# Measured on GNU grep 3.11: `grep -m0 a f`, `grep -m0 -c a f`,
# `grep -m0 -v a f`, `grep -m0 -l a f`, `grep -m0 -o a f`,
# `grep -m0 -A1 a f` and `grep -m0 -c a f g` are all zero bytes and exit 1,
# across the `-m0`, `-m 0` and `--max-count=0` spellings. -c printing a bare
# `0` here would be wrong twice over: GNU prints nothing, and a GENUINE zero
# still prints `0` (`grep -c a g` is `0\n`, exit 1), so the two cases have to
# stay distinguishable.
@pytest.mark.asyncio
@pytest.mark.parametrize("flags", [
    {
        "m": 0
    },
    {
        "m": 0,
        "c": True
    },
    {
        "m": 0,
        "v": True
    },
    {
        "m": 0,
        "l": True
    },
    {
        "m": 0,
        "o": True
    },
    {
        "m": 0,
        "A": "1"
    },
    {
        "m": 0,
        "c": True,
        "n": True,
        "b": True
    },
])
async def test_max_count_zero_prints_nothing_and_closes_the_unread_source(
        flags):
    source = _OpenSource()
    f = parse_flags(FlagView(flags, spec=SPECS["grep"]), False)
    io = IOResult()
    out = await materialize(
        grep_input(source, re.compile("needle"), f, "/remote/rows.jsonl",
                   False, io))
    assert (out, io.exit_code) == (b"", 1)
    assert source.closed


@pytest.mark.asyncio
async def test_a_genuine_zero_count_still_prints_zero():
    # The mirror of the -m0 rows above: without -m0, `grep -c` on a file
    # holding no match prints `0` and exits 1 (GNU grep 3.11).
    f = parse_flags(FlagView({"c": True}, spec=SPECS["grep"]), False)
    io = IOResult(exit_code=1)
    out = await materialize(
        grep_input(_lines(b"a\nb\n"), re.compile("needle"), f, "/data/z",
                   False, io))
    assert (out, io.exit_code) == (b"0\n", 1)


class _OpenSource:
    """A source whose resources are already held before the first read."""

    def __init__(self) -> None:
        self.closed = False

    def __aiter__(self) -> "_OpenSource":
        return self

    async def __anext__(self) -> bytes:
        raise AssertionError("read under -m0")

    async def aclose(self) -> None:
        self.closed = True


# The byte layout of every fixture below is section Q1 of the GNU truth
# file, measured against GNU grep 3.11.
_F1 = b"abc\ndefabc\nabc abc\n"
_F3 = b"one\ntwo abc\nthree\nfour abc\nfive\n"
_F4 = b"a\nb\nHIT\nc\nd\ne\nf\nHIT\ng\n"
_F5 = "café abc\nxéy abc\n".encode()
_F6 = b"no-newline-abc"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "data, flags, show, expected, code",
    [
        # Without -o the number is the offset of the LINE's first byte: line
        # two prints 4, not the 7 its match sits at.
        (_F1, {
            "byte_offset": True
        }, False, b"0:abc\n4:defabc\n11:abc abc\n", 0),
        # With -o it is the offset of the match, and a line with two matches
        # prints both.
        (_F1, {
            "byte_offset": True,
            "o": True
        }, False, b"0:abc\n7:abc\n11:abc\n15:abc\n", 0),
        # Field order is FILENAME, LINE NUMBER, BYTE OFFSET, fixed by the
        # renderer rather than by the order the flags were given in.
        (_F1, {
            "byte_offset": True,
            "n": True
        }, False, b"1:0:abc\n2:4:defabc\n3:11:abc abc\n", 0),
        (_F1, {
            "byte_offset": True,
            "H": True
        }, True, b"f:0:abc\nf:4:defabc\nf:11:abc abc\n", 0),
        (_F1, {
            "byte_offset": True,
            "n": True,
            "H": True,
            "o": True
        }, True, b"f:1:0:abc\nf:2:7:abc\nf:3:11:abc\nf:3:15:abc\n", 0),
        # -b does not reach a count, a file list or -q.
        (_F1, {
            "byte_offset": True,
            "c": True
        }, False, b"3\n", 0),
        (_F3, {
            "byte_offset": True,
            "c": True
        }, False, b"2\n", 0),
        (_F1, {
            "byte_offset": True,
            "c": True,
            "H": True
        }, True, b"f:3\n", 0),
        (_F1, {
            "byte_offset": True,
            "args_l": True
        }, False, b"f\n", 0),
        (_F1, {
            "byte_offset": True,
            "q": True
        }, False, b"", 0),
        # -v prints the line-start offsets of the lines it did not select.
        (_F3, {
            "byte_offset": True,
            "v": True
        }, False, b"0:one\n12:three\n27:five\n", 0),
        (_F1, {
            "byte_offset": True,
            "v": True
        }, False, b"", 1),
        (_F3, {
            "byte_offset": True,
            "m": "1"
        }, False, b"4:two abc\n", 0),
        # A missing final newline does not shift an offset, and must not be
        # counted twice.
        (_F6, {
            "byte_offset": True
        }, False, b"0:no-newline-abc\n", 0),
        (_F6, {
            "byte_offset": True,
            "o": True
        }, False, b"11:abc\n", 0),
    ])
async def test_byte_offset_is_the_line_start_or_the_match(
        data, flags, show, expected, code):
    f = parse_flags(FlagView(flags, spec=SPECS["grep"]), False)
    io = IOResult(exit_code=1)
    out = await materialize(
        grep_input(_lines(data), re.compile("abc"), f, "f", show, io))
    assert (out, io.exit_code) == (expected, code)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "data, pattern, flags, show, expected",
    [
        (_F3, "abc", {
            "byte_offset": True,
            "A": "1"
        }, False, b"4:two abc\n12-three\n18:four abc\n27-five\n"),
        (_F3, "abc", {
            "byte_offset": True,
            "B": "1"
        }, False, b"0-one\n4:two abc\n12-three\n18:four abc\n"),
        (_F3, "abc", {
            "byte_offset": True,
            "C": "1"
        }, False, b"0-one\n4:two abc\n12-three\n18:four abc\n27-five\n"),
        (_F3, "three", {
            "byte_offset": True,
            "A": "1"
        }, False, b"12:three\n18-four abc\n"),
        # Every field on a context line takes `-`, the separator being chosen
        # once per line rather than per field.
        (_F3, "abc", {
            "byte_offset": True,
            "n": True,
            "C": "1"
        }, False,
         b"1-0-one\n2:4:two abc\n3-12-three\n4:18:four abc\n5-27-five\n"),
        (_F3, "abc", {
            "byte_offset": True,
            "n": True,
            "H": True,
            "C": "1"
        }, True, b"f-1-0-one\nf:2:4:two abc\nf-3-12-three\n"
         b"f:4:18:four abc\nf-5-27-five\n"),
        # The group separator is a bare `--` with no prefix fields at all.
        (_F4, "HIT", {
            "byte_offset": True,
            "n": True,
            "C": "1"
        }, False, b"2-2-b\n3:4:HIT\n4-8-c\n--\n7-14-f\n8:16:HIT\n9-20-g\n"),
        # -o beats -C entirely: only matches, no context and no separator.
        (_F3, "abc", {
            "byte_offset": True,
            "o": True,
            "C": "1"
        }, False, b"8:abc\n23:abc\n"),
    ])
async def test_byte_offset_on_a_context_line_uses_the_dash_separator(
        data, pattern, flags, show, expected):
    f = parse_flags(FlagView(flags, spec=SPECS["grep"]), False)
    io = IOResult(exit_code=1)
    out = await materialize(
        grep_input(_lines(data), re.compile(pattern), f, "f", show, io))
    assert (out, io.exit_code) == (expected, 0)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "data, pattern, flags, expected",
    [
        # An empty match prints nothing under -ob, exactly as under -o, and
        # the line is still selected.
        (b"ab\n", "[0-9]*", {
            "byte_offset": True,
            "o": True
        }, b""),
        (b"ab\n", "", {
            "byte_offset": True,
            "o": True
        }, b""),
        (b"a1b\n", "[0-9]*", {
            "byte_offset": True,
            "o": True
        }, b"1:1\n"),
        (b"a1b\nc2d\n", "[0-9]*", {
            "byte_offset": True,
            "o": True
        }, b"1:1\n5:2\n"),
        (b"ab\ncd\n", "[0-9]*", {
            "byte_offset": True
        }, b"0:ab\n3:cd\n"),
    ])
async def test_empty_matches_under_ob_behave_as_under_o(
        data, pattern, flags, expected):
    f = parse_flags(FlagView(flags, spec=SPECS["grep"]), False)
    io = IOResult(exit_code=1)
    out = await materialize(
        grep_input(_lines(data), re.compile(pattern), f, "f", False, io))
    assert (out, io.exit_code) == (expected, 0)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "flags, expected",
    [
        # `caf` + U+00E9 (two bytes) + a space is six bytes, so the match sits
        # at byte 6 and not at character index 5; line two starts at 10 and
        # its match is at 15, not 13. GNU reports the same numbers under C and
        # C.utf8.
        ({
            "byte_offset": True,
            "o": True
        }, b"6:abc\n15:abc\n"),
        ({
            "byte_offset": True,
            "o": True,
            "n": True
        }, b"1:6:abc\n2:15:abc\n"),
        ({
            "byte_offset": True
        }, b"0:caf\xc3\xa9 abc\n10:x\xc3\xa9y abc\n"),
    ])
async def test_offsets_count_bytes_not_characters(flags, expected):
    f = parse_flags(FlagView(flags, spec=SPECS["grep"]), False)
    io = IOResult(exit_code=1)
    out = await materialize(
        grep_input(_lines(_F5), re.compile("abc"), f, "f", False, io))
    assert (out, io.exit_code) == (expected, 0)


@pytest.mark.parametrize("argv, expected", [
    (["-b", "abc", "f"], True),
    (["--byte-offset", "abc", "f"], True),
    (["-bn", "abc", "f"], True),
    (["abc", "f"], False),
])
def test_byte_offset_reaches_the_generic_from_either_spelling(argv, expected):
    # The dest of -b/--byte-offset is `byte_offset`, so a query for the
    # short spelling would read as absent without the parser complaining.
    parsed = parse_command(SPECS["grep"], argv, "/")
    bag = parse_to_kwargs(parsed)
    f = parse_flags(FlagView(bag, spec=SPECS["grep"]), False)
    assert f.byte_offsets is expected

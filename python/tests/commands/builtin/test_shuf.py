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

import asyncio

import pytest

from mirage.resource.ram import RAMResource
from mirage.types import MountMode, PathSpec
from mirage.workspace import Workspace

from mirage.commands.builtin.generic.shuf import (  # isort: skip
    MAX_OUTPUT_LINES, MEMORY_EXHAUSTED, NO_WRITE_OP, SIZE_MAX, UINTMAX_MAX,
    RangeRefusal, emit_count, parse_flags, parse_input_range, range_error,
    shuf)


def _ws():
    mem = RAMResource()
    ws = Workspace(
        {"/data": (mem, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )
    return ws, mem


def _run_raw(ws, cmd, cwd="/", stdin=None):
    ws._cwd = cwd
    io = asyncio.run(ws.execute(cmd, stdin=stdin))
    return io.stdout, io


def _bytes(stdout):
    if isinstance(stdout, bytes):
        return stdout
    return b"".join(asyncio.run(_collect(stdout)))


async def _collect(ait):
    return [chunk async for chunk in ait]


def test_shuf_e():
    ws, _ = _ws()
    stdout, _ = _run_raw(ws, "shuf -e a b c", cwd="/data")
    lines = _bytes(stdout).strip().decode().split("\n")
    assert len(lines) == 3
    assert sorted(lines) == sorted(["/a", "/b", "/c"])


def test_shuf_n():
    ws, _ = _ws()
    stdout, _ = _run_raw(ws, "shuf -e -n 2 a b c d e", cwd="/data")
    lines = _bytes(stdout).strip().decode().split("\n")
    assert len(lines) == 2


def test_shuf_r():
    ws, _ = _ws()
    stdout, _ = _run_raw(ws, "shuf -r -e -n 5 a b c", cwd="/data")
    lines = _bytes(stdout).strip().decode().split("\n")
    assert len(lines) == 5


async def _unused_read_bytes(_path):
    raise AssertionError("read_bytes should not be called for -i")


@pytest.mark.parametrize("raw", ["abc", "2x"])
def test_shuf_head_count_refusal_quotes_the_whole_argument(raw):
    """GNU quotes all of `-n 2x`, unlike expand and cut."""
    ws, _ = _ws()
    stdout, io = _run_raw(ws, f"shuf -e -n {raw} a b c", cwd="/data")
    assert io.exit_code == 1
    assert io.stderr == f"shuf: invalid line count: '{raw}'\n".encode()
    assert not stdout


@pytest.mark.parametrize("raw", [" 5 ", "1_0", "0x10", "1e3", ""])
def test_shuf_head_count_is_as_strict_as_gnu(raw):
    """`int()` reads ` 5 ` and `1_0` whole; GNU refuses both."""
    with pytest.raises(ValueError) as refusal:
        parse_flags({"head_count": raw})
    assert str(refusal.value) == f"shuf: invalid line count: '{raw}'"


@pytest.mark.parametrize("raw,count", [("05", 5), ("+5", 5), ("0", 0)])
def test_shuf_head_count_accepts_what_gnu_accepts(raw, count):
    """GNU reads a leading zero as decimal, `+5` as 5, and `0` as valid."""
    assert parse_flags({"head_count": raw}).count == count


@pytest.mark.parametrize("raw", ["-1", "-0"])
def test_shuf_head_count_refuses_a_leading_minus(raw):
    """To GNU shuf, `-` is an invalid character rather than a sign.

    It is rejected while scanning, so the message carries no
    `: Numerical result out of range` clause the way `nl -w` does.
    """
    with pytest.raises(ValueError) as refusal:
        parse_flags({"head_count": raw})
    assert str(refusal.value) == f"shuf: invalid line count: '{raw}'"


def test_shuf_head_count_zero_prints_nothing():
    """GNU `shuf -n 0` succeeds with zero bytes, not one bare separator."""
    ws, _ = _ws()
    stdout, io = _run_raw(ws, "shuf -e -n 0 a b c", cwd="/data")
    assert io.exit_code == 0
    assert _bytes(stdout) == b""


def test_shuf_head_count_one_still_works():
    ws, _ = _ws()
    stdout, io = _run_raw(ws, "shuf -e -n 1 a b c", cwd="/data")
    assert io.exit_code == 0
    assert len(_bytes(stdout).strip().decode().split("\n")) == 1


@pytest.mark.parametrize("raw", ["1-x", "x-3", "abc", "3-1", "-2-1", "1", ""])
def test_shuf_input_range_refusal_is_uniform(raw):
    """GNU answers every malformed `-i` with one message, quoting it whole.

    Non-numeric bounds, a decreasing range, a negative low bound, a
    missing dash and an empty value all read the same. shuf has no
    decreasing-range diagnostic of its own, so cut's is not borrowed.
    """
    with pytest.raises(ValueError) as refusal:
        asyncio.run(
            shuf([], [], read_bytes=_unused_read_bytes, input_range=raw))
    assert str(refusal.value) == f"shuf: invalid input range: '{raw}'"


def test_shuf_input_range_single_element_is_valid():
    """GNU `-i 2-2` is a one-element range, not a degenerate one."""
    rendered, io = asyncio.run(
        shuf([], [], read_bytes=_unused_read_bytes, input_range="2-2"))
    assert io.exit_code == 0
    assert rendered == b"2\n"


def test_shuf_input_range_stays_valid():
    rendered, io = asyncio.run(
        shuf([], [], read_bytes=_unused_read_bytes, input_range="1-3"))
    assert io.exit_code == 0
    assert sorted(rendered.decode().strip().split("\n")) == ["1", "2", "3"]


# A trailing newline in a value is refused, and this is the shape of bug
# only python has: `$` also matches immediately BEFORE a trailing
# newline, so `re.match(r"^\+?[0-9]+$", "2\n")` SUCCEEDS and read
# `shuf -n $'2\n'` as the valid count 2. GNU's scanner stops at the first
# non-digit and refuses both flags (ground truth NL2-A), as the
# TypeScript twin always did, so the fix is `fullmatch`. The value is
# rendered through gnulib `quote()`, so the newline is the two characters
# `\n` and not the byte (NL3-A).
@pytest.mark.parametrize("raw,quoted", [("2\n", "2\\n"), ("1\n2", "1\\n2"),
                                        ("0\n", "0\\n"), ("2\r", "2\\r"),
                                        ("2\x01", "2\\001")])
def test_shuf_head_count_refuses_a_trailing_newline(raw, quoted):
    with pytest.raises(ValueError) as refusal:
        parse_flags({"head_count": raw})
    assert str(refusal.value) == f"shuf: invalid line count: '{quoted}'"


@pytest.mark.parametrize("raw,quoted", [("1-3\n", "1-3\\n"),
                                        ("1-3\n5", "1-3\\n5"),
                                        ("2-2\n", "2-2\\n")])
def test_shuf_input_range_refuses_a_trailing_newline(raw, quoted):
    with pytest.raises(ValueError) as refusal:
        asyncio.run(
            shuf([], [], read_bytes=_unused_read_bytes, input_range=raw))
    assert str(refusal.value) == f"shuf: invalid input range: '{quoted}'"


@pytest.mark.parametrize("raw", ["2", "+2", "0"])
def test_shuf_head_count_without_a_newline_is_still_accepted(raw):
    """The control: the anchoring must not refuse a clean value."""
    assert parse_flags({"head_count": raw}) is not None


# LEADING C whitespace is SKIPPED, because that is `strtoumax`'s own
# skip, while trailing whitespace is garbage. `\s` would be wrong for the
# same reason as in nl: python calls 0x1c-0x1f whitespace and GNU does
# not. Ground truth NL3-C.
@pytest.mark.parametrize(
    "raw", [" 2", "\t2", "\n2", "\x0b2", "\f2", "\r2", "  2", " +2"])
def test_shuf_head_count_skips_leading_c_whitespace(raw):
    assert parse_flags({"head_count": raw}) is not None


@pytest.mark.parametrize("raw,quoted", [("2 ", "2 "), (" -2", " -2"),
                                        ("+ 2", "+ 2"), ("\x1c2", "\\0342")])
def test_shuf_head_count_refuses_the_rest_of_the_prefix(raw, quoted):
    """`-n` is unsigned, so ` -2` is refused where nl's `-v` accepts it."""
    with pytest.raises(ValueError) as refusal:
        parse_flags({"head_count": raw})
    assert str(refusal.value) == f"shuf: invalid line count: '{quoted}'"


# `-i` splits at the FIRST dash and scans each bound on its own, so a `+`
# and a leading blank ride on either bound independently. Every row
# measured against GNU (ground truth NL3-D).
@pytest.mark.parametrize("raw,bounds", [
    ("1-3", (1, 3)),
    ("+1-3", (1, 3)),
    ("1-+3", (1, 3)),
    ("+1-+3", (1, 3)),
    (" +1-3", (1, 3)),
    ("1- 3", (1, 3)),
    ("+0-0", (0, 0)),
    ("10-20", (10, 20)),
    ("2-2", (2, 2)),
    ("01-03", (1, 3)),
])
def test_shuf_input_range_accepts_a_bound_prefix(raw, bounds):
    assert parse_input_range(raw) == bounds


@pytest.mark.parametrize("raw", [
    "-1-3",
    "1--3",
    "++1-3",
    "1-2-3",
    "1-3-",
    " 1 - 3 ",
    "1 -3",
    "-",
    "1-",
    "-3",
    "3-1",
    "1-3\n",
    "abc",
    "1",
    "",
])
def test_shuf_input_range_refuses_every_other_shape(raw):
    """A `-` is never a sign, and shuf has one message for all of it."""
    assert parse_input_range(raw) is RangeRefusal.INVALID


def test_shuf_builder_returns_a_refusal_rather_than_raising():
    """Every sibling generic catches its own ValueError; shuf did not.

    Inside a workspace the executor's catch-all produced identical
    bytes, so this is invisible there -- but a direct call raised on
    python where the TypeScript `shufGeneric` returned an IOResult. The
    bytes and the exit code must not move.
    """
    ws, _ = _ws()
    for cmd, message in [
        ("shuf -n abc", b"shuf: invalid line count: 'abc'\n"),
        ("shuf -i 1-x", b"shuf: invalid input range: '1-x'\n"),
    ]:
        stdout, io = _run_raw(ws, cmd, stdin=b"a\n")
        assert io.exit_code == 1
        assert not _bytes(stdout)
        assert io.stderr == message


def test_shuf_no_write_op_is_not_swallowed_by_that_catch():
    """The one ValueError the builder must let through.

    A `-o` on a backend with no write op is a wiring fault, and the
    TypeScript twin throws a bare Error for it where it returns an
    IOResult for every user-facing refusal. Named as a constant so the
    catch and the raise cannot drift apart.
    """
    assert NO_WRITE_OP == "shuf: backend provides no write op"
    with pytest.raises(ValueError, match="backend provides no write op"):
        asyncio.run(
            shuf([], [],
                 read_bytes=_unused_read_bytes,
                 stdin=b"a\n",
                 output=PathSpec(resource_path="o.txt",
                                 virtual="/o.txt",
                                 directory="/",
                                 resolved=True),
                 write_bytes=None))


# `-i`'s bounds are `uintmax_t`, so UINTMAX_MAX is a legal bound and one past
# it earns gnulib's LONGINT_OVERFLOW clause. The SPAN has a second, different
# limit at SIZE_MAX and that one reads as the PLAIN message, the same one a
# decreasing range gets. Every row measured against GNU coreutils 9.4 (ground
# truth SH1, SH3, SH4).
@pytest.mark.parametrize("raw,bounds", [
    ("9007199254740992-9007199254740992", (2**53, 2**53)),
    ("9007199254740993-9007199254740993", (2**53 + 1, 2**53 + 1)),
    ("9223372036854775807-9223372036854775807", (2**63 - 1, 2**63 - 1)),
    ("9223372036854775808-9223372036854775808", (2**63, 2**63)),
    (f"{UINTMAX_MAX}-{UINTMAX_MAX}", (UINTMAX_MAX, UINTMAX_MAX)),
    (f"{UINTMAX_MAX - 1}-{UINTMAX_MAX}", (UINTMAX_MAX - 1, UINTMAX_MAX)),
    (f"0-{UINTMAX_MAX - 1}", (0, UINTMAX_MAX - 1)),
    (f"1-{UINTMAX_MAX}", (1, UINTMAX_MAX)),
])
def test_shuf_input_range_accepts_a_bound_up_to_uintmax_max(raw, bounds):
    assert parse_input_range(raw) == bounds


@pytest.mark.parametrize("raw", [
    "18446744073709551616-18446744073709551616",
    "1-18446744073709551616",
    "18446744073709551616-1",
    "18446744073709551616-x",
    "99999999999999999999-1",
    "+18446744073709551616-1",
    " 18446744073709551616-1",
    "99999999999999999999999999-99999999999999999999999999",
])
def test_shuf_input_range_overflow_earns_the_clause(raw):
    """A bound past UINTMAX_MAX is OVERFLOW, and the clause is EOVERFLOW's.

    Not ERANGE's `: Numerical result out of range`, which `nl -w` uses for
    a value outside an option's OWN range; `shuf -i` has no range below
    the C type's.
    """
    assert parse_input_range(raw) is RangeRefusal.OVERFLOW
    with pytest.raises(ValueError) as refusal:
        asyncio.run(
            shuf([], [], read_bytes=_unused_read_bytes, input_range=raw))
    assert str(refusal.value) == (f"shuf: invalid input range: '{raw}'"
                                  ": Value too large for defined data type")


def test_shuf_input_range_scans_left_to_right():
    """A bad LOW bound decides, whatever the high one is.

    So an overflowing low bound outranks a non-numeric high one, and a
    non-numeric low bound outranks an overflowing high one. Measured,
    ground truth SH4.
    """
    assert parse_input_range("18446744073709551616-x") is RangeRefusal.OVERFLOW
    assert parse_input_range("x-18446744073709551616") is RangeRefusal.INVALID


def test_shuf_input_range_span_limit_is_the_plain_message():
    """`hi - lo` must be strictly under SIZE_MAX, and that is INVALID.

    Exactly one argument trips it -- the one whose element count is
    2**64 -- and it carries NO clause, so it reads identically to
    `-i 3-1`. Measured, ground truth SH3.
    """
    raw = f"0-{SIZE_MAX}"
    assert parse_input_range(raw) is RangeRefusal.INVALID
    with pytest.raises(ValueError) as refusal:
        asyncio.run(
            shuf([], [], read_bytes=_unused_read_bytes, input_range=raw))
    assert str(refusal.value) == f"shuf: invalid input range: '{raw}'"
    assert parse_input_range(f"+0-{SIZE_MAX}") is RangeRefusal.INVALID
    assert parse_input_range(f"0-{SIZE_MAX - 1}") == (0, SIZE_MAX - 1)


def test_shuf_range_error_renders_the_clause_only_when_earned():
    assert range_error(
        "3-1", RangeRefusal.INVALID) == ("shuf: invalid input range: '3-1'")
    assert range_error(
        "1-3\n",
        RangeRefusal.INVALID) == ("shuf: invalid input range: '1-3\\n'")
    assert range_error("18446744073709551616-1", RangeRefusal.OVERFLOW) == (
        "shuf: invalid input range: '18446744073709551616-1'"
        ": Value too large for defined data type")


# The reviewed bug, and the one shape that proves the bounds are exact rather
# than merely wide: read as float64, `9007199254740992` (2**53) increments to
# itself so this never terminates, and `9007199254740993` parses to 2**53 and
# prints the WRONG integer with exit 0 (ground truth SH2). Both are
# one-element ranges, so the assertion is on the byte, and neither can hang
# the suite even if the fix regresses in some other direction.
@pytest.mark.parametrize("low", [
    2**53,
    2**53 + 1,
    2**63 - 1,
    2**63,
    UINTMAX_MAX,
])
def test_shuf_input_range_emits_a_large_bound_exactly(low):
    rendered, io = asyncio.run(
        shuf([], [], read_bytes=_unused_read_bytes,
             input_range=f"{low}-{low}"))
    assert io.exit_code == 0
    assert rendered == f"{low}\n".encode()


# GNU never builds the population when `-n` is below the element count, which
# is why `shuf -i 1-18446744073709551615 -n 3` answers instantly (ground truth
# SH5). Each case here names a range far too large to enumerate, so an
# implementation that enumerates fails by timing out rather than by assertion
# -- which is exactly the failure the reviewer reported.
@pytest.mark.parametrize("raw", [
    f"1-{UINTMAX_MAX}",
    "1-1000000000000",
    "1-100000000",
])
def test_shuf_samples_a_huge_range_without_enumerating_it(raw):
    rendered, io = asyncio.run(
        shuf([], [], read_bytes=_unused_read_bytes, input_range=raw, count=3))
    assert io.exit_code == 0
    low, high = parse_input_range(raw)
    values = [int(line) for line in rendered.decode().split("\n")[:-1]]
    assert len(values) == 3
    assert len(set(values)) == 3
    assert all(low <= value <= high for value in values)


def test_shuf_head_count_zero_on_a_huge_range_emits_nothing():
    """GNU answers `-n 0` instantly however large the range is."""
    rendered, io = asyncio.run(
        shuf([], [],
             read_bytes=_unused_read_bytes,
             input_range=f"1-{UINTMAX_MAX}",
             count=0))
    assert io.exit_code == 0
    assert rendered == b""


def test_shuf_repeat_draws_from_a_huge_range_without_enumerating_it():
    rendered, io = asyncio.run(
        shuf([], [],
             read_bytes=_unused_read_bytes,
             input_range=f"1-{UINTMAX_MAX}",
             count=4,
             with_replacement=True))
    assert io.exit_code == 0
    assert len(rendered.decode().split("\n")[:-1]) == 4


# A range GNU would enumerate given enough memory, and the wording is GNU's
# own `xalloc_die` line for exactly that situation (ground truth SH5). mirage
# renders one byte object rather than streaming, so the ceiling is stated
# rather than left to whatever the host survives.
@pytest.mark.parametrize("kwargs", [
    {
        "input_range": f"1-{UINTMAX_MAX}"
    },
    {
        "input_range": "1-1000000000000"
    },
    {
        "input_range": f"1-{MAX_OUTPUT_LINES + 1}"
    },
    {
        "input_range": f"1-{UINTMAX_MAX}",
        "with_replacement": True
    },
    {
        "input_range": "1-3",
        "count": MAX_OUTPUT_LINES + 1,
        "with_replacement": True
    },
])
def test_shuf_refuses_an_output_it_cannot_render(kwargs):
    with pytest.raises(ValueError) as refusal:
        asyncio.run(shuf([], [], read_bytes=_unused_read_bytes, **kwargs))
    assert str(refusal.value) == MEMORY_EXHAUSTED
    assert MEMORY_EXHAUSTED == "shuf: memory exhausted"


def test_shuf_repeat_with_a_huge_count_on_stdin_is_refused_too():
    """The same ceiling, reached through `-r -n` rather than through `-i`.

    Without `-r` a `-n` past the input's line count is just a head count
    and emits every line, which is why the second half exits 0.
    """
    with pytest.raises(ValueError) as refusal:
        asyncio.run(
            shuf([], [],
                 read_bytes=_unused_read_bytes,
                 stdin=b"a\n",
                 count=MAX_OUTPUT_LINES + 1,
                 with_replacement=True))
    assert str(refusal.value) == MEMORY_EXHAUSTED
    rendered, io = asyncio.run(
        shuf([], [],
             read_bytes=_unused_read_bytes,
             stdin=b"a\nb\n",
             count=MAX_OUTPUT_LINES + 1))
    assert io.exit_code == 0
    assert sorted(rendered.decode().split("\n")[:-1]) == ["a", "b"]


# `-n` past UINTMAX_MAX is CLAMPED to SIZE_MAX, never refused, which is the
# opposite of what the same overflow does to `-i`. The clamp is stated rather
# than left to the host's integers: python would carry the bignum and
# `Number.parseInt` answers `Infinity`, which is not a number either host can
# act on. Measured, ground truth SH6.
@pytest.mark.parametrize("raw", [
    str(UINTMAX_MAX),
    "18446744073709551616",
    "+18446744073709551616",
    "99999999999999999999999999",
    "9" * 400,
])
def test_shuf_head_count_past_uintmax_max_is_clamped_not_refused(raw):
    assert parse_flags({"head_count": raw}).count == SIZE_MAX


def test_shuf_head_count_below_the_clamp_is_kept_verbatim():
    assert parse_flags({"head_count": "2"}).count == 2
    assert parse_flags({"head_count": " +2"}).count == 2
    assert parse_flags({"head_count": "0"}).count == 0
    assert parse_flags({"head_count": str(SIZE_MAX - 1)}).count == SIZE_MAX - 1


# `emit_count` is what lets the range path sample rather than enumerate, so it
# is pinned on its own: `-r` emits exactly the count it was asked for however
# few values it draws from, while a head count cannot exceed what is there.
@pytest.mark.parametrize("available,count,repeat,expected", [
    (3, None, False, 3),
    (3, 5, False, 3),
    (3, 2, False, 2),
    (3, 0, False, 0),
    (3, None, True, 3),
    (3, 5, True, 5),
    (1, 7, True, 7),
    (0, 5, True, 0),
    (0, None, True, 0),
    (0, 5, False, 0),
    (2**64 - 1, 3, False, 3),
    (2**64 - 1, None, False, 2**64 - 1),
])
def test_shuf_emit_count_is_decided_before_anything_is_built(
        available, count, repeat, expected):
    assert emit_count(available, count, repeat) == expected


def test_shuf_memory_exhausted_is_a_refusal_the_builder_renders():
    """The builder turns it into one stderr line and exit 1, as GNU does."""
    ws, _ = _ws()
    stdout, io = _run_raw(ws, f"shuf -i 1-{UINTMAX_MAX}", stdin=b"a\n")
    assert io.exit_code == 1
    assert not _bytes(stdout)
    assert io.stderr == b"shuf: memory exhausted\n"


def test_shuf_input_range_overflow_reaches_the_shell_with_its_clause():
    ws, _ = _ws()
    stdout, io = _run_raw(ws, "shuf -i 1-18446744073709551616", stdin=b"a\n")
    assert io.exit_code == 1
    assert not _bytes(stdout)
    assert io.stderr == (b"shuf: invalid input range: '1-18446744073709551616'"
                         b": Value too large for defined data type\n")

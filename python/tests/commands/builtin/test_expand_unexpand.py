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

from mirage.commands.builtin.generic.expand import (TabStops, next_tab_stop,
                                                    parse_flags,
                                                    parse_tab_stops)
from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace


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


def test_expand_default_tab():
    ws, _ = _ws()
    stdout, _ = _run_raw(ws, "expand", stdin=b"a\tb")
    assert _bytes(stdout) == b"a       b"


def test_expand_t4():
    ws, _ = _ws()
    stdout, _ = _run_raw(ws, "expand -t 4", stdin=b"a\tb")
    assert _bytes(stdout) == b"a   b"


def test_unexpand_t4():
    ws, _ = _ws()
    stdout, _ = _run_raw(ws, "unexpand -a -t 4", stdin=b"    hello")
    assert _bytes(stdout) == b"\thello"


def test_expand_tab_size_quotes_only_the_bad_remainder():
    """GNU reports `--tabs=8x` as 'x', not as '8x'."""
    ws, _ = _ws()
    stdout, io = _run_raw(ws, "expand -t 8x", stdin=b"a\tb\n")
    assert io.exit_code == 1
    assert io.stderr == (
        b"expand: tab size contains invalid character(s): 'x'\n")
    assert not stdout


def test_expand_tab_size_with_no_digits_quotes_the_whole_argument():
    ws, _ = _ws()
    stdout, io = _run_raw(ws, "expand --tabs=abc", stdin=b"a\tb\n")
    assert io.exit_code == 1
    assert io.stderr == (
        b"expand: tab size contains invalid character(s): 'abc'\n")
    assert not stdout


@pytest.mark.parametrize("raw", ["1_0", "0x10", "1e3", "-4"])
def test_expand_tab_size_is_as_strict_as_gnu(raw):
    """GNU refuses what `int()` accepts.

    `_` is read whole by `int()`; GNU refuses it. `-` is not a sign to
    expand but the first invalid character, so `-4` is refused too.

    Surrounding BLANKS used to be in this list and are not: `isblank` is
    a tab-stop separator, so GNU reads `-t ' 5 '` as an empty element,
    5 and another empty element, and answers with tab size 5 (measured;
    ground truth NL2-D). The row below is that case, the right way up.
    """
    with pytest.raises(ValueError) as refusal:
        parse_flags({"tabs": raw})
    assert str(refusal.value).startswith(
        "expand: tab size contains invalid character(s): '")


@pytest.mark.parametrize("raw", [" 5 ", " 5", "5 ", "\t5\t"])
def test_expand_blanks_around_a_tab_size_are_separators(raw):
    """GNU accepts each of these and reads one stop at 5 (measured)."""
    ws, _ = _ws()
    stdout, io = _run_raw(ws, f"expand -t '{raw}'", stdin=b"a\tb")
    assert io.exit_code == 0
    assert io.stderr in (None, b"")
    assert _bytes(stdout) == b"a    b"


@pytest.mark.parametrize("raw,quoted", [("-4", "-4"), ("8x", "x"),
                                        ("abc", "abc"), ("+x", "x")])
def test_expand_quotes_from_the_first_unparseable_character(raw, quoted):
    """GNU quotes from where the scan stopped, not "after the digits".

    `8x` stops at `x` and quotes only it, while `-4` stops at position 0
    and quotes the whole argument. A leading `+` is consumed as a sign,
    so `+x` stops at `x`.
    """
    with pytest.raises(ValueError) as refusal:
        parse_flags({"tabs": raw})
    assert str(refusal.value) == (
        f"expand: tab size contains invalid character(s): '{quoted}'")


def test_expand_tab_size_accepts_a_leading_plus():
    """`+4` is not a sign: it is gnulib's INCREMENT specifier.

    A bare `+4` and a bare `4` coincide (an increment of 4 from column 0
    is the same sequence as a repeating size of 4), which is why round 2
    read `+` as a sign, but they are different parses -- `-t 2,+4` and
    `-t 2,4` render differently (ground truth NL2-E).
    """
    assert parse_flags({"tabs": "4"}).tabs == TabStops(stops=(4, ))
    assert parse_flags({"tabs": "+4"}).tabs == TabStops(increment=4)
    assert parse_flags({"tabs": "/4"}).tabs == TabStops(extend=4)


def test_expand_empty_tab_list_is_the_default_size():
    """`--tabs=''` is zero tab stops, which leaves GNU on its default 8."""
    assert parse_flags({"tabs": ""}).tabs == TabStops()
    ws, _ = _ws()
    stdout, io = _run_raw(ws, "expand -t ''", stdin=b"a\tb")
    assert io.exit_code == 0
    assert io.stderr in (None, b"")
    assert _bytes(stdout) == b"a       b"


def test_expand_tab_size_leading_zero_is_plain_decimal():
    """A control: a too-strict guard would refuse `04` too."""
    ws, _ = _ws()
    stdout, io = _run_raw(ws, "expand -t 04", stdin=b"a\tb")
    assert io.exit_code == 0
    assert _bytes(stdout) == b"a   b"


# GNU `expand -t` takes a LIST of tab stops, not one size. The tightened
# validation this fixes rejected every list as
# `tab size contains invalid character(s): ','`, which GNU accepts.
# Every expectation below is the od-verified stdout of the same line run
# against GNU coreutils 9.4 (ground truth NL2-D and NL2-E), and a
# differential harness ran 1548 more combinations of these lists against
# the real binary with no mismatch.
_ABCDE = b"a\tb\tc\td\te\n"
_EXPAND_LISTS = [
    # ONE stop repeats as a tab SIZE -- the rule that makes `-t 3` mean
    # 3, 6, 9 rather than one stop at 3 and single blanks after it.
    ("3", b"a  b  c  d  e\n"),
    ("4", b"a   b   c   d   e\n"),
    # SEVERAL stops are absolute columns, and past the last one a TAB is
    # exactly one blank, forever.
    ("1,3", b"a  b c d e\n"),
    ("2,5", b"a b  c d e\n"),
    ("10,20", b"a         b         c d e\n"),
    ("2,3", b"a b c d e\n"),
    ("1,2,3,4,5,6,7,8,9,10", b"a b c d e\n"),
    # An empty element is skipped in silence, wherever it sits.
    ("1,,3", b"a  b c d e\n"),
    ("1,3,", b"a  b c d e\n"),
    (",1,3", b"a  b c d e\n"),
    # `,` and isblank (space, TAB) all separate, and only those.
    ("2 4 6", b"a b c d e\n"),
    ("2\t4\t6", b"a b c d e\n"),
    (" 2 , 4 , 6 ", b"a b c d e\n"),
    # `/N` is the multiples of N; `+N` steps N from the last stop.
    ("/4", b"a   b   c   d   e\n"),
    ("+4", b"a   b   c   d   e\n"),
    ("2,/4", b"a b c   d   e\n"),
    ("2,+4", b"a b   c   d   e\n"),
    # A zero after either specifier leaves it unset rather than erroring.
    ("+0", b"a       b       c       d       e\n"),
    ("/0", b"a       b       c       d       e\n"),
    ("+0,1", b"a b c d e\n"),
    ("2,+0", b"a b c d e\n"),
]


@pytest.mark.parametrize("raw,rendered", _EXPAND_LISTS)
def test_expand_renders_a_tab_stop_list_as_gnu_does(raw, rendered):
    ws, _ = _ws()
    stdout, io = _run_raw(ws, f"expand -t '{raw}'", stdin=_ABCDE)
    assert io.exit_code == 0
    assert io.stderr in (None, b"")
    assert _bytes(stdout) == rendered


@pytest.mark.parametrize("stdin,raw,rendered", [
    (b"ab\tc\n", "2,5", b"ab   c\n"),
    (b"abcde\tf\n", "2,5", b"abcde f\n"),
    (b"xxxxxxxxx\tY\n", "5,9", b"xxxxxxxxx Y\n"),
    (b"abcd\tX\n", "/4", b"abcd    X\n"),
    (b"abc\tX\n", "/4", b"abc X\n"),
])
def test_expand_takes_the_first_stop_strictly_past_the_column(
        stdin, raw, rendered):
    """A TAB sitting exactly ON a stop takes the NEXT one.

    `/N` rounds up the same way, so column 4 under `/4` pads to 8 rather
    than staying put. Both directions measured.
    """
    ws, _ = _ws()
    stdout, io = _run_raw(ws, f"expand -t '{raw}'", stdin=stdin)
    assert io.exit_code == 0
    assert _bytes(stdout) == rendered


@pytest.mark.parametrize("stdin,raw,rendered", [
    (b"xxxxxxxxxx\tY\n", "5,9", b"xxxxxxxxxx Y\n"),
    (b"xxxxxxxxxx\tY\n", "5", b"xxxxxxxxxx     Y\n"),
])
def test_expand_one_stop_repeats_where_several_give_one_blank(
        stdin, raw, rendered):
    """The same column, the same first stop, opposite answers."""
    ws, _ = _ws()
    stdout, io = _run_raw(ws, f"expand -t '{raw}'", stdin=stdin)
    assert io.exit_code == 0
    assert _bytes(stdout) == rendered


# `-t` ACCUMULATES across occurrences: the stop list and the two
# specifier sizes outlive one occurrence while the per-scan state does
# not, which is what makes `-t '+4,2'` refuse and `-t +4 -t 2` not.
@pytest.mark.parametrize("argv,rendered", [
    ("-t 2,4 -t 6", b"a b c d e\n"),
    ("-t 2,4,6", b"a b c d e\n"),
    ("--tabs=2,4 --tabs=6", b"a b c d e\n"),
    ("-t +4 -t 2", b"a b   c   d   e\n"),
    ("-t 2 -t +4", b"a b   c   d   e\n"),
    ("-t 2 -t /4", b"a b c   d   e\n"),
    ("-t 4 -t ''", b"a   b   c   d   e\n"),
    ("-t '' -t 4", b"a   b   c   d   e\n"),
])
def test_expand_tab_stops_accumulate_across_occurrences(argv, rendered):
    ws, _ = _ws()
    stdout, io = _run_raw(ws, f"expand {argv}", stdin=_ABCDE)
    assert io.exit_code == 0
    assert io.stderr in (None, b"")
    assert _bytes(stdout) == rendered


# GNU's five tab-stop refusals. `tab size cannot be 0` and
# `tab sizes must be ascending` are both NEW here: `--tabs=0` was
# accepted by both hosts and then divided by zero's worth of nothing.
_EXPAND_REFUSALS = [
    ("0", "expand: tab size cannot be 0"),
    ("00", "expand: tab size cannot be 0"),
    ("0,0", "expand: tab size cannot be 0"),
    ("0,3", "expand: tab size cannot be 0"),
    ("3,0", "expand: tab size cannot be 0"),
    ("1,0", "expand: tab size cannot be 0"),
    ("1,2,0", "expand: tab size cannot be 0"),
    ("1,0,0", "expand: tab size cannot be 0"),
    ("0,+4", "expand: tab size cannot be 0"),
    ("3,1", "expand: tab sizes must be ascending"),
    ("3,3", "expand: tab sizes must be ascending"),
    ("2,2", "expand: tab sizes must be ascending"),
    ("1,1", "expand: tab sizes must be ascending"),
    ("1,3,2", "expand: tab sizes must be ascending"),
    # A list that breaks BOTH rules: the walk tests each element for zero
    # before it tests it for ascending, so element 1 speaks in `3,1,0`
    # and element 0 speaks in `3,0`.
    ("3,1,0", "expand: tab sizes must be ascending"),
    ("1,x", "expand: tab size contains invalid character(s): 'x'"),
    ("1,3x", "expand: tab size contains invalid character(s): 'x'"),
    ("1,-3", "expand: tab size contains invalid character(s): '-3'"),
    ("1;3", "expand: tab size contains invalid character(s): ';3'"),
    ("x,1", "expand: tab size contains invalid character(s): 'x,1'"),
    ("x,3,1", "expand: tab size contains invalid character(s): 'x,3,1'"),
    # A scan failure BREAKS the parse, so the zero and ascending walks
    # never run: `0,x` names the x although the zero came first.
    ("0,x", "expand: tab size contains invalid character(s): 'x'"),
    ("3,1,x", "expand: tab size contains invalid character(s): 'x'"),
    ("99999999999999999999",
     "expand: tab stop is too large '99999999999999999999'"),
    ("1,99999999999999999999",
     "expand: tab stop is too large '99999999999999999999'"),
    ("18446744073709551616",
     "expand: tab stop is too large '18446744073709551616'"),
    # An overflowing digit run does NOT break the parse, so a later
    # invalid character speaks too -- but it does suppress the walks.
    ("99999999999999999999,x",
     "expand: tab stop is too large '99999999999999999999'\n"
     "expand: tab size contains invalid character(s): 'x'"),
    ("1,99999999999999999999,0",
     "expand: tab stop is too large '99999999999999999999'"),
    ("+4,2", "expand: '+' specifier only allowed with the last value"),
    ("+4,0", "expand: '+' specifier only allowed with the last value"),
    ("+1,2", "expand: '+' specifier only allowed with the last value"),
    ("/4,2", "expand: '/' specifier only allowed with the last value"),
    ("/1,2", "expand: '/' specifier only allowed with the last value"),
    ("4+", "expand: '+' specifier not at start of number: '+'"),
    ("+4+5", "expand: '+' specifier not at start of number: '+5'"),
    ("/4+5", "expand: '+' specifier not at start of number: '+5'"),
    ("4/", "expand: '/' specifier not at start of number: '/'"),
    ("+4/5", "expand: '/' specifier not at start of number: '/5'"),
]


@pytest.mark.parametrize("raw,message", _EXPAND_REFUSALS)
def test_expand_refuses_a_tab_list_gnu_refuses(raw, message):
    with pytest.raises(ValueError) as refusal:
        parse_tab_stops([raw])
    assert str(refusal.value) == message


@pytest.mark.parametrize("raw,message", _EXPAND_REFUSALS)
def test_expand_tab_list_refusal_is_fatal_before_any_operand(raw, message):
    """Exit 1, empty stdout, and one line per problem with no hint."""
    ws, _ = _ws()
    stdout, io = _run_raw(ws, f"expand -t '{raw}'", stdin=b"a\tb\n")
    assert io.exit_code == 1
    assert not _bytes(stdout)
    assert io.stderr == f"{message}\n".encode()


@pytest.mark.parametrize("occurrences,message", [
    (["6", "2,4"], "expand: tab sizes must be ascending"),
    (["2,4", "1"], "expand: tab sizes must be ascending"),
    (["4", "4"], "expand: tab sizes must be ascending"),
    (["0", "4"], "expand: tab size cannot be 0"),
    (["4", "0"], "expand: tab size cannot be 0"),
    (["4", "x"], "expand: tab size contains invalid character(s): 'x'"),
    (["+4", "+5"], "expand: '+' specifier only allowed with the last value"),
    (["/4", "/5"], "expand: '/' specifier only allowed with the last value"),
])
def test_expand_refuses_across_occurrences(occurrences, message):
    """The accumulated state is what a second `-t` is checked against."""
    with pytest.raises(ValueError) as refusal:
        parse_tab_stops(occurrences)
    assert str(refusal.value) == message


@pytest.mark.parametrize("raw", ["", ",", ",,", " ", "+", "/"])
def test_expand_an_empty_list_leaves_the_default(raw):
    """No stop and neither specifier: GNU stays on 8."""
    assert parse_tab_stops([raw]) == TabStops()


# A newline is not `isblank` in C (that is space and TAB and nothing
# else), so it is an invalid character rather than a separator. The
# character scan gets this for free where the old `^\+?[0-9]+$` with
# `re.match` accepted it, because python's `$` also matches immediately
# BEFORE a trailing newline (ground truth NL2-A). The quoted remainder is
# rendered through gnulib `quote()`, so each of these is the escape's two
# characters and never the byte (NL3-A).
@pytest.mark.parametrize("raw,quoted", [("8\n", "\\n"), ("8\n4", "\\n4"),
                                        ("8\r", "\\r"), ("8\x0b", "\\v"),
                                        ("8\x0c", "\\f"), ("8\x07", "\\a"),
                                        ("8\x01", "\\001")])
def test_expand_refuses_a_non_blank_separator(raw, quoted):
    with pytest.raises(ValueError) as refusal:
        parse_tab_stops([raw])
    assert str(refusal.value) == (
        f"expand: tab size contains invalid character(s): '{quoted}'")


@pytest.mark.parametrize("raw", ["\u0663", "8\u0663"])
def test_expand_digits_are_ascii_only(raw):
    """GNU scans with `c_isdigit`; a unicode-aware test accepts U+0663.

    And the refusal names its BYTES: U+0663 is two of them, so it reads
    as two octal escapes rather than as the character (NL3-A).
    """
    with pytest.raises(ValueError) as refusal:
        parse_tab_stops([raw])
    assert str(refusal.value) == (
        "expand: tab size contains invalid character(s): '\\331\\243'")


# Only a NEWLINE resets the column. `str.expandtabs` treats a carriage
# return as a line break, so python padded `a\r\tb` by eight where GNU
# and the TypeScript twin pad by six (ground truth NL2-G).
@pytest.mark.parametrize("argv,stdin,rendered", [
    ("expand", b"a\r\tb\n", b"a\r      b\n"),
    ("expand -t 4", b"a\r\tb\n", b"a\r  b\n"),
    ("expand -t 1,3", b"a\r\tb\n", b"a\r b\n"),
    ("expand", b"ab\r\tX\n", b"ab\r     X\n"),
    ("expand", b"a\x0bb\tX\n", b"a\x0bb     X\n"),
    ("expand", b"a\x0cb\tX\n", b"a\x0cb     X\n"),
    ("expand -t 4", b"a\r\n\tb\n", b"a\r\n    b\n"),
])
def test_expand_resets_the_column_on_a_newline_alone(argv, stdin, rendered):
    ws, _ = _ws()
    stdout, io = _run_raw(ws, argv, stdin=stdin)
    assert io.exit_code == 0
    assert _bytes(stdout) == rendered


@pytest.mark.parametrize("tabs,column,expected", [
    (TabStops(), 0, 8),
    (TabStops(), 3, 8),
    (TabStops(), 8, 16),
    (TabStops(stops=(3, )), 0, 3),
    (TabStops(stops=(3, )), 3, 6),
    (TabStops(stops=(5, 9)), 0, 5),
    (TabStops(stops=(5, 9)), 5, 9),
    (TabStops(stops=(5, 9)), 9, 10),
    (TabStops(stops=(5, 9)), 20, 21),
    (TabStops(extend=4), 0, 4),
    (TabStops(extend=4), 4, 8),
    (TabStops(increment=4), 0, 4),
    (TabStops(increment=4), 5, 8),
    (TabStops(stops=(2, ), extend=4), 3, 4),
    (TabStops(stops=(2, ), extend=4), 5, 8),
    (TabStops(stops=(2, ), increment=4), 3, 6),
    (TabStops(stops=(2, ), increment=4), 7, 10),
])
def test_expand_next_tab_stop_is_always_strictly_greater(
        tabs, column, expected):
    assert next_tab_stop(tabs, column) == expected


@pytest.mark.parametrize("argv,stdin,rendered", [
    ("expand -i -t 1,3", b"\ta\tb\n", b" a\tb\n"),
    ("expand -i -t 4", b"\ta\tb\n", b"    a\tb\n"),
    ("expand -i -t 3", b"  \tx\n", b"   x\n"),
    ("expand -i -t 0", b"\ta\n", b""),
])
def test_expand_initial_only_reads_the_same_tab_list(argv, stdin, rendered):
    """`-i` changes WHERE the stops apply, never what they are."""
    ws, _ = _ws()
    stdout, io = _run_raw(ws, argv, stdin=stdin)
    assert _bytes(stdout) == rendered


# BACKSPACE decrements the column, floored at 0, where a carriage return
# advances it like any other byte. Both hosts had `\b` advancing, so
# every one of these padded one column too far. It composes with the
# tab-stop list rather than being a special case, which the `-t 1,3` and
# `-t 2,5` rows are here to show. All od-verified, ground truth NL3-E.
@pytest.mark.parametrize("stdin,argv,rendered", [
    (b"a\bb\tX\n", "expand", b"a\bb       X\n"),
    (b"a\bb\tX\n", "expand -t 4", b"a\bb   X\n"),
    (b"\b\tX\n", "expand", b"\b        X\n"),
    (b"\b\b\b\tX\n", "expand", b"\b\b\b        X\n"),
    (b"ab\b\tX\n", "expand", b"ab\b       X\n"),
    (b"abc\b\b\tX\n", "expand", b"abc\b\b       X\n"),
    (b"a\b\b\b\bb\tX\n", "expand", b"a\b\b\b\bb       X\n"),
    (b"\ba\tX\n", "expand -t 4", b"\ba   X\n"),
    (b"a\bb\tX\n", "expand -t 1,3", b"a\bb  X\n"),
    (b"\b\b\tX\n", "expand -t 2,5", b"\b\b  X\n"),
])
def test_expand_backspace_decrements_the_column(stdin, argv, rendered):
    ws, _ = _ws()
    stdout, io = _run_raw(ws, argv, stdin=stdin)
    assert io.exit_code == 0
    assert _bytes(stdout) == rendered


def test_expand_backspace_ends_the_leading_run_under_initial_only():
    """`-i` needs no backspace handling: `\\b` is not `isblank`.

    So the leading run stops at it and the TAB after is copied
    verbatim, which is what GNU does (NL3-E).
    """
    ws, _ = _ws()
    stdout, io = _run_raw(ws, "expand -i -t 4", stdin=b"  \b \tx\n")
    assert io.exit_code == 0
    assert _bytes(stdout) == b"  \b \tx\n"


# A misplaced `/` or `+` is REPORTED AND THEN THE SCAN CONTINUES, where an
# invalid character breaks it. Round 8 returned on both, so `-t 4+5+6`
# printed one line where GNU prints two and `-t 4+x` printed one where GNU
# prints the misplaced line and then the invalid-character one. Measured,
# ground truth NL3-A's slot table and the probe behind it.
@pytest.mark.parametrize("raw,message", [
    ("4+", "expand: '+' specifier not at start of number: '+'"),
    ("4+5", "expand: '+' specifier not at start of number: '+5'"),
    ("4+x", "expand: '+' specifier not at start of number: '+x'\n"
     "expand: tab size contains invalid character(s): 'x'"),
    ("4/x", "expand: '/' specifier not at start of number: '/x'\n"
     "expand: tab size contains invalid character(s): 'x'"),
    ("4+,x", "expand: '+' specifier not at start of number: '+,x'\n"
     "expand: tab size contains invalid character(s): 'x'"),
    ("4+5+6", "expand: '+' specifier not at start of number: '+5+6'\n"
     "expand: '+' specifier not at start of number: '+6'"),
    ("1,2+x", "expand: '+' specifier not at start of number: '+x'\n"
     "expand: tab size contains invalid character(s): 'x'"),
    ("+4+5", "expand: '+' specifier not at start of number: '+5'"),
    ("+4/5", "expand: '/' specifier not at start of number: '/5'"),
])
def test_expand_a_misplaced_specifier_does_not_end_the_scan(raw, message):
    with pytest.raises(ValueError) as refusal:
        parse_tab_stops([raw])
    assert str(refusal.value) == message


@pytest.mark.parametrize("raw,message", [
    ("x+", "expand: tab size contains invalid character(s): 'x+'"),
    ("x/", "expand: tab size contains invalid character(s): 'x/'"),
    ("x,3,1", "expand: tab size contains invalid character(s): 'x,3,1'"),
    ("1,x,0", "expand: tab size contains invalid character(s): 'x,0'"),
    ("1;3;5", "expand: tab size contains invalid character(s): ';3;5'"),
    ("x0", "expand: tab size contains invalid character(s): 'x0'"),
])
def test_expand_an_invalid_character_does_end_the_scan(raw, message):
    """The other direction: one line, and nothing to its right is read."""
    with pytest.raises(ValueError) as refusal:
        parse_tab_stops([raw])
    assert str(refusal.value) == message

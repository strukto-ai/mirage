import re

from mirage.commands.builtin.grep_context import grep_context_lines
from mirage.commands.builtin.grep_offsets import decode_line

# one\ntwo abc\nthree\nfour\nfive abc\nsix\n, the fixture every row below
# was measured against on GNU grep 3.11 under LC_ALL=C.
LINES = ["one", "two abc", "three", "four", "five abc", "six"]
ABC = re.compile("abc")


def _render(lines, pat=ABC, **kw):
    return grep_context_lines(lines, pat, kw.get("invert", False),
                              kw.get("line_numbers", False),
                              kw.get("max_count"), kw.get("after_context", 0),
                              kw.get("before_context", 0),
                              kw.get("byte_offsets", False))


class TestMaxCountZeroSelectsNothing:
    """`-m 0` selects no line, so there is nothing to group or print.

    Measured: `grep -m0 -A1 abc f` and `grep -m0 -B1 -c abc f` are both
    zero bytes and exit 1 on GNU grep 3.11. Reading the limit after the
    match was recorded kept the first one, because `len(...) >= 0` is
    already true -- python's falsy test skipped the check entirely and
    rendered every match, and the TypeScript twin's `!== null` kept
    exactly one, so the two hosts were wrong in different directions.
    """

    def test_no_context_lines_at_all(self):
        assert _render(LINES, max_count=0, after_context=1,
                       before_context=1) == []

    def test_not_even_the_selected_line(self):
        assert _render(LINES, max_count=0) == []

    def test_inverted_selection_prints_nothing_either(self):
        assert _render(LINES, max_count=0, invert=True, after_context=1) == []


class TestMaxCountStopsAtTheNthSelectedLine:

    def test_one_match_with_context_on_both_sides(self):
        # `grep -m1 -n -A1 -B1 abc f`
        assert _render(
            LINES,
            max_count=1,
            line_numbers=True,
            after_context=1,
            before_context=1) == [b"1-one\n", b"2:two abc\n", b"3-three\n"]

    def test_no_limit_renders_both_groups(self):
        # `grep -n -A1 -B1 abc f` -- the two windows touch, so GNU emits no
        # `--` between them.
        assert _render(LINES,
                       line_numbers=True,
                       after_context=1,
                       before_context=1) == [
                           b"1-one\n", b"2:two abc\n", b"3-three\n",
                           b"4-four\n", b"5:five abc\n", b"6-six\n"
                       ]


class TestSeparatorAndFields:

    def test_a_gap_between_groups_takes_the_dash_separator(self):
        # `grep -b -A1 abc f`: the two windows do not touch, so GNU puts a
        # bare `--` between them, carrying no fields of its own.
        assert _render(LINES, after_context=1, byte_offsets=True) == [
            b"4:two abc\n", b"12-three\n", b"--\n", b"23:five abc\n",
            b"32-six\n"
        ]

    def test_a_context_line_renders_every_field_with_a_dash(self):
        # `grep -bn -A1 -B1 abc f`
        assert _render(LINES,
                       line_numbers=True,
                       after_context=1,
                       before_context=1,
                       byte_offsets=True) == [
                           b"1-0-one\n", b"2:4:two abc\n", b"3-12-three\n",
                           b"4-18-four\n", b"5:23:five abc\n", b"6-32-six\n"
                       ]

    def test_invert_moves_which_lines_are_selected(self):
        # `grep -nv -A1 abc f`
        assert _render(LINES, invert=True, line_numbers=True,
                       after_context=1) == [
                           b"1:one\n", b"2-two abc\n", b"3:three\n",
                           b"4:four\n", b"5-five abc\n", b"6:six\n"
                       ]


class TestOffsetsOverASmuggledByte:
    """A byte offset counts bytes, and an invalid byte is one byte.

    Fixture `one\\n\\377\\ntwo abc\\nthree\\n`, measured on GNU grep 3.11:
    `grep -b -A1 abc` is `6:two abc` then `14-three`, `grep -b -B1 abc` is
    `4-\\377` then `6:two abc`, and `grep -bn -A1 -B1 abc` is `2-4-\\377`,
    `3:6:two abc`, `4-14-three`. A replacing decode read `\\377` as U+FFFD,
    three bytes wide, so every offset past it ran ahead -- line three
    reported 8 rather than 6.
    """

    @staticmethod
    def _bin_lines():
        return ["one", decode_line(b"\xff"), "two abc", "three"]

    def test_after_context_offsets_count_one_byte(self):
        assert _render(self._bin_lines(), after_context=1,
                       byte_offsets=True) == [b"6:two abc\n", b"14-three\n"]

    def test_before_context_prints_the_raw_byte_back(self):
        # The renderer puts the line back with `encode_line`, so the byte
        # prints as GNU prints it rather than as U+FFFD. This is what
        # `grep -a -b -B1` renders end to end.
        assert _render(self._bin_lines(), before_context=1,
                       byte_offsets=True) == [b"4-\xff\n", b"6:two abc\n"]

    def test_every_field_is_right_on_both_sides(self):
        assert _render(self._bin_lines(),
                       line_numbers=True,
                       after_context=1,
                       before_context=1,
                       byte_offsets=True) == [
                           b"2-4-\xff\n", b"3:6:two abc\n", b"4-14-three\n"
                       ]

    def test_a_multibyte_character_counts_its_bytes(self):
        # `caf` + U+00E9 is five bytes, so the second line starts at 10 once
        # the space and terminator are counted (section Q6's fixture).
        assert _render(["café abc", "xéy abc"],
                       after_context=1,
                       byte_offsets=True) == [
                           b"0:caf\xc3\xa9 abc\n", b"10:x\xc3\xa9y abc\n"
                       ]


def test_no_match_renders_nothing():
    assert _render(LINES, re.compile("zzz"), after_context=1) == []

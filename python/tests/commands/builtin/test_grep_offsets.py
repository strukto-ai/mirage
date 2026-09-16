from mirage.commands.builtin.grep_offsets import (decode_line, encode_line,
                                                  line_offsets, match_offset,
                                                  prefix_of, printable)


def test_line_offsets_count_the_stripped_terminator():
    # abc\ndefabc\nabc abc\n -- section Q1 of the GNU truth file.
    assert line_offsets(["abc", "defabc", "abc abc"]) == [0, 4, 11]


def test_line_offsets_count_bytes_not_characters():
    # `caf` + U+00E9 (two bytes) + a space is six bytes, so line two starts
    # at 10 rather than at the character index 9.
    assert line_offsets(["café abc", "xéy abc"]) == [0, 10]


def test_line_offsets_do_not_read_past_the_last_line():
    # A file with no final newline still reports 0 for its one line; the
    # extra byte the accumulator adds is never read.
    assert line_offsets(["no-newline-abc"]) == [0]


def test_line_offsets_of_no_lines_is_empty():
    assert line_offsets([]) == []


def test_match_offset_adds_the_line_start_in_bytes():
    assert match_offset(10, "xéy abc", 4) == 15


def test_match_offset_at_the_start_of_a_line_is_the_line_start():
    assert match_offset(11, "abc abc", 0) == 11


def test_prefix_of_puts_the_line_number_before_the_byte_offset():
    assert prefix_of(2, 4) == "2:4:"


def test_prefix_of_omits_a_field_that_is_off():
    assert (prefix_of(2, None), prefix_of(None, 4)) == ("2:", "4:")


def test_prefix_of_is_empty_when_neither_flag_is_set():
    assert prefix_of(None, None) == ""


def test_prefix_of_renders_a_context_line_with_dashes_throughout():
    assert prefix_of(3, 12, False) == "3-12-"


def test_decode_line_carries_one_invalid_byte_as_one_character():
    # A replacing decode reads 0xff as U+FFFD, which is three bytes wide,
    # so every offset past it ran ahead of GNU's.
    assert decode_line(b"\xffa") == "\udcffa"


def test_decode_line_leaves_valid_utf8_alone():
    assert decode_line("café abc".encode()) == "café abc"


def test_encode_line_round_trips_decode_line():
    raw = b"\xffa\xc3\xa9\xfe"
    assert encode_line(decode_line(raw)) == raw


def test_line_offsets_are_exact_over_an_invalid_byte():
    # `\xff` is one byte, so the second line starts at 2 -- GNU's answer for
    # `grep -b a` over `\xff\na\n`, where a replacing decode said 4.
    assert line_offsets([decode_line(b"\xff"), "a"]) == [0, 2]


def test_match_offset_counts_an_invalid_byte_as_one():
    # `grep -bo a` over `\xffa\n` is `1:a` on GNU grep 3.11.
    assert match_offset(0, decode_line(b"\xffa"), 1) == 1


def test_printable_replaces_a_smuggled_byte():
    assert printable(decode_line(b"\xffa")) == "\ufffda"


def test_printable_gives_up_exactly_what_a_replacing_decode_gives_up():
    # A truncated multi-byte sequence is one maximal invalid subsequence, so
    # it comes back as one U+FFFD rather than one per byte.
    raw = b"\xe2\x82x"
    assert printable(decode_line(raw)) == raw.decode(errors="replace")


def test_printable_leaves_ordinary_text_alone():
    assert printable("café abc") == "café abc"

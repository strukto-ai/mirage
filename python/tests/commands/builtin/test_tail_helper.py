from mirage.commands.builtin.tail_helper import number_flag_error, parse_counts


def test_bare_count_counts_back_from_the_end():
    counts = parse_counts("3", None)
    assert counts.lines == 3
    assert counts.from_line is None


def test_leading_plus_counts_forward_for_lines():
    counts = parse_counts("+3", None)
    assert counts.from_line == 3
    assert counts.lines is None


def test_leading_plus_counts_forward_for_bytes():
    """GNU `tail -c +3` starts at byte 3; taking abs() gave the LAST three."""
    counts = parse_counts(None, "+3")
    assert counts.from_byte == 3
    assert counts.byte_count is None


def test_negative_bytes_still_count_back_from_the_end():
    counts = parse_counts(None, "-3")
    assert counts.byte_count == -3
    assert counts.from_byte is None


def test_unset_flags_stay_none_so_the_generic_picks_its_default():
    counts = parse_counts(None, None)
    assert counts == parse_counts(None, None)
    assert (counts.lines, counts.from_line, counts.byte_count,
            counts.from_byte) == (None, None, None, None)


def test_both_flags_are_parsed_independently():
    counts = parse_counts("+2", "5")
    assert counts.from_line == 2
    assert counts.byte_count == 5


class TestNumberFlagError:

    def test_valid_numbers_pass(self):
        assert number_flag_error("head", "5", None) is None
        assert number_flag_error("tail", "+3", None) is None
        assert number_flag_error("head", None, "-2") is None

    def test_invalid_lines(self):
        assert number_flag_error(
            "head", "abc", None) == "head: invalid number of lines: 'abc'\n"

    def test_invalid_bytes(self):
        assert number_flag_error(
            "tail", None, "xyz") == "tail: invalid number of bytes: 'xyz'\n"

    def test_unicode_digits_are_invalid(self):
        # python's \d also matches Unicode digits (int('١٢') is 12), which
        # JS /\d/ and GNU's C-locale parsers reject.
        assert number_flag_error(
            "head", "١٢", None) == "head: invalid number of lines: '١٢'\n"
        assert number_flag_error("tail", None,
                                 "٥") == "tail: invalid number of bytes: '٥'\n"

from mirage.commands.builtin.grep_offsets import prefix_of


def test_prefix_of_puts_the_line_number_before_the_byte_offset():
    assert prefix_of(2, 4) == "2:4:"


def test_prefix_of_omits_a_field_that_is_off():
    assert (prefix_of(2, None), prefix_of(None, 4)) == ("2:", "4:")


def test_prefix_of_is_empty_when_neither_flag_is_set():
    assert prefix_of(None, None) == ""


def test_prefix_of_renders_a_context_line_with_dashes_throughout():
    assert prefix_of(3, 12, False) == "3-12-"

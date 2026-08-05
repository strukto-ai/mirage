from mirage.shell.bytes import byte_char, encode_text


def test_ascii_bytes_stand_for_themselves():
    assert byte_char(0x41) == "A"
    assert byte_char(0x00) == "\0"
    assert encode_text(byte_char(0x41)) == b"A"


def test_a_byte_above_ascii_round_trips():
    assert encode_text(byte_char(0xFF)) == b"\xff"
    assert encode_text(byte_char(0xC3) + byte_char(0xA9)) == b"\xc3\xa9"


def test_ordinary_text_still_encodes_as_utf8():
    assert encode_text("café\n") == "café\n".encode()


def test_bytes_and_text_mix():
    assert encode_text("a" + byte_char(0xFF) + "b") == b"a\xffb"


def test_three_octal_digits_past_a_byte_keep_the_low_byte():
    # bash writes \400 as 0x00 and \777 as 0xff.
    assert encode_text(byte_char(0o400)) == b"\x00"
    assert encode_text(byte_char(0o777)) == b"\xff"


def test_a_non_bmp_character_is_not_a_byte():
    assert encode_text("\U00010080") == "\U00010080".encode()
    assert encode_text("a\U00010080" +
                       byte_char(0xFF)) == "a\U00010080".encode() + b"\xff"

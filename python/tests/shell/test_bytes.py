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

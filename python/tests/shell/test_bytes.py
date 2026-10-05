import pytest

from mirage.shell.bytes import (
    byte_char,
    byte_view,
    decode_text,
    encode_text,
    from_byte_view,
    text_view,
    utf8_locale,
)


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
    assert (
        encode_text("a\U00010080" + byte_char(0xFF))
        == "a\U00010080".encode() + b"\xff"
    )


def test_decode_text_round_trips_every_byte():
    # A replacing decode reads 0xff as U+FFFD, three bytes wide, so every
    # offset counted back past it ran ahead of GNU's.
    assert decode_text(b"\xffa") == "\udcffa"
    assert decode_text("café abc".encode()) == "café abc"
    raw = b"\xffa\xc3\xa9\xfe"
    assert encode_text(decode_text(raw)) == raw


@pytest.mark.parametrize(
    "raw,expected",
    [
        (b"\xef\xbb\xbfa", "\ufeffa"),
        (b"\xc0\xaf\xc1\xbf", "\udcc0\udcaf\udcc1\udcbf"),
        (b"\xe0\x80\x80\xed\xa0\x80", "\udce0\udc80\udc80\udced\udca0\udc80"),
        (b"\xf0\x80\x80\x80", "\udcf0\udc80\udc80\udc80"),
        (b"\xf4\x90\x80\x80\xf5\xff", "\udcf4\udc90\udc80\udc80\udcf5\udcff"),
        (
            b"\xc2A\xe1\x80B\xf0\x90\x80",
            "\udcc2A\udce1\udc80B\udcf0\udc90\udc80",
        ),
        (
            b"\xef\xbb\xbf\xff\xc2\x80\xe0\xa0\x80\xed\x9f\xbf\xf0\x90\x82\x80\xf4\x8f\xbf\xbf",
            "\ufeff\udcff\u0080\u0800\ud7ff𐂀\U0010ffff",
        ),
    ],
)
def test_decode_utf8_boundaries_without_replacing_bytes(raw, expected):
    assert decode_text(raw) == expected
    assert encode_text(decode_text(raw)) == raw


def test_decode_large_malformed_line():
    expected = ("x" * 8190 + "𐂀\udcffé") * 4
    assert decode_text(encode_text(expected)) == expected


def test_every_byte_round_trips_through_text_and_byte_views():
    raw = bytes(range(256))
    assert from_byte_view(byte_view(raw)) == raw
    assert encode_text(decode_text(raw)) == raw
    assert from_byte_view(byte_view(decode_text(raw))) == raw


def test_literal_text_and_byte_escapes_have_the_same_byte_view():
    for literal in ("é", "€", "😀", "\ufeff", "\U00010080"):
        raw = literal.encode()
        escaped = "".join(byte_char(value) for value in raw)
        assert byte_view(literal) == byte_view(escaped) == byte_view(raw)
        assert text_view(byte_view(escaped)) == literal
        assert from_byte_view(byte_view(literal)[1:]) == raw[1:]


def test_invalid_utf8_is_never_replaced():
    for raw in (
        b"\xc0\xaf",
        b"\xed\xa0\x80",
        b"\xf4\x90\x80\x80",
        b"\xe2\x82",
    ):
        assert encode_text(decode_text(raw)) == raw
        assert encode_text(text_view(byte_view(raw))) == raw


@pytest.mark.parametrize(
    "env,expected",
    [
        (None, False),
        ({}, False),
        ({"LANG": "C.UTF-8"}, True),
        ({"LANG": "C.UTF-8", "LC_ALL": "C"}, False),
        ({"LANG": "C.UTF-8", "LC_ALL": ""}, True),
        ({"LANG": "C", "LC_CTYPE": "en_US.utf8"}, True),
        ({"LC_CTYPE": "C.UTF-8", "LC_ALL": "POSIX"}, False),
        ({"LC_ALL": "de_DE.UTF-8@euro"}, True),
        ({"LC_ALL": "en_US.ISO-8859-1"}, False),
        ({"LC_ALL": "UTF-8"}, False),
    ],
)
def test_utf8_locale_follows_setlocale_precedence(env, expected):
    assert utf8_locale(env) is expected


def test_a_utf8_view_is_the_text_itself():
    raw = "规定é".encode() + b"\xff"
    view = byte_view(raw, True)
    assert view == "规定é\udcff"
    assert len(view) == 4
    assert byte_view("规定", True) == "规定"
    assert from_byte_view(view, True) == raw
    assert text_view(view, True) == view
    assert len(byte_view(raw)) == len(raw)

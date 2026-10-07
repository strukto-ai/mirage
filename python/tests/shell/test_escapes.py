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

import pytest

from mirage.shell.bytes import encode_text
from mirage.shell.escapes import code_point_text, decode_ansi_c

# Expectations pinned against bash 5.2.37 in docker (debian:stable-slim,
# LC_ALL=C.UTF-8): echo $'<case>' | od -An -tx1.


@pytest.mark.parametrize(
    "content,expected",
    [
        (r"a\nb", "a\nb"),
        (r"\a\b\f\r\t\v", "\a\b\f\r\t\v"),
        (r"\e\E", "\x1b\x1b"),
        (r"\\", "\\"),
        (r"\'\"\?", "'\"?"),
        ("plain", "plain"),
        ("", ""),
    ],
)
def test_simple_escapes(content: str, expected: str):
    assert decode_ansi_c(content) == expected


@pytest.mark.parametrize(
    "content,expected",
    [
        (r"\x41", "A"),
        (r"\x9", "\t"),
        (r"\x413", "A3"),
        (r"\101", "A"),
        (r"\1013", "A3"),
        (r"\0101", "\b1"),
        (r"\u41", "A"),
        (r"中", "中"),
        (r"\U0001F600", "\U0001f600"),
    ],
)
def test_numeric_escapes(content: str, expected: str):
    assert decode_ansi_c(content) == expected


@pytest.mark.parametrize(
    "content,expected",
    [
        (r"\cA", "\x01"),
        (r"\cz", "\x1a"),
        (r"\c[", "\x1b"),
        (r"\c?", "\x7f"),
    ],
)
def test_control_escapes(content: str, expected: str):
    assert decode_ansi_c(content) == expected


def test_control_escape_consumes_an_escaped_backslash_operand():
    # \c\\ is ctrl-backslash and both characters belong to the operand;
    # \c\n is ctrl-backslash followed by a literal n (bash 5.2).
    assert decode_ansi_c("\\c\\\\") == "\x1c"
    assert decode_ansi_c("\\c\\n") == "\x1cn"


@pytest.mark.parametrize("content", [r"\q", r"\x", r"\u", r"\U", r"\c", r"\8"])
def test_unknown_or_incomplete_escapes_stay_verbatim(content: str):
    assert decode_ansi_c(content) == content


def test_trailing_backslash_stays_verbatim():
    assert decode_ansi_c("a\\") == "a\\"


def test_backslash_newline_is_not_a_continuation():
    assert decode_ansi_c("\\\nx") == "\\\nx"


@pytest.mark.parametrize(
    "content,expected",
    [
        (r"a\0b", "a"),
        (r"a\x00b", "a"),
        (r"a\u0000b", "a"),
        (r"a\c@b", "a"),
        (r"a\400b", "a"),
    ],
)
def test_nul_truncates_the_segment(content: str, expected: str):
    assert decode_ansi_c(content) == expected


def test_high_bytes_ride_the_surrogate_escape():
    assert encode_text(decode_ansi_c(r"\xff")) == b"\xff"
    assert encode_text(decode_ansi_c(r"\777")) == b"\xff"
    # Three hex byte escapes reassemble into one UTF-8 character.
    assert encode_text(decode_ansi_c(r"\xe4\xb8\xad")) == "中".encode()


def test_surrogate_halves_encode_like_a_utf8_locale():
    # bash 5.2 (docker, LC_ALL=C.UTF-8 at startup) UTF-8-encodes \u/\U
    # values, so a surrogate half comes out as its raw three-byte
    # form; U+E000, one past the range, is an ordinary character.
    assert encode_text(decode_ansi_c(r"\uD800")) == b"\xed\xa0\x80"
    assert encode_text(decode_ansi_c(r"\udbff")) == b"\xed\xaf\xbf"
    assert encode_text(decode_ansi_c(r"\U0000DFFF")) == b"\xed\xbf\xbf"
    assert decode_ansi_c(r"\ue000") == "\ue000"


def test_values_past_unicode_encode_or_vanish():
    # bash keeps the old-style four- to six-byte forms alive past
    # Unicode, and 0x80000000 and past produce nothing - without
    # truncating the rest of the segment the way NUL does.
    assert encode_text(decode_ansi_c(r"\U00110000")) == b"\xf4\x90\x80\x80"
    assert (
        encode_text(decode_ansi_c(r"\U7FFFFFFF"))
        == b"\xfd\xbf\xbf\xbf\xbf\xbf"
    )
    assert decode_ansi_c(r"x\UFFFFFFFFy") == "xy"
    assert decode_ansi_c(r"x\U80000000y") == "xy"


@pytest.mark.parametrize(
    "value,expected",
    [
        (0x41, b"A"),
        (0, b"\0"),
        (0xE9, b"\xc3\xa9"),
        (0x1F600, b"\xf0\x9f\x98\x80"),
        (0xD800, b"\xed\xa0\x80"),
        (0x110000, b"\xf4\x90\x80\x80"),
        (0x7FFFFFFF, b"\xfd\xbf\xbf\xbf\xbf\xbf"),
        (0x80000000, b""),
    ],
)
def test_code_point_text_utf8_encodes_like_bash(value: int, expected: bytes):
    # $'...', echo -e and printf all write \u and \U through this; only
    # $'...' cuts at NUL, before it gets here.
    assert encode_text(code_point_text(value)) == expected

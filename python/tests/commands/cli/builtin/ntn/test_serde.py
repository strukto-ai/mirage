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

from mirage.commands.cli.builtin.ntn.serde import serde_message

# Every row is the real ntn 0.21.9's own message for `ntn api v1/search
# a:=<input>`, read off the binary. serde_json is the authority here, not
# python's json: the two disagree on what is valid and never agree on the
# wording, and this text is compared byte for byte by the conformance
# harness.
PROBED = [
    ("{", "EOF while parsing an object at line 1 column 1"),
    ("[", "EOF while parsing a list at line 1 column 1"),
    ('"', "EOF while parsing a string at line 1 column 1"),
    ("", "EOF while parsing a value at line 1 column 0"),
    ("  ", "EOF while parsing a value at line 1 column 2"),
    ("tru", "EOF while parsing a value at line 1 column 3"),
    ("tru3", "expected ident at line 1 column 4"),
    ("truex", "trailing characters at line 1 column 5"),
    ('{"a"}', "expected `:` at line 1 column 5"),
    ('{"a" 1}', "expected `:` at line 1 column 6"),
    ('{"a":}', "expected value at line 1 column 6"),
    ('{"a":1 "b":2}', "expected `,` or `}` at line 1 column 8"),
    ("[1 2]", "expected `,` or `]` at line 1 column 4"),
    ("[1,]", "trailing comma at line 1 column 4"),
    ('{"a":1,}', "trailing comma at line 1 column 8"),
    ("{,}", "key must be a string at line 1 column 2"),
    ("{a:1}", "key must be a string at line 1 column 2"),
    ("}", "expected value at line 1 column 1"),
    ("[[", "EOF while parsing a list at line 1 column 2"),
    ("1 2", "trailing characters at line 1 column 3"),
    ('{"a":1}x', "trailing characters at line 1 column 8"),
    ("0x1", "trailing characters at line 1 column 2"),
    ("0.0.0", "trailing characters at line 1 column 4"),
    ("01", "invalid number at line 1 column 2"),
    ("00", "invalid number at line 1 column 2"),
    ("-x", "invalid number at line 1 column 2"),
    ("-Infinity", "invalid number at line 1 column 2"),
    ("1.e5", "invalid number at line 1 column 3"),
    ("-", "EOF while parsing a value at line 1 column 1"),
    ("1.", "EOF while parsing a value at line 1 column 2"),
    ("1e", "EOF while parsing a value at line 1 column 2"),
    ("1e+", "EOF while parsing a value at line 1 column 3"),
    ("1e999", "number out of range at line 1 column 5"),
    ("-1e999", "number out of range at line 1 column 6"),
    ("[1e999]", "number out of range at line 1 column 6"),
    (".5", "expected value at line 1 column 1"),
    ("+1", "expected value at line 1 column 1"),
    ("NaN", "expected value at line 1 column 1"),
    ("Infinity", "expected value at line 1 column 1"),
    ('"\\q"', "invalid escape at line 1 column 3"),
    ('"\\uZZZZ"', "invalid escape at line 1 column 7"),
    ('"\\u12"', "EOF while parsing a string at line 1 column 6"),
    ('"\\u00"', "EOF while parsing a string at line 1 column 6"),
    ('"\\u', "EOF while parsing a string at line 1 column 3"),
    ('"\\', "EOF while parsing a string at line 1 column 2"),
    ('"\\ud800"', "unexpected end of hex escape at line 1 column 8"),
    ("[1,", "EOF while parsing a value at line 1 column 3"),
    ('{"a":1,', "EOF while parsing a value at line 1 column 7"),
    ('{"a"', "EOF while parsing an object at line 1 column 4"),
    ('{"a":1', "EOF while parsing an object at line 1 column 6"),
]

VALID = [
    "{}", "[]", "0", "-0", "1.5", "1e5", "1E5", "1e-5", "true", "false",
    "null", '""', '"ok"', '"\\n"', '"é"', "[[]]", '{"a":{"b":{}}}',
    '{"a":1}  ', "123456789012345678901234567890", '"\\ud800\\udc00"',
]


@pytest.mark.parametrize("text,message", PROBED)
def test_the_message_is_serdes_own(text: str, message: str):
    assert serde_message(text) == message


@pytest.mark.parametrize("text", VALID)
def test_a_document_serde_accepts_reports_nothing(text: str):
    assert serde_message(text) is None


def test_the_column_counts_bytes_not_characters():
    # `é` is two bytes, so the offending `x` sits at column 6 even
    # though it is the fifth character.
    assert serde_message('["é"x') == "expected `,` or `]` at line 1 column 6"
    assert serde_message('["ée"x') == "expected `,` or `]` at line 1 column 7"


def test_a_newline_advances_the_line_and_zeroes_the_column():
    assert serde_message("{\n") == "EOF while parsing an object at line 2 column 0"
    assert serde_message("[1,\n2") == "EOF while parsing a list at line 2 column 1"
    assert serde_message('"a\nb"') == (
        "control character (\\u0000-\\u001F) found while parsing a string "
        "at line 2 column 0")


def test_a_raw_control_character_is_named_in_full():
    assert serde_message('"a\tb"') == (
        "control character (\\u0000-\\u001F) found while parsing a string "
        "at line 1 column 3")


def test_the_recursion_limit_is_serdes_own_128():
    # 127 nested lists parse; the 128th is refused at its own bracket.
    assert serde_message("[" * 127 + "]" * 127) is None
    assert serde_message("[" * 128 + "]" * 128) == (
        "recursion limit exceeded at line 1 column 128")
    assert serde_message("[" * 400 + "]" * 400) == (
        "recursion limit exceeded at line 1 column 128")

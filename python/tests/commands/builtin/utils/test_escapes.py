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

from mirage.commands.builtin.utils.escapes import interpret_escapes


@pytest.mark.parametrize(("text", "expected"), [
    ("\\n", "\n"),
    ("\\t", "\t"),
    ("\\r", "\r"),
    ("\\a", "\a"),
    ("\\b", "\b"),
    ("\\f", "\f"),
    ("\\v", "\v"),
    ("a\\\\b", "a\\b"),
])
def test_named_escapes(text: str, expected: str) -> None:
    assert interpret_escapes(text) == expected


def test_bare_zero_is_nul() -> None:
    assert interpret_escapes("\\0") == "\0"


def test_octal_needs_no_leading_zero() -> None:
    # `printf abc | tr '\141' X` => Xbc
    assert interpret_escapes("\\141") == "a"


def test_octal_stops_at_three_digits() -> None:
    # `printf abc | tr '\0141' X` => abc: the set is {FF, '1'}, neither of
    # which appears in the input.
    assert interpret_escapes("\\0141") == "\f1"


def test_octal_stops_at_the_first_non_octal_digit() -> None:
    # `printf a9b | tr '\19' Z` => aZb: the set is {SOH, '9'}.
    assert interpret_escapes("\\19") == "\x019"


def test_out_of_range_octal_backs_off_to_two_digits() -> None:
    # GNU warns "the ambiguous octal escape \400 is being interpreted as
    # the 2-byte sequence \040, 0" and yields {space, '0'}; we make the
    # same substitution without the warning, which has no channel here.
    assert interpret_escapes("\\400") == " 0"


@pytest.mark.parametrize(("text", "expected"), [
    ("\\z", "z"),
    ("\\e", "e"),
    ("\\8", "8"),
    ("\\9", "9"),
])
def test_unknown_escape_drops_the_backslash(text: str, expected: str) -> None:
    assert interpret_escapes(text) == expected


def test_no_hex_escape() -> None:
    # `printf axb | tr '\x41' -` => a-b, i.e. the set is {x, 4, 1}.
    assert interpret_escapes("\\x41") == "x41"


def test_no_stop_output_escape() -> None:
    assert interpret_escapes("hello\\cworld") == "hellocworld"


def test_trailing_backslash_is_literal() -> None:
    assert interpret_escapes("end\\") == "end\\"


@pytest.mark.parametrize(("text", "expected"), [
    ("", ""),
    ("hello world", "hello world"),
    ("a-z", "a-z"),
])
def test_plain_text_is_untouched(text: str, expected: str) -> None:
    assert interpret_escapes(text) == expected


def test_escaped_range_endpoints_survive_for_expand_ranges() -> None:
    assert interpret_escapes("\\101-\\103") == "A-C"

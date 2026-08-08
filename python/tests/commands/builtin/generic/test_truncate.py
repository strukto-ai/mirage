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

from mirage.commands.builtin.generic.truncate import parse_size
from mirage.commands.errors import UsageError


def test_plain_and_operation_sizes():
    assert parse_size("10", 0) == 10
    assert parse_size("+2", 10) == 12
    assert parse_size("-4", 10) == 6
    assert parse_size("<4", 10) == 4
    assert parse_size(">4", 10) == 10
    assert parse_size("%4", 10) == 12
    assert parse_size("/4", 10) == 8


def test_full_gnu_suffix_alphabet():
    # truncate's letter set is not split's: lowercase g/k/m/t are valid
    # (pinned against coreutils 9.7), and E/P parse fine even though most
    # filesystems refuse the resulting size.
    assert parse_size("1k", 0) == 1024
    assert parse_size("1g", 0) == 1024**3
    assert parse_size("1t", 0) == 1024**4
    assert parse_size("1G", 0) == 1024**3
    assert parse_size("1GiB", 0) == 1024**3
    assert parse_size("1GB", 0) == 1000**3
    assert parse_size("1mB", 0) == 1000**2
    assert parse_size("1E", 0) == 1024**6


def test_whitespace_skipped_around_the_mode_character():
    # GNU skips C-locale whitespace both before and after the mode char,
    # so ` 4` is absolute, ` +4` extends, and `< 4` caps (pinned against
    # coreutils 9.7).
    assert parse_size(" 4", 10) == 4
    assert parse_size("  8", 0) == 8
    assert parse_size(" +4", 10) == 14
    assert parse_size(" -4", 10) == 6
    assert parse_size(" <4", 10) == 4
    assert parse_size("\t2k", 0) == 2048
    assert parse_size("< 4", 10) == 4
    assert parse_size("<  4", 10) == 4
    assert parse_size("% 512", 10) == 512
    assert parse_size("/ 2", 10) == 10
    assert parse_size("> 4", 10) == 10
    assert parse_size("\t<\t4", 10) == 4
    assert parse_size("< 10K", 10) == 10


@pytest.mark.parametrize("value",
                         ["<+4", "< +4", "<-4", "%+4", ">-4", "<\t+4"])
def test_sign_after_mode_is_multiple_relative_modifiers(value):
    # A sign after <, >, / or % is refused as a second relative modifier
    # before the number is read, not reported as an invalid number.
    with pytest.raises(UsageError) as exc:
        parse_size(value, 10)
    assert str(exc.value) == ("truncate: multiple relative modifiers "
                              "specified\nTry 'truncate --help' for more "
                              "information.")
    assert exc.value.exit_code == 1


@pytest.mark.parametrize(("value", "quoted"), [
    ("abc", "abc"),
    ("", ""),
    ("1x1K", "1x1K"),
    ("2b", "2b"),
    ("5c", "5c"),
    ("1e", "1e"),
    ("+ 4", "+ 4"),
    ("++4", "++4"),
    ("+4 ", "+4 "),
    ("4 ", "4 "),
    ("4\t", "4\t"),
    ("10 K", "10 K"),
    (" ", ""),
    (" abc", "abc"),
    ("<abc", "abc"),
    ("<", ""),
    ("< ", ""),
    ("<4 ", "4 "),
    ("4B", "4B"),
    ("4iB", "4iB"),
    ("0x10", "0x10"),
])
def test_junk_is_invalid_number(value, quoted):
    # The digits must follow the sign immediately: no second sign, no gap,
    # and no trailing whitespace. GNU quotes the remainder past the skipped
    # whitespace and mode character, sign included. Deliberate divergence:
    # GNU's quotearg escapes control characters ('4\t' prints as '4\\t');
    # mirage quotes the raw remainder.
    with pytest.raises(UsageError) as exc:
        parse_size(value, 0)
    assert str(exc.value) == f"truncate: Invalid number: '{quoted}'"
    assert exc.value.exit_code == 1


def test_off_t_overflow_appends_value_too_large():
    with pytest.raises(UsageError) as exc:
        parse_size("1Z", 0)
    assert str(exc.value) == ("truncate: Invalid number: '1Z': "
                              "Value too large for defined data type")


def test_off_t_bound_is_asymmetric():
    # off_t is signed: 2**63 is one too large upward but fine downward.
    assert parse_size("8191P", 0) == 8191 * 1024**5
    assert parse_size("-8E", 10) == 0
    assert parse_size("-9223372036854775808", 10) == 0
    with pytest.raises(UsageError) as exc:
        parse_size("8E", 0)
    assert str(exc.value) == ("truncate: Invalid number: '8E': "
                              "Value too large for defined data type")
    with pytest.raises(UsageError):
        parse_size("9223372036854775808", 0)


def test_division_by_zero():
    with pytest.raises(UsageError) as exc:
        parse_size("/0", 10)
    assert str(exc.value) == "truncate: division by zero"

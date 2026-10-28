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

import json

import pytest

from mirage.utils.size import parse_limit


def test_parse_limit_bytes():
    assert parse_limit(1024, "limit") == 1024


def test_parse_limit_kb():
    assert parse_limit("1KB", "limit") == 1024


def test_parse_limit_mb():
    assert parse_limit("512MB", "limit") == 536870912


def test_parse_limit_gb():
    assert parse_limit("1GB", "limit") == 1073741824


def test_parse_limit_lowercase():
    assert parse_limit("10mb", "limit") == 10485760


def test_parse_limit_plain_string():
    assert parse_limit("1024", "limit") == 1024


@pytest.mark.parametrize(
    ("value", "size"),
    [
        (0, 0),
        ("0", 0),
        ("5K", 5 << 10),
        (" 1g ", 1 << 30),
        ("\t2Mb\n", 2 << 20),
        (2**53 - 1, 2**53 - 1),
        ("9007199254740991", 2**53 - 1),
        ("8388607G", 8388607 << 30),
        (1000.0, 1000),
        ("00000000000000001K", 1 << 10),
        pytest.param("0" * 5000 + "1", 1, id="5000-zeros"),
    ],
)
def test_parse_limit_reads_every_spelling_the_grammar_allows(value, size):
    assert parse_limit(value, "limit") == size


@pytest.mark.parametrize(
    ("value", "shown"),
    [
        ("-5", '"-5"'),
        (-7, "-7"),
        ("+3", '"+3"'),
        ("1_000", '"1_000"'),
        ("5 MB", '"5 MB"'),
        ("1.5MB", '"1.5MB"'),
        (1.5, "1.5"),
        (-1.0, "-1"),
        (1e-7, "1e-7"),
        (1e21, "1e+21"),
        ("5T", '"5T"'),
        ("5B", '"5B"'),
        ("5abc", '"5abc"'),
        ("", '""'),
        ("MB", '"MB"'),
        ("\u0665", '"\u0665"'),
        ("5\u212a", '"5\u212a"'),
        ("\u00a05", '"\u00a05"'),
        (True, "true"),
        ("99999999999999999999", '"99999999999999999999"'),
        ("9007199254740992", '"9007199254740992"'),
        (2**53, "9007199254740992"),
        (float("inf"), "Infinity"),
        (float("-inf"), "-Infinity"),
        (float("nan"), "NaN"),
        ("8388608G", '"8388608G"'),
        ([1, 2], "[1,2]"),
        ({"a": 1}, '{"a":1}'),
        pytest.param("1" * 5000, json.dumps("1" * 5000), id="5000-digits"),
    ],
)
def test_parse_limit_refuses_anything_else_in_one_message(value, shown):
    # The message is TypeScript's byte for byte: JSON.stringify's quoting,
    # and non-ASCII kept as it is.
    with pytest.raises(ValueError) as err:
        parse_limit(value, "limit")
    assert str(err.value) == f"limit must be a size like 100MB, got {shown}"

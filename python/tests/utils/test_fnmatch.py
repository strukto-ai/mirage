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

from mirage.utils.fnmatch import _normalize_negation, fnmatch


@pytest.mark.parametrize("name,pattern,expected", [
    ("c.txt", "[!ab].txt", True),
    ("a.txt", "[!ab].txt", False),
    ("c.txt", "[^ab].txt", True),
    ("a.txt", "[^ab].txt", False),
    ("b.txt", "[ab].txt", True),
    ("c.txt", "[a-c].txt", True),
    ("d.txt", "[a-c].txt", False),
    ("hello", "h*o", True),
    ("hello", "h?llo", True),
    ("Hello", "hello", False),
    ("x", "[x^]", True),
    ("^", "[x^]", True),
])
def test_fnmatch(name, pattern, expected):
    assert fnmatch(name, pattern) is expected


def test_normalize_negation_rewrites_class_openers():
    assert _normalize_negation("[^ab]*") == "[!ab]*"
    assert _normalize_negation("x[^y]") == "x[!y]"
    assert _normalize_negation("[!ab]") == "[!ab]"
    assert _normalize_negation("plain") == "plain"


def test_caret_not_first_in_class_stays_literal():
    assert fnmatch("^", "[a^]") is True
    assert fnmatch("b", "[a^]") is False

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

from mirage.commands.builtin.utils.size_suffix import size_suffixes


def test_letter_is_binary_power():
    table = size_suffixes("KMG")
    assert table["K"] == 1024
    assert table["M"] == 1024**2
    assert table["G"] == 1024**3


def test_b_form_is_decimal_and_ib_form_is_binary():
    table = size_suffixes("k")
    assert table["k"] == 1024
    assert table["kB"] == 1000
    assert table["kiB"] == 1024


def test_b_letter_is_512_with_no_compound_forms():
    table = size_suffixes("b")
    assert table == {"b": 512}


def test_case_is_preserved_not_folded():
    table = size_suffixes("kK")
    assert set(table) == {"k", "kB", "kiB", "K", "KB", "KiB"}


def test_unknown_letter_raises():
    with pytest.raises(KeyError):
        size_suffixes("w")

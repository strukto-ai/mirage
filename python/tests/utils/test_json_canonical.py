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

from mirage.utils.json_canonical import canonicalize_row, canonicalize_value


def test_whole_valued_floats_become_int():
    assert canonicalize_value(5.0) == 5
    assert isinstance(canonicalize_value(5.0), int)


def test_fractional_floats_are_unchanged():
    assert canonicalize_value(4.5) == 4.5
    assert isinstance(canonicalize_value(4.5), float)


def test_bool_and_string_and_non_finite_untouched():
    assert canonicalize_value(True) is True
    assert canonicalize_value("5.0") == "5.0"
    assert canonicalize_value(float("inf")) == float("inf")
    assert canonicalize_value(float("nan")) != canonicalize_value(float("nan"))


def test_recurses_into_dicts_and_lists():
    assert canonicalize_value({
        "r": 5.0,
        "xs": [1.0, 2.5]
    }) == {
        "r": 5,
        "xs": [1, 2.5],
    }


def test_canonicalize_row_maps_every_value():
    assert canonicalize_row({
        "a": 1.0,
        "b": "x",
        "c": 2.5
    }) == {
        "a": 1,
        "b": "x",
        "c": 2.5,
    }

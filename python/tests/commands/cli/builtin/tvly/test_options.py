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

import math

import pytest

from mirage.commands.cli.builtin.tvly.options import (
    InvalidOption,
    check_choice,
    js_number,
    parse_number,
    split_csv,
)


@pytest.mark.parametrize(
    ("raw", "value"),
    [(" 5 ", 5.0), ("0x10", 16.0), ("1e3", 1000.0), (".5", 0.5), ("1.", 1.0)],
)
def test_text_javascript_reads_as_a_number(raw, value):
    assert js_number(raw) == value


@pytest.mark.parametrize("raw", ["1_0", "inf", "0x", "-0x10", "5n"])
def test_text_javascript_refuses_is_nan(raw):
    assert math.isnan(js_number(raw))


def test_a_whole_number_comes_back_an_int():
    assert parse_number("7", "--max-results <n>", integer=True) == 7


@pytest.mark.parametrize(
    ("raw", "kwargs", "reason"),
    [
        ("abc", {}, "Not a number."),
        ("", {}, "Not a number."),
        ("1.5", {"integer": True}, "Not an integer."),
        ("30", {"maximum": 20}, "30 is above the maximum 20."),
        ("-1", {"minimum": 0}, "-1 is below the minimum 0."),
    ],
)
def test_a_number_is_refused_in_commanders_words(raw, kwargs, reason):
    with pytest.raises(InvalidOption) as refused:
        parse_number(raw, "--max-results <n>", **kwargs)
    assert str(refused.value) == (
        f"error: option '--max-results <n>' argument '{raw}' is invalid. "
        f"{reason}"
    )


def test_a_choice_names_every_allowed_value():
    assert check_choice("pro", "--model <model>", ("mini", "pro")) == "pro"
    with pytest.raises(InvalidOption, match="Allowed choices are mini, pro."):
        check_choice("max", "--model <model>", ("mini", "pro"))


def test_a_comma_list_keeps_empty_parts_trimmed():
    assert split_csv(" /a , /b,") == ["/a", "/b", ""]
    assert split_csv("") is None
    assert split_csv(None) is None

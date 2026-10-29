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
from pathlib import Path

import pytest

from mirage.utils.generated.width_data import WIDE, ZERO_WIDTH
from mirage.utils.width import char_width

_FIXTURE = (
    Path(__file__).parents[3] / "integ" / "fixtures" / "wc" / "width.json"
)


def test_shared_parity_fixture_pins_every_range():
    # integ/fixtures/wc/width.json is the contract: the TypeScript suite
    # (packages/core/src/utils/width.test.ts) asserts the same ranges, so
    # regenerating one tree without the other fails both.
    tables = json.loads(_FIXTURE.read_text())
    assert [list(pair) for pair in ZERO_WIDTH] == tables["zero_width"]
    assert [list(pair) for pair in WIDE] == tables["wide"]


@pytest.mark.parametrize(
    ("char", "expected"),
    [
        ("a", 1),
        ("\u4e2d", 2),
        ("\u6587", 2),
        ("\U0001f600", 2),
        ("\u0301", 0),
        ("\u1160", 0),
        ("\u11a8", 0),
        ("\u200b", 0),
        ("\ufeff", 0),
        ("\u061c", 0),
        ("\x00", 0),
        ("\x08", 0),
        ("\x1b", 0),
        ("\x0b", 0),
    ],
)
def test_char_width(char: str, expected: int) -> None:
    assert char_width(char) == expected


@pytest.mark.parametrize("char", ["\u00ad", "\u0600", "\U000110bd"])
def test_prepended_concatenation_marks_are_one_column(char: str) -> None:
    # Cf is not uniformly zero: GNU measures U+00AD and the Arabic number
    # signs as one column. `printf 'aU+00ADb' | wc -L` is 3.
    assert char_width(char) == 1

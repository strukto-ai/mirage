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

from mirage.utils.width import text_width


@pytest.mark.parametrize(
    "text,expected",
    [
        ("", 0),
        ("ascii", 5),
        ("中😀e\u0301", 5),
        ("a\t\nb\r", 2),
        ("\udc80\udcff", 2),
        ("\ud800", 1),
        ("\u3164\uffa0\ud7b0\u0378", 0),
        ("\u3248\U0001fae9", 4),
        ("😀" * 30_000, 60_000),
    ],
)
def test_text_width(text: str, expected: int) -> None:
    assert text_width(text) == expected

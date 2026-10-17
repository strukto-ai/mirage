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

from mirage.commands.builtin.general.bc.math import call_function
from mirage.commands.builtin.general.bc.render import render_number
from mirage.commands.builtin.general.bc.types import BcNumber


@pytest.mark.parametrize("scale", [0, 1, 20, 100])
@pytest.mark.parametrize("sign", [-1, 1])
@pytest.mark.parametrize("name", ["s", "a", "c"])
def test_math_truncates_tiny_corrections(name: str, sign: int, scale: int):
    result = call_function(name, BcNumber(sign, scale), scale)
    expected = "." + "9" * scale if name == "c" and scale else "0"
    assert render_number(result, 10) == expected

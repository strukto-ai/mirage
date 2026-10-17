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

from mirage.commands.builtin.general.bc.errors import BcRuntimeError
from mirage.commands.builtin.general.bc.math import (
    call_function,
    settle_interval,
)
from mirage.commands.builtin.general.bc.render import render_number
from mirage.commands.builtin.general.bc.types import BcNumber, MathInterval


@pytest.mark.parametrize("scale", [0, 1, 20, 100])
@pytest.mark.parametrize("sign", [-1, 1])
@pytest.mark.parametrize("name", ["s", "a", "c"])
def test_math_truncates_tiny_corrections(name: str, sign: int, scale: int):
    result = call_function(name, BcNumber(sign, scale), scale)
    expected = "." + "9" * scale if name == "c" and scale else "0"
    assert render_number(result, 10) == expected


@pytest.mark.parametrize("scale", [0, 1, 20, 100])
@pytest.mark.parametrize("sign", [-1, 1])
def test_math_near_quantum_boundaries(sign: int, scale: int):
    quantum = 10**scale
    cases = [(0, 0), (1, 1), (999, 3), (1001, 3), (2, 0)]
    for coefficient, extra in cases:
        arg = BcNumber(sign * coefficient, scale + extra)
        for name in ("s", "a", "c"):
            if coefficient == 0:
                expected = quantum if name == "c" else 0
            elif name == "c":
                expected = 0 if scale == 0 else quantum - 1
            elif coefficient == 2:
                expected = (1 if name == "a" else 0) if scale == 0 else 1
                expected *= sign
            elif coefficient == 1001 and scale >= 20:
                expected = sign
            else:
                expected = 0
            assert call_function(name, arg, scale).coefficient == expected


@pytest.mark.parametrize("scale", [0, 1, 20, 100])
def test_math_exp_and_log_near_one(scale: int):
    quantum = 10**scale
    expected_exp = 0 if scale == 0 else quantum - 1
    assert (
        call_function("e", BcNumber(-1, scale), scale).coefficient
        == expected_exp
    )
    assert (
        call_function("l", BcNumber(quantum + 1, scale), scale).coefficient
        == 0
    )


@pytest.mark.parametrize("sign", [-1, 1])
def test_math_settles_open_grid_endpoints(sign: int):
    lower, upper = (9, 10) if sign > 0 else (-10, -9)
    interval = MathInterval(
        BcNumber(lower, 0), BcNumber(upper, 0), sign < 0, sign > 0
    )
    assert settle_interval(interval, 0) == BcNumber(sign * 9, 0)
    closed = MathInterval(BcNumber(lower, 0), BcNumber(upper, 0), False, False)
    assert settle_interval(closed, 0) is None
    rounded = MathInterval(
        BcNumber(91 if sign > 0 else -99, 1),
        BcNumber(99 if sign > 0 else -91, 1),
        True,
        True,
    )
    assert settle_interval(rounded, 0) == BcNumber(sign * 9, 0)


@pytest.mark.parametrize("name", ["s", "a", "c"])
def test_math_tiny_input_does_not_require_full_working_precision(name: str):
    expected = 10**100 - 1 if name == "c" else 0
    assert call_function(name, BcNumber(1, 16000), 100).coefficient == expected


@pytest.mark.parametrize("name", ["s", "a", "c", "l", "e"])
def test_math_exact_identities_precede_precision_planning(name: str):
    arg = BcNumber(10**5000, 5000) if name == "l" else BcNumber(0, 16000)
    expected = 10**100 if name in ("c", "e") else 0
    assert call_function(name, arg, 100).coefficient == expected


@pytest.mark.parametrize(
    ("name", "arg"),
    [
        ("s", BcNumber(10**1499 + 1, 1500)),
        ("c", BcNumber(10**2099 + 1, 2100)),
        ("l", BcNumber(10**2300 + 1, 2300)),
        ("e", BcNumber(10**5000, 0)),
    ],
)
def test_math_refuses_unbounded_working_precision(name: str, arg: BcNumber):
    with pytest.raises(BcRuntimeError, match="Arithmetic limit exceeded"):
        call_function(name, arg, 100)


@pytest.mark.parametrize(
    ("coefficient", "scale", "expected"),
    [
        (
            1,
            20,
            "-460517018598809136803598290936872841520220297725754595206665580193514521935470496047199441017919659668",
        ),
        (
            1,
            40,
            "-921034037197618273607196581873745683040440595451509190413331160387029043870940992094398882035839319336",
        ),
        (
            46511,
            48,
            "-997766403409746616629445553439376448559279753222656842613015918479959801357470111011200235139937215531",
        ),
    ],
)
def test_math_log_preserves_small_input_precision(
    coefficient: int, scale: int, expected: str
):
    result = call_function("l", BcNumber(coefficient, scale), 100)
    assert str(result.coefficient) == expected

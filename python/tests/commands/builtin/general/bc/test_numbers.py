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
import os
import subprocess
import sys
from pathlib import Path

import pytest

from mirage.commands.builtin.general.bc import constants
from mirage.commands.builtin.general.bc.errors import BcRuntimeError
from mirage.commands.builtin.general.bc.numbers import (
    apply_binary,
    bc_length,
    bc_sqrt,
    divide,
    power_ten,
    read_base_number,
    rescale,
)
from mirage.commands.builtin.general.bc.parser import eval_statement
from mirage.commands.builtin.general.bc.types import BcNumber, BcState


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("1.0^1000000000000", "1.000\n"),
        ("(-1.00)^1000000000001", "-1.000\n"),
        ("0.00^1000000000000", "0\n"),
        ("0^0", "1\n"),
        ("1.0^-1000000000000", "1.000\n"),
        ("(-1.00)^-1000000000001", "-1.000\n"),
        (".1^1000000000000", "0\n"),
        (".10^-2", "100.000\n"),
        ("1.2^3", "1.728\n"),
        ("1.2^-3", ".578\n"),
        ("(-1.20)^-3", "-.578\n"),
    ],
)
def test_power_preserves_original_result_scale(text: str, expected: str):
    writes: list[str] = []
    eval_statement(text, BcState(3, False), writes)
    assert "".join(writes) == expected


@pytest.mark.parametrize(
    "text",
    [
        "2^1000000",
        "2^-1000000",
        "2^" + str(10**100),
        "2^-" + str(10**100),
        ".1^-10000000000000000000000000000000000",
        "2^32768*2^32768",
        "1" * (constants.MAX_LITERAL_DIGITS + 1),
        "." + "0" * constants.MAX_LITERAL_DIGITS + "1",
    ],
    ids=lambda text: text[:40],
)
def test_resource_error_allows_later_line(text: str):
    script = """
import asyncio
import json
import sys
from mirage.commands.builtin.general.bc.command import run_lines
from mirage.commands.builtin.general.bc.lexer import parse_input
from mirage.commands.builtin.general.bc.render import OutputColumn
from mirage.commands.builtin.general.bc.types import BcState
async def run():
    errors = []
    output = [chunk async for chunk in run_lines(
        parse_input((sys.argv[1] + ";99\\n2+2\\n").encode()),
        BcState(0, False), OutputColumn(0), errors)]
    print(json.dumps([errors, b"".join(output).decode()]))
asyncio.run(run())
"""
    env = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[5]))
    result = subprocess.run(
        [sys.executable, "-c", script, text],
        capture_output=True,
        text=True,
        timeout=5,
        check=True,
        env=env,
    )
    assert json.loads(result.stdout) == [
        ["Runtime error (func=(main), adr=3): Arithmetic limit exceeded"],
        "4\n",
    ]


def test_literal_budget_preserves_large_exact_values():
    num = read_base_number("1" + "0" * 5000, 10)
    assert bc_length(num) == 5001
    fraction = read_base_number("." + "0" * 15999 + "1", 10)
    assert fraction == BcNumber(1, 16000)
    assert read_base_number("F" * 16000, 16).coefficient.bit_length() == 64000
    with pytest.raises(BcRuntimeError, match=constants.ARITHMETIC_LIMIT):
        read_base_number("." + "F" * 16000, 16)


def test_preflight_bounds_scale_shifts_division_and_sqrt():
    for exponent in [-1, constants.MAX_COEFFICIENT_BITS]:
        with pytest.raises(BcRuntimeError, match=constants.ARITHMETIC_LIMIT):
            power_ten(exponent)
    assert power_ten(0) == 1
    assert rescale(BcNumber(1, 16000), 0) == BcNumber(0, 0)
    huge = BcNumber(2**32768, 0)
    with pytest.raises(BcRuntimeError, match=constants.ARITHMETIC_LIMIT):
        apply_binary("*", huge, huge, BcState(0, False))
    with pytest.raises(BcRuntimeError, match=constants.ARITHMETIC_LIMIT):
        rescale(huge, 16000)
    with pytest.raises(BcRuntimeError, match=constants.ARITHMETIC_LIMIT):
        divide(huge, BcNumber(1, 0), 16000)
    with pytest.raises(BcRuntimeError, match=constants.ARITHMETIC_LIMIT):
        bc_sqrt(BcNumber(2, 0), 16000)

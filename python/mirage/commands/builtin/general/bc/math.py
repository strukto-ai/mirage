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

from .numbers import (
    integer_sqrt,
    integer_text,
    rescale,
    trunc_div,
    truncate_int,
)
from .types import BcNumber


def atan_series(x: int, unit: int) -> int:
    square = x * x
    power = x
    total = x
    denominator = 3
    while power:
        power = -trunc_div(power * square, unit * unit)
        term = trunc_div(power, denominator)
        if term == 0:
            break
        total += term
        denominator += 2
    return total


def pi(unit: int) -> int:
    return 16 * atan_series(unit // 5, unit) - 4 * atan_series(
        unit // 239, unit
    )


def bc_atan(x: int, unit: int) -> int:
    sign = -1 if x < 0 else 1
    x = abs(x)
    reflected = x > unit
    if reflected:
        x = unit * unit // x
    halvings = 0
    while x > unit // 4:
        x = x * unit // (unit + integer_sqrt(unit * unit + x * x))
        halvings += 1
    result = atan_series(x, unit) * (1 << halvings)
    if reflected:
        result = pi(unit) // 2 - result
    return sign * result


def bc_sin(x: int, unit: int) -> int:
    half_circle = pi(unit)
    x -= trunc_div(x, 2 * half_circle) * 2 * half_circle
    if x > half_circle:
        x -= 2 * half_circle
    elif x < -half_circle:
        x += 2 * half_circle
    term = x
    total = x
    index = 1
    while term:
        term = -trunc_div(
            term * x * x, unit * unit * (2 * index) * (2 * index + 1)
        )
        total += term
        index += 1
    return total


def bc_cos(x: int, unit: int) -> int:
    half_circle = pi(unit)
    x -= trunc_div(x, 2 * half_circle) * 2 * half_circle
    if x > half_circle:
        x -= 2 * half_circle
    elif x < -half_circle:
        x += 2 * half_circle
    term = unit
    total = unit
    index = 1
    while term:
        term = -trunc_div(
            term * x * x, unit * unit * (2 * index - 1) * (2 * index)
        )
        total += term
        index += 1
    return total


def bc_log(x: int, unit: int) -> int:
    halvings = 0
    while x < unit // 2 or x > 2 * unit:
        x = integer_sqrt(x * unit)
        halvings += 1
    z = trunc_div((x - unit) * unit, x + unit)
    square = z * z
    power = z
    total = z
    denominator = 3
    while power:
        power = trunc_div(power * square, unit * unit)
        term = trunc_div(power, denominator)
        if term == 0:
            break
        total += term
        denominator += 2
    return total * (1 << (halvings + 1))


def bc_exp(x: int, unit: int) -> int:
    negative = x < 0
    x = abs(x)
    halvings = 0
    while x > unit // 8:
        x //= 2
        halvings += 1
    total = unit
    term = unit
    index = 1
    while term:
        term = term * x // (unit * index)
        total += term
        index += 1
    for _ in range(halvings):
        total = total * total // unit
    return unit * unit // total if negative else total


def log_domain_value(scale: int) -> BcNumber:
    return BcNumber((1 - 10**scale) * 10**scale, scale)


def working_scale(name: str, arg: BcNumber, scale: int) -> int:
    """Reserve digits lost to reduction and repeated squaring.

    GNU bc 1.07.1's intermediate truncation can alter its last result
    digits, especially for large trigonometric arguments. Extra working
    precision deliberately keeps the mathematical digits here.

    Args:
        name (str): the math-library function.
        arg (BcNumber): the exact input value.
        scale (int): the requested result scale.
    """
    working = max(scale, arg.scale) + 16
    if name in ("s", "c"):
        working += max(0, len(integer_text(abs(arg.coefficient))) - arg.scale)
    elif name == "e":
        working += max(0, truncate_int(arg)) // 2
    return working


def call_function(name: str, arg: BcNumber, scale: int) -> BcNumber:
    if name == "l" and arg.coefficient <= 0:
        return log_domain_value(scale)
    if name == "e" and truncate_int(arg) < -3 * (scale + 16):
        return BcNumber(0, scale)
    working = working_scale(name, arg, scale)
    unit = 10**working
    value = rescale(arg, working).coefficient
    functions = {
        "s": bc_sin,
        "c": bc_cos,
        "a": bc_atan,
        "l": bc_log,
        "e": bc_exp,
    }
    return rescale(BcNumber(functions[name](value, unit), working), scale)

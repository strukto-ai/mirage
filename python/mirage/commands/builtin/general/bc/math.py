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

from . import constants
from .errors import BcRuntimeError
from .numbers import (
    ensure_bits,
    integer_sqrt,
    integer_text,
    power_ten,
    rescale,
    trunc_div,
    truncate_int,
)
from .types import BcNumber, MathInterval


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
        ensure_bits(2 * total.bit_length())
        total = total * total // unit
    return unit * unit // total if negative else total


def log_domain_value(scale: int) -> BcNumber:
    unit = power_ten(scale)
    ensure_bits(2 * unit.bit_length())
    return BcNumber((1 - unit) * unit, scale)


def settle_interval(interval: MathInterval, scale: int) -> BcNumber | None:
    def candidate(endpoint: BcNumber, opened: bool, lower: bool) -> int:
        result = rescale(endpoint, scale).coefficient
        on_grid = (
            endpoint.scale <= scale
            or endpoint.coefficient % power_ten(endpoint.scale - scale) == 0
        )
        if opened and on_grid:
            if lower and endpoint.coefficient < 0:
                result += 1
            elif not lower and endpoint.coefficient > 0:
                result -= 1
        return result

    lower = candidate(interval.lower, interval.lower_open, True)
    upper = candidate(interval.upper, interval.upper_open, False)
    return BcNumber(lower, scale) if lower == upper else None


def small_result(name: str, arg: BcNumber, scale: int) -> BcNumber | None:
    if name not in ("s", "a", "c"):
        return None
    magnitude = abs(arg.coefficient)
    digits = integer_text(magnitude)
    shift = arg.scale - scale
    tiny = shift >= 0 and (
        len(digits) <= shift
        or len(digits) == shift + 1
        and digits == "1" + "0" * shift
    )
    if tiny:
        return BcNumber(power_ten(scale) - 1 if name == "c" else 0, scale)
    if (
        len(digits) > arg.scale and not (magnitude == 1 and arg.scale == 0)
    ) or arg.scale > constants.MAX_WORKING_SCALE // 3:
        return None
    order = 2 if name == "c" else 3
    endpoint_scale = order * arg.scale
    ensure_bits(order * magnitude.bit_length() + 4)
    power = magnitude**order
    divisor = 2 if name == "c" else 6 if name == "s" else 3
    correction, remainder = divmod(power, divisor)
    upper = (
        power_ten(endpoint_scale)
        if name == "c"
        else magnitude * power_ten(endpoint_scale - arg.scale)
    )
    lower = upper - correction - bool(remainder)
    interval = MathInterval(
        BcNumber(lower, endpoint_scale),
        BcNumber(upper, endpoint_scale),
        remainder == 0,
        True,
    )
    if name != "c" and arg.coefficient < 0:
        interval = MathInterval(
            BcNumber(-upper, endpoint_scale),
            BcNumber(-lower, endpoint_scale),
            True,
            remainder == 0,
        )
    return settle_interval(interval, scale)


def working_scale(name: str, arg: BcNumber, scale: int) -> int:
    """Plan bounded precision for the approximate general math kernels.

    GNU bc 1.07.1's intermediate truncation can alter its last result
    digits, especially for large trigonometric arguments. Extra working
    precision deliberately reduces that error here. The general kernels
    do not certify the final digit outside the small-argument enclosures.

    Args:
        name (str): the math-library function.
        arg (BcNumber): the exact input value.
        scale (int): the requested result scale.
    """
    working = max(scale, arg.scale) + 16
    if name in ("s", "a", "c"):
        working = max(working, (2 if name == "c" else 3) * arg.scale + 16)
    if name in ("e", "l"):
        working = max(working, 2 * arg.scale + 16)
    if name == "l":
        working = max(working, scale + arg.scale + 16)
    if name in ("s", "c"):
        working += max(0, len(integer_text(abs(arg.coefficient))) - arg.scale)
    elif name == "e":
        integer = truncate_int(arg)
        if abs(integer) > 2 * constants.MAX_WORKING_SCALE:
            raise BcRuntimeError(constants.ARITHMETIC_LIMIT)
        working += abs(integer) // 2
    if working > constants.MAX_WORKING_SCALE:
        raise BcRuntimeError(constants.ARITHMETIC_LIMIT)
    ensure_bits(
        constants.DECIMAL_DIGIT_BITS
        * working
        * constants.SERIES_PRODUCT_FACTORS
        + constants.SERIES_LOOP_BITS
    )
    return working


def call_function(name: str, arg: BcNumber, scale: int) -> BcNumber:
    if arg.coefficient == 0:
        if name == "l":
            return log_domain_value(scale)
        return BcNumber(power_ten(scale) if name in ("c", "e") else 0, scale)
    digits = integer_text(abs(arg.coefficient))
    trailing = min(arg.scale, len(digits) - len(digits.rstrip("0")))
    if trailing:
        arg = rescale(arg, arg.scale - trailing)
    if name == "l" and arg.coefficient == 1 and arg.scale == 0:
        return BcNumber(0, scale)
    if name == "l" and arg.coefficient < 0:
        return log_domain_value(scale)
    if name == "e" and truncate_int(arg) < -3 * (scale + 16):
        return BcNumber(0, scale)
    settled = small_result(name, arg, scale)
    if settled is not None:
        return settled
    working = working_scale(name, arg, scale)
    unit = power_ten(working)
    value = rescale(arg, working).coefficient
    ensure_bits(abs(value).bit_length() + unit.bit_length() + 2)
    functions = {
        "s": bc_sin,
        "c": bc_cos,
        "a": bc_atan,
        "l": bc_log,
        "e": bc_exp,
    }
    return rescale(BcNumber(functions[name](value, unit), working), scale)

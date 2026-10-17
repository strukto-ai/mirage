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
from .errors import BcParseError, BcRuntimeError, runtime_warning_line
from .types import BcNumber, BcState

ZERO = BcNumber(0, 0)


def clamp_scale(scale: int) -> int:
    return max(0, min(scale, constants.MAX_SCALE))


def integer_text(value: int) -> str:
    if value == 0:
        return "0"
    magnitude = abs(value)
    groups: list[int] = []
    while magnitude:
        magnitude, group = divmod(magnitude, 10**9)
        groups.append(group)
    return (
        ("-" if value < 0 else "")
        + str(groups[-1])
        + "".join(str(group).rjust(9, "0") for group in reversed(groups[:-1]))
    )


def trunc_div(a: int, b: int) -> int:
    quotient = abs(a) // abs(b)
    return -quotient if (a < 0) != (b < 0) else quotient


def rescale(num: BcNumber, scale: int) -> BcNumber:
    shift = scale - num.scale
    coefficient = (
        num.coefficient * 10**shift
        if shift >= 0
        else trunc_div(num.coefficient, 10**-shift)
    )
    return BcNumber(coefficient, scale)


def truncate_int(num: BcNumber) -> int:
    return trunc_div(num.coefficient, 10**num.scale)


def digit_value(char: str, ibase: int, clamp: bool) -> int:
    value = constants.BASE_DIGITS.index(char)
    return min(value, ibase - 1) if clamp else value


def read_base_number(raw: str, ibase: int) -> BcNumber:
    whole, _, fraction = raw.partition(".")
    if "." in fraction:
        raise BcParseError(constants.SYNTAX_ERROR)
    scale = len(fraction)
    numerator = 0
    for char in whole:
        numerator = numerator * ibase + digit_value(
            char, ibase, len(whole) > 1
        )
    for char in fraction:
        numerator = numerator * ibase + digit_value(char, ibase, True)
    return BcNumber(numerator * 10**scale // ibase ** len(fraction), scale)


def add_scale(a: BcNumber, b: BcNumber) -> int:
    return max(a.scale, b.scale)


def mul_scale(a: BcNumber, b: BcNumber, scale: int) -> int:
    return min(a.scale + b.scale, max(scale, a.scale, b.scale))


def pow_scale(a: BcNumber, exponent: int, scale: int) -> int:
    return (
        scale if exponent < 0 else min(a.scale * exponent, max(scale, a.scale))
    )


def divide(a: BcNumber, b: BcNumber, scale: int) -> BcNumber:
    if b.coefficient == 0:
        raise BcRuntimeError(constants.DIVIDE_BY_ZERO)
    shift = b.scale + scale - a.scale
    numerator = a.coefficient * 10 ** max(shift, 0)
    denominator = b.coefficient * 10 ** max(-shift, 0)
    return BcNumber(trunc_div(numerator, denominator), scale)


def modulo(a: BcNumber, b: BcNumber, scale: int) -> BcNumber:
    if b.coefficient == 0:
        raise BcRuntimeError(constants.MODULO_BY_ZERO)
    quotient = divide(a, b, scale)
    result_scale = max(a.scale, scale + b.scale)
    left = rescale(a, result_scale)
    product = rescale(
        BcNumber(quotient.coefficient * b.coefficient, scale + b.scale),
        result_scale,
    )
    return BcNumber(left.coefficient - product.coefficient, result_scale)


def apply_binary(
    op: str, a: BcNumber, b: BcNumber, state: BcState
) -> BcNumber:
    scale = state.scale
    if op in ("+", "-"):
        target = add_scale(a, b)
        left = rescale(a, target).coefficient
        right = rescale(b, target).coefficient
        return BcNumber(left + right if op == "+" else left - right, target)
    if op == "*":
        return rescale(
            BcNumber(a.coefficient * b.coefficient, a.scale + b.scale),
            mul_scale(a, b, scale),
        )
    if op == "/":
        return divide(a, b, scale)
    if op == "%":
        return modulo(a, b, scale)
    exponent = truncate_int(b)
    if b.scale != 0:
        state.warnings.append(
            runtime_warning_line(constants.NONZERO_EXPONENT_SCALE)
        )
    if exponent == 0:
        return BcNumber(1, 0)
    if exponent < 0 and a.coefficient == 0:
        raise BcRuntimeError(constants.POW_DIVIDE_BY_ZERO)
    power = BcNumber(a.coefficient ** abs(exponent), a.scale * abs(exponent))
    if exponent < 0:
        return divide(BcNumber(1, 0), power, scale)
    return rescale(power, pow_scale(a, exponent, scale))


def integer_sqrt(value: int) -> int:
    if value < 2:
        return value
    root = 1 << ((value.bit_length() + 1) // 2)
    while True:
        next_root = (root + value // root) // 2
        if next_root >= root:
            return root
        root = next_root


def bc_sqrt(arg: BcNumber, scale: int) -> BcNumber:
    if arg.coefficient < 0:
        raise BcRuntimeError(constants.NEGATIVE_SQRT)
    if arg.coefficient == 0:
        return ZERO
    if arg.coefficient == 10**arg.scale:
        return BcNumber(1, 0)
    target = max(scale, arg.scale)
    return BcNumber(
        integer_sqrt(arg.coefficient * 10 ** (2 * target - arg.scale)), target
    )


def bc_length(num: BcNumber) -> int:
    return max(len(integer_text(abs(num.coefficient))), num.scale)


def call_builtin(name: str, arg: BcNumber, scale: int) -> BcNumber:
    if name == constants.LENGTH_NAME:
        return BcNumber(bc_length(arg), 0)
    if name == constants.SCALE_NAME:
        return BcNumber(arg.scale, 0)
    return bc_sqrt(arg, scale)

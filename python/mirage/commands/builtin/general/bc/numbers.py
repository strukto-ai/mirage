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


def ensure_bits(bits: int) -> None:
    if bits < 0 or bits > constants.MAX_COEFFICIENT_BITS:
        raise BcRuntimeError(constants.ARITHMETIC_LIMIT)


def power_ten(exponent: int) -> int:
    ensure_bits(4 * exponent + 1 if exponent >= 0 else -1)
    value: int = 10**exponent
    return value


def coefficient_bits(value: int) -> int:
    return abs(value).bit_length()


def shift_decimal(value: int, shift: int) -> int:
    if value == 0:
        return 0
    if shift >= 0:
        ensure_bits(coefficient_bits(value) + 4 * shift)
        return value * power_ten(shift)
    if -shift >= coefficient_bits(value):
        return 0
    return trunc_div(value, power_ten(-shift))


def normalize(num: BcNumber) -> BcNumber:
    coefficient, scale = num.coefficient, num.scale
    if coefficient == 0:
        return ZERO
    while scale and coefficient % 10 == 0:
        coefficient //= 10
        scale -= 1
    return BcNumber(coefficient, scale)


def multiply(a: int, b: int) -> int:
    if a == 0 or b == 0:
        return 0
    ensure_bits(coefficient_bits(a) + coefficient_bits(b))
    return a * b


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
    ensure_bits(constants.DECIMAL_DIGIT_BITS * scale + 1)
    return BcNumber(shift_decimal(num.coefficient, scale - num.scale), scale)


def truncate_int(num: BcNumber) -> int:
    return shift_decimal(num.coefficient, -num.scale)


def digit_value(char: str, ibase: int, clamp: bool) -> int:
    value = constants.BASE_DIGITS.index(char)
    return min(value, ibase - 1) if clamp else value


def split_literal(raw: str) -> tuple[str, str]:
    whole, _, fraction = raw.partition(".")
    if "." in fraction:
        raise BcParseError(constants.SYNTAX_ERROR)
    return whole, fraction


def read_base_number(raw: str, ibase: int) -> BcNumber:
    whole, fraction = split_literal(raw)
    if len(whole) + len(fraction) > constants.MAX_LITERAL_DIGITS:
        raise BcRuntimeError(constants.ARITHMETIC_LIMIT)
    scale = len(fraction)
    ensure_bits(4 * (len(whole) + scale) + 1)
    numerator = 0
    for char in whole:
        numerator = numerator * ibase + digit_value(
            char, ibase, len(whole) > 1
        )
    for char in fraction:
        numerator = numerator * ibase + digit_value(char, ibase, True)
    if ibase == constants.DEFAULT_BASE:
        return BcNumber(numerator, scale)
    ensure_bits(ibase.bit_length() * scale + 1)
    denominator = ibase**scale
    return BcNumber(shift_decimal(numerator, scale) // denominator, scale)


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
    left, right = normalize(a), normalize(b)
    shift = right.scale + scale - left.scale
    numerator = shift_decimal(left.coefficient, max(shift, 0))
    denominator = shift_decimal(right.coefficient, max(-shift, 0))
    return BcNumber(trunc_div(numerator, denominator), scale)


def modulo(a: BcNumber, b: BcNumber, scale: int) -> BcNumber:
    if b.coefficient == 0:
        raise BcRuntimeError(constants.MODULO_BY_ZERO)
    quotient = divide(a, b, scale)
    result_scale = max(a.scale, scale + b.scale)
    left = rescale(a, result_scale)
    product = rescale(
        BcNumber(
            multiply(quotient.coefficient, b.coefficient), scale + b.scale
        ),
        result_scale,
    )
    ensure_bits(
        max(
            coefficient_bits(left.coefficient),
            coefficient_bits(product.coefficient),
        )
        + 1
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
        ensure_bits(max(coefficient_bits(left), coefficient_bits(right)) + 1)
        return BcNumber(left + right if op == "+" else left - right, target)
    if op == "*":
        return rescale(
            BcNumber(
                multiply(a.coefficient, b.coefficient), a.scale + b.scale
            ),
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
    result_scale = pow_scale(a, exponent, scale)
    base = normalize(a)
    if base.coefficient == 0:
        if exponent < 0:
            raise BcRuntimeError(constants.POW_DIVIDE_BY_ZERO)
        return BcNumber(0, result_scale)
    magnitude = abs(exponent)
    if abs(base.coefficient) == 1:
        sign = -1 if base.coefficient < 0 and magnitude % 2 else 1
        shift = result_scale + base.scale * -exponent
        return BcNumber(shift_decimal(sign, shift), result_scale)
    ensure_bits(coefficient_bits(base.coefficient) * magnitude)
    raw_scale = base.scale * magnitude
    ensure_bits(4 * raw_scale + 1)
    power = BcNumber(base.coefficient**magnitude, raw_scale)
    if exponent < 0:
        return divide(BcNumber(1, 0), power, result_scale)
    return rescale(power, result_scale)


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
    base = normalize(arg)
    if base == BcNumber(1, 0):
        return BcNumber(1, 0)
    target = max(scale, arg.scale)
    return BcNumber(
        integer_sqrt(shift_decimal(base.coefficient, 2 * target - base.scale)),
        target,
    )


def bc_length(num: BcNumber) -> int:
    return max(len(integer_text(abs(num.coefficient))), num.scale)


def call_builtin(name: str, arg: BcNumber, scale: int) -> BcNumber:
    if name == constants.LENGTH_NAME:
        return BcNumber(bc_length(arg), 0)
    if name == constants.SCALE_NAME:
        return BcNumber(arg.scale, 0)
    return bc_sqrt(arg, scale)

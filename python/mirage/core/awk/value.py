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
import re
from dataclasses import dataclass
from enum import StrEnum

NUMERIC_STRING = re.compile(
    r"^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?\Z")

NUMERIC_PREFIX = re.compile(
    r"^[ \t\n]*[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?")

CONVFMT_SPEC = re.compile(r"^%([-+ #0]*)([0-9]*)(\.[0-9]*)?([eEfFgG])\Z")

DEFAULT_CONVFMT = "%.6g"

BLANKS = " \t\n"

INT_LIMIT = 2.0**63

INT_CLAMP = 2**63


class ValueKind(StrEnum):
    UNINIT = "UNINIT"
    NUM = "NUM"
    STR = "STR"
    STRNUM = "STRNUM"


@dataclass(frozen=True, slots=True)
class Value:
    kind: ValueKind
    num: float = 0.0
    text: str = ""


UNINIT = Value(ValueKind.UNINIT)
ZERO = Value(ValueKind.NUM, 0.0)
ONE = Value(ValueKind.NUM, 1.0)


def num(value: float) -> Value:
    """Wrap a float as a numeric awk value.

    Args:
        value (float): the number.
    """
    return Value(ValueKind.NUM, value)


def text(value: str) -> Value:
    """Wrap a string as a string awk value.

    Args:
        value (str): the string.
    """
    return Value(ValueKind.STR, 0.0, value)


def looks_numeric(raw: str) -> bool:
    """Report whether a string lexically matches an awk NUMBER token.

    Args:
        raw (str): candidate text, leading and trailing blanks allowed.
    """
    stripped = raw.strip(BLANKS)
    if not stripped:
        return False
    return NUMERIC_STRING.match(stripped) is not None


def strnum(raw: str) -> Value:
    """Wrap input-derived text, tagging it strnum when it looks numeric.

    Fields, getline results, split() output, FILENAME, ARGV, ENVIRON and
    command-line assignments all produce these; the tag is what makes
    ``$1 == 10`` a numeric comparison.

    Args:
        raw (str): the input text.
    """
    if not raw:
        # An absent or empty field is a plain string, not the dual-typed
        # uninitialized value: every awk agrees `$9 == 0` is false while
        # `x == 0` is true for an unset variable x.
        return Value(ValueKind.STR, 0.0, "")
    if looks_numeric(raw):
        return Value(ValueKind.STRNUM, parse_number(raw), raw)
    return Value(ValueKind.STR, 0.0, raw)


def parse_number(raw: str) -> float:
    """Convert a leading numeric prefix to a float, strtod style.

    Args:
        raw (str): text that may begin with a number.

    Returns:
        float: the parsed value, 0.0 when there is no numeric prefix.
    """
    match = NUMERIC_PREFIX.match(raw)
    if match is None:
        return 0.0
    body = match.group(0).strip(BLANKS)
    if not body or body in ("+", "-"):
        return 0.0
    return float(body)


def to_num(value: Value) -> float:
    """Read the numeric value of an awk value.

    Args:
        value (Value): the value to coerce.
    """
    if value.kind is ValueKind.UNINIT:
        return 0.0
    if value.kind in (ValueKind.NUM, ValueKind.STRNUM):
        return value.num
    return parse_number(value.text)


def to_int(value: float) -> int:
    """Truncate a number toward zero, the way awk reads an integer.

    NaN reads as 0 and an infinity clamps to the 64-bit edge, so a field
    index or a substr position never raises on a degenerate number.

    Args:
        value (float): the number to truncate.
    """
    if math.isnan(value):
        return 0
    if math.isinf(value):
        return INT_CLAMP if value > 0 else -INT_CLAMP
    return int(value)


def format_num(value: float, convfmt: str) -> str:
    """Render a number the way awk converts numbers to strings.

    Integral values print as integers regardless of CONVFMT, matching
    every awk; anything else goes through CONVFMT (or OFMT for output).

    Args:
        value (float): the number to render.
        convfmt (str): the conversion format, normally "%.6g".
    """
    if math.isnan(value):
        return "nan"
    if math.isinf(value):
        return "inf" if value > 0 else "-inf"
    if value == int(value) and abs(value) < INT_LIMIT:
        return str(int(value))
    if CONVFMT_SPEC.match(convfmt) is None:
        return DEFAULT_CONVFMT % value
    return convfmt % value


def to_str(value: Value, convfmt: str) -> str:
    """Read the string value of an awk value.

    Args:
        value (Value): the value to coerce.
        convfmt (str): CONVFMT, used for non-integral numbers.
    """
    if value.kind is ValueKind.UNINIT:
        return ""
    if value.kind is ValueKind.NUM:
        return format_num(value.num, convfmt)
    return value.text


def is_true(value: Value) -> bool:
    """Report awk truthiness: nonzero number or non-empty string.

    Args:
        value (Value): the value to test.
    """
    if value.kind is ValueKind.UNINIT:
        return False
    if value.kind in (ValueKind.NUM, ValueKind.STRNUM):
        return value.num != 0.0
    return value.text != ""


def compares_numerically(value: Value) -> bool:
    """Report whether a value may take part in a numeric comparison.

    Args:
        value (Value): the operand to classify.
    """
    return value.kind in (ValueKind.NUM, ValueKind.STRNUM, ValueKind.UNINIT)


def compare(left: Value, right: Value, convfmt: str) -> int:
    """Compare two awk values, choosing numeric or string ordering.

    POSIX compares numerically when both sides are numeric, numeric
    strings or uninitialized, and lexically otherwise.

    Args:
        left (Value): left operand.
        right (Value): right operand.
        convfmt (str): CONVFMT for the string fallback.

    Returns:
        int: -1, 0 or 1.
    """
    if compares_numerically(left) and compares_numerically(right):
        lhs = to_num(left)
        rhs = to_num(right)
    else:
        lhs_s = to_str(left, convfmt)
        rhs_s = to_str(right, convfmt)
        if lhs_s == rhs_s:
            return 0
        return -1 if lhs_s < rhs_s else 1
    if lhs == rhs:
        return 0
    return -1 if lhs < rhs else 1


__all__ = [
    "ONE",
    "UNINIT",
    "ZERO",
    "Value",
    "ValueKind",
    "compare",
    "compares_numerically",
    "format_num",
    "is_true",
    "looks_numeric",
    "num",
    "parse_number",
    "strnum",
    "text",
    "to_int",
    "to_num",
    "to_str",
]

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

from collections.abc import Mapping
from dataclasses import dataclass

from . import constants
from .numbers import integer_text
from .types import BcNumber


def c_atoi(text: str) -> int:
    """Read an integer from `text` the way C's `atoi` does.

    GNU reads `BC_LINE_LENGTH` with `atoi`, which is lenient where a
    host's own integer parser is strict: it skips leading blanks, takes
    one optional sign, stops at the first character that is not a digit,
    and answers 0 when there was no digit at all -- so `abc`, an empty
    value and `0x46` all read as 0, which is what turns folding off.

    Args:
        text (str): the raw environment value.

    Returns:
        int: the value, in the range of a signed 32-bit int. glibc's
            `atoi` is `strtol` saturated to a signed 64-bit range and
            then truncated, and both steps show: `4294967296` reads as 0
            and `9223372036854775808` as -1.
    """
    body = text.lstrip(constants.C_BLANKS)
    negative = body[:1] == "-"
    if body[:1] in ("+", "-"):
        body = body[1:]
    digits = ""
    for char in body:
        if char not in constants.DECIMAL_DIGITS:
            break
        digits += char
    if digits == "":
        return 0
    value = -int(digits) if negative else int(digits)
    limit = 1 << (constants.C_LONG_BITS - 1)
    value = max(-limit, min(value, limit - 1))
    value &= (1 << constants.C_INT_BITS) - 1
    if value >= 1 << (constants.C_INT_BITS - 1):
        value -= 1 << constants.C_INT_BITS
    return value


def output_line_length(env: Mapping[str, str] | None) -> int:
    """How wide one output line may be, from `BC_LINE_LENGTH`.

    Unset, or set below 3 but not to 0, it is GNU's default of 70; 0
    folds nothing.

    Args:
        env (Mapping[str, str] | None): the session environment, or None
            outside a workspace, where the default applies.

    Returns:
        int: the width, or 0 for no folding.
    """
    raw = None if env is None else env.get(constants.LINE_LENGTH_VAR)
    if raw is None:
        return constants.DEFAULT_LINE_LENGTH
    size = c_atoi(raw)
    if size != 0 and size < constants.MIN_LINE_LENGTH:
        return constants.DEFAULT_LINE_LENGTH
    return size


def column_width(char: str) -> int:
    """How far one written character moves GNU's output column.

    Args:
        char (str): one character.

    Returns:
        int: its UTF-8 byte length, 1 to 4.
    """
    point = ord(char)
    if point < constants.UTF8_TWO_BYTES:
        return 1
    if point < constants.UTF8_THREE_BYTES:
        return 2
    if point < constants.UTF8_FOUR_BYTES:
        return 3
    return 4


@dataclass(slots=True)
class OutputColumn:
    """How full the current output line is, in bytes.

    One counter for the whole run, not one per value: `print` ends in no
    newline, so a string it wrote moves the column a later value folds
    at. Only written output folds; a diagnostic never does.

    Args:
        line_length (int): the width from `output_line_length`; 0 folds
            nothing, however long the output is.
        col (int): bytes already written on the current line.
    """

    line_length: int
    col: int = 0

    def write(self, text: str) -> str:
        """Fold `text` into the output and advance the column.

        Args:
            text (str): the characters to write.

        Returns:
            str: the characters with a backslash and a newline at every
                break. A newline in `text` starts the line over, so an
                expression statement's own newline is what makes the next
                value begin at the left margin.
        """
        out: list[str] = []
        for char in text:
            if char == "\n":
                self.col = 0
                out.append(char)
                continue
            width = column_width(char)
            # A folded line carries `line_length - 2` bytes and then a
            # backslash, so the default 70 puts 68 of them on a line and
            # makes it 69 wide. A character that would cross that
            # boundary moves whole to the next line; GNU, writing one
            # byte at a time, splits it there instead and emits bytes
            # that are no longer UTF-8. The fold lands in the same place
            # whenever a character does not straddle it, which is every
            # ASCII one. The `col != 0` guard keeps a character wider
            # than the whole line from folding forever.
            if (
                self.line_length != 0
                and self.col != 0
                and self.col + width > self.line_length - 2
            ):
                out.append("\\\n")
                self.col = 0
            out.append(char)
            self.col += width
        return "".join(out)


def fixed_digits(num: BcNumber) -> str:
    digits = integer_text(abs(num.coefficient)).rjust(num.scale + 1, "0")
    if num.scale:
        digits = digits[: -num.scale] + "." + digits[-num.scale :]
    return ("-" if num.coefficient < 0 else "") + digits


def render_in_base(num: BcNumber, obase: int) -> str:
    denominator = 10**num.scale
    whole, rest = divmod(abs(num.coefficient), denominator)
    before: list[int] = []
    while whole:
        whole, digit = divmod(whole, obase)
        before.append(digit)
    before.reverse()
    after: list[int] = []
    factor = 1
    while factor < denominator:
        digit, rest = divmod(rest * obase, denominator)
        after.append(digit)
        factor *= obase
    if obase <= constants.MAX_CHAR_BASE:
        text = "".join(constants.BASE_DIGITS[d] for d in before)
        if after:
            text += "." + "".join(constants.BASE_DIGITS[d] for d in after)
    else:
        width = len(str(obase - 1))
        text = "".join(f" {d:0{width}d}" for d in before)
        if after:
            text += "." + " ".join(f"{d:0{width}d}" for d in after)
    return text or "0"


def render_number(num: BcNumber, obase: int) -> str:
    if num.coefficient == 0:
        return "0"
    if obase == constants.DEFAULT_BASE:
        text = fixed_digits(num)
    else:
        text = ("-" if num.coefficient < 0 else "") + render_in_base(
            num, obase
        )
    if text.startswith("0."):
        return text[1:]
    if text.startswith("-0."):
        return "-" + text[2:]
    return text

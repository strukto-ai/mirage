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

from mirage.core.awk.errors import AwkRuntimeError
from mirage.core.awk.regex import compile_ere, split_pattern
from mirage.core.awk.value import Value, ValueKind, to_int, to_num, to_str

FLAG_CHARS = "-+ #0"
INT_CONVS = "diouxX"
FLOAT_CONVS = "eEfFgGaA"
DIGITS = "0123456789"
BLANKS = " \t\n"
BLANK_RUN = re.compile(r"[ \t\n]+")
UINT64_MASK = (1 << 64) - 1
MAX_CODE_POINT = 0x10FFFF
SURROGATES = range(0xD800, 0xE000)
RAND_MASK = 0xFFFFFFFF
RAND_SCALE = 4294967296.0


def substr(subject: str, start: float, length: float | None) -> str:
    """Take an awk substring.

    Positions are 1-based and truncated toward zero. A start below 1 is
    clamped to 1 and the requested length is still honoured in full, so
    substr("hello", -1, 3) is "hel". That is what gawk and onetrueawk
    both do; mawk instead counts the span from the original start.

    Args:
        subject (str): the source string.
        start (float): 1-based start position, truncated toward zero.
        length (float | None): span length, or None for the remainder.
    """
    begin = max(to_int(start), 1)
    if length is None:
        return subject[begin - 1:]
    span = to_int(length)
    if span <= 0:
        return ""
    return subject[begin - 1:begin - 1 + span]


def expand_replacement(template: str, matched: str) -> str:
    """Expand ``&`` in a sub/gsub replacement.

    ``\\&`` is a literal ampersand and ``\\\\&`` is a backslash followed by
    the match; any other backslash is itself, which is what gawk, mawk
    and onetrueawk all do.

    Args:
        template (str): the replacement text as awk sees it.
        matched (str): the text the pattern matched.
    """
    out: list[str] = []
    idx = 0
    while idx < len(template):
        ch = template[idx]
        if ch == "\\" and idx + 1 < len(template):
            nxt = template[idx + 1]
            if nxt == "&":
                out.append("&")
                idx += 2
                continue
            if nxt == "\\" and template.startswith("&", idx + 2):
                out.append("\\" + matched)
                idx += 3
                continue
            out.append(ch)
            idx += 1
            continue
        if ch == "&":
            out.append(matched)
            idx += 1
            continue
        out.append(ch)
        idx += 1
    return "".join(out)


def substitute(pattern: str, template: str, subject: str,
               globally: bool) -> tuple[int, str]:
    """Perform awk sub/gsub, returning the count and the new string.

    Args:
        pattern (str): the ERE to match.
        template (str): replacement text, with ``&`` support.
        subject (str): the string to operate on.
        globally (bool): true for gsub, false for sub.

    Returns:
        tuple[int, str]: number of replacements and the result.
    """
    compiled = compile_ere(pattern)
    out: list[str] = []
    count = 0
    pos = 0
    last_end = -1
    while pos <= len(subject):
        found = compiled.search(subject, pos)
        if found is None:
            break
        out.append(subject[pos:found.start()])
        empty = found.end() == found.start()
        # An empty match touching the previous match is not a match:
        # gsub(/l*/, "-") turns "hello" into "-h-e-o-", not "-h-e--o-".
        if not (empty and found.start() == last_end):
            out.append(expand_replacement(template, found.group(0)))
            count += 1
        if empty:
            # An empty match must still advance, or gsub would spin on
            # patterns like /a*/ forever.
            if found.start() < len(subject):
                out.append(subject[found.start()])
            pos = found.start() + 1
        else:
            pos = found.end()
            last_end = pos
        if not globally:
            break
    out.append(subject[pos:] if pos <= len(subject) else "")
    return count, "".join(out)


def match_position(pattern: str, subject: str) -> tuple[int, int]:
    """Locate an ERE in a subject for the match() builtin.

    Args:
        pattern (str): the ERE to search for.
        subject (str): the text to search.

    Returns:
        tuple[int, int]: RSTART (1-based, 0 on failure) and RLENGTH
            (-1 on failure).
    """
    found = compile_ere(pattern).search(subject)
    if found is None:
        return 0, -1
    return found.start() + 1, found.end() - found.start()


def safe_log(value: float) -> float:
    """Natural log with C's edges: -inf at zero, NaN below it.

    Args:
        value (float): the argument.
    """
    if math.isnan(value) or value < 0:
        return math.nan
    if value == 0:
        return -math.inf
    return math.log(value)


def safe_sqrt(value: float) -> float:
    """Square root that answers NaN for a negative argument.

    Args:
        value (float): the argument.
    """
    if math.isnan(value) or value < 0:
        return math.nan
    return math.sqrt(value)


def safe_exp(value: float) -> float:
    """Exponential that overflows to infinity instead of raising.

    Args:
        value (float): the argument.
    """
    try:
        return math.exp(value)
    except OverflowError:
        return math.inf


def safe_trig(value: float, fn: str) -> float:
    """Sine or cosine that answers NaN for an infinite argument.

    Args:
        value (float): the argument.
        fn (str): ``sin`` or ``cos``.
    """
    if math.isinf(value) or math.isnan(value):
        return math.nan
    return math.sin(value) if fn == "sin" else math.cos(value)


def safe_pow(base: float, exponent: float) -> float:
    """Raise to a power with C's edges instead of Python's exceptions.

    Args:
        base (float): the base.
        exponent (float): the exponent.
    """
    negative = (math.copysign(1.0, base) < 0 and math.isfinite(exponent)
                and exponent == int(exponent) and int(exponent) % 2 == 1)
    try:
        return math.pow(base, exponent)
    except OverflowError:
        return -math.inf if negative else math.inf
    except ValueError:
        if base == 0:
            return -math.inf if negative else math.inf
        return math.nan


def safe_fmod(left: float, right: float) -> float:
    """C fmod that answers NaN for an infinite dividend.

    Args:
        left (float): the dividend.
        right (float): the divisor, never zero.
    """
    if math.isinf(left) or math.isnan(left) or math.isnan(right):
        return math.nan
    return math.fmod(left, right)


def next_random(state: int) -> tuple[int, float]:
    """Advance the mulberry32 generator behind rand().

    Both hosts run the same 32-bit generator, so a seeded program prints
    the same numbers under Python and TypeScript.

    Args:
        state (int): the 32-bit generator state.

    Returns:
        tuple[int, float]: the next state and a number in [0, 1).
    """
    state = (state + 0x6D2B79F5) & RAND_MASK
    mixed = state
    mixed = ((mixed ^ (mixed >> 15)) * (mixed | 1)) & RAND_MASK
    mixed ^= (mixed + (((mixed ^ (mixed >> 7)) * (mixed | 61)) & RAND_MASK))
    mixed &= RAND_MASK
    return state, ((mixed ^ (mixed >> 14)) & RAND_MASK) / RAND_SCALE


def read_spec(fmt: str, idx: int) -> tuple[str, str, str, str, int]:
    """Read one printf conversion specification.

    Args:
        fmt (str): the whole format string.
        idx (int): index of the character after ``%``.

    Returns:
        tuple[str, str, str, str, int]: flags, width, precision,
            conversion character, and the index just past the spec.
    """
    flags = ""
    while idx < len(fmt) and fmt[idx] in FLAG_CHARS:
        flags += fmt[idx]
        idx += 1
    width = ""
    if idx < len(fmt) and fmt[idx] == "*":
        width = "*"
        idx += 1
    else:
        while idx < len(fmt) and fmt[idx] in DIGITS:
            width += fmt[idx]
            idx += 1
    precision = ""
    if idx < len(fmt) and fmt[idx] == ".":
        precision = "."
        idx += 1
        if idx < len(fmt) and fmt[idx] == "*":
            precision = ".*"
            idx += 1
        else:
            while idx < len(fmt) and fmt[idx] in DIGITS:
                precision += fmt[idx]
                idx += 1
    conv = fmt[idx] if idx < len(fmt) else ""
    return flags, width, precision, conv, idx + 1


def render_char(value: Value, convfmt: str) -> str:
    """Render a value for the %c conversion.

    A numeric value becomes the character with that code; a string
    contributes its first character.

    Args:
        value (Value): the argument.
        convfmt (str): CONVFMT for number to string conversion.
    """
    if value.kind is ValueKind.NUM:
        code = to_int(value.num)
        if code < 0 or code > MAX_CODE_POINT or code in SURROGATES:
            return ""
        return chr(code)
    body = to_str(value, convfmt)
    return body[0] if body else ""


def sprintf(fmt: str, args: list[Value], convfmt: str) -> str:
    """Format values the way awk's printf and sprintf do.

    Args:
        fmt (str): the format string.
        args (list[Value]): the conversion arguments.
        convfmt (str): CONVFMT for number to string conversion.

    Returns:
        str: the formatted text.
    """
    out: list[str] = []
    pending = list(args)
    idx = 0
    while idx < len(fmt):
        ch = fmt[idx]
        if ch != "%":
            out.append(ch)
            idx += 1
            continue
        if fmt.startswith("%%", idx):
            out.append("%")
            idx += 2
            continue
        flags, width, precision, conv, idx = read_spec(fmt, idx + 1)
        if conv == "":
            out.append("%")
            continue
        if width == "*":
            star = to_int(to_num(take_arg(pending, fmt)))
            if star < 0:
                flags += "-"
            width = str(abs(star))
        if precision == ".*":
            star = to_int(to_num(take_arg(pending, fmt)))
            precision = "." + str(star) if star >= 0 else ""
        if conv not in "cs" and conv not in INT_CONVS + FLOAT_CONVS:
            out.append("%" + flags + width + precision + conv)
            continue
        arg = take_arg(pending, fmt)
        out.append(render_one(flags, width, precision, conv, arg, convfmt))
    return "".join(out)


def take_arg(pending: list[Value], fmt: str) -> Value:
    """Pop the next printf argument, failing when the format outruns them.

    gawk, mawk and onetrueawk all treat a format with more conversions
    than arguments as fatal rather than padding with empties.

    Args:
        pending (list[Value]): remaining arguments, consumed from the front.
        fmt (str): the format string, for the error message.
    """
    if not pending:
        raise AwkRuntimeError(
            f"awk: not enough arguments to satisfy format string '{fmt}'")
    return pending.pop(0)


def pad(prefix: str, body: str, flags: str, width: str, zero: bool) -> str:
    """Pad one conversion to its field width.

    Args:
        prefix (str): the sign or radix prefix, kept left of zero padding.
        body (str): the digits or text.
        flags (str): the flag characters.
        width (str): the field width, possibly empty.
        zero (bool): whether the ``0`` flag may apply to this conversion.
    """
    joined = prefix + body
    if not width or len(joined) >= int(width):
        return joined
    gap = int(width) - len(joined)
    if "-" in flags:
        return joined + " " * gap
    if zero and "0" in flags:
        return prefix + "0" * gap + body
    return " " * gap + joined


def render_int(flags: str, width: str, precision: str, conv: str,
               value: int) -> str:
    """Render one integer conversion with C's flag rules.

    ``%d`` keeps the exact integer; ``%o %u %x %X`` read a negative
    number as its 64-bit two's complement, the way C does.

    Args:
        flags (str): the flag characters.
        width (str): the field width, possibly empty.
        precision (str): the precision including its dot, possibly empty.
        conv (str): one of ``d i o u x X``.
        value (int): the truncated argument.
    """
    prefix = ""
    if conv in "di":
        digits = str(abs(value))
        if value < 0:
            prefix = "-"
        elif "+" in flags:
            prefix = "+"
        elif " " in flags:
            prefix = " "
    else:
        wrapped = value & UINT64_MASK
        if conv == "o":
            digits = format(wrapped, "o")
        elif conv in "xX":
            digits = format(wrapped, "x")
        else:
            digits = str(wrapped)
    if precision:
        wanted = int(precision[1:] or "0")
        if wanted == 0 and digits.strip("0") == "":
            digits = ""
        else:
            digits = digits.rjust(wanted, "0")
    nonzero = digits.strip("0") != ""
    if "#" in flags:
        if conv == "x" and nonzero:
            prefix = "0x"
        elif conv == "X" and nonzero:
            prefix = "0X"
        elif conv == "o" and not digits.startswith("0"):
            digits = "0" + digits
    if conv == "X":
        digits = digits.upper()
    return pad(prefix, digits, flags, width, not precision)


def render_one(flags: str, width: str, precision: str, conv: str, arg: Value,
               convfmt: str) -> str:
    """Render a single printf conversion.

    Args:
        flags (str): the flag characters.
        width (str): the field width, possibly empty.
        precision (str): the precision including its dot, possibly empty.
        conv (str): the conversion character.
        arg (Value): the argument to render.
        convfmt (str): CONVFMT for number to string conversion.
    """
    if conv in "cs":
        body = (render_char(arg, convfmt) if conv == "c" else to_str(
            arg, convfmt))
        if conv == "s" and precision:
            body = body[:int(precision[1:] or "0")]
        return pad("", body, flags, width, False)
    if conv in INT_CONVS:
        return render_int(flags, width, precision, conv, to_int(to_num(arg)))
    target = {"a": "g", "A": "G"}.get(conv, conv)
    return ("%" + flags + width + precision + target) % to_num(arg)


def split_fields(record: str, pattern: re.Pattern[str] | None) -> list[str]:
    """Split a record into fields.

    Args:
        record (str): the record text.
        pattern (re.Pattern[str] | None): the separator pattern, or None
            for the default rule of runs of blanks with the ends trimmed.
    """
    if pattern is None:
        trimmed = record.strip(BLANKS)
        return BLANK_RUN.split(trimmed) if trimmed else []
    if not record:
        return []
    fields: list[str] = []
    start = 0
    pos = 0
    while pos <= len(record):
        found = pattern.search(record, pos)
        if found is None:
            break
        if found.end() == found.start():
            # A separator that matches nothing separates nothing.
            pos = found.start() + 1
            continue
        fields.append(record[start:found.start()])
        start = found.end()
        pos = start
    fields.append(record[start:])
    return fields


def split_record(record: str,
                 separator: str,
                 paragraph: bool = False) -> list[str]:
    """Split a record using an FS value.

    An empty FS makes every character its own field; gawk, mawk and
    onetrueawk all agree on that even though POSIX leaves it undefined.
    A record read in paragraph mode also splits at each newline when FS
    is a single character, as in gawk and onetrueawk; a regex FS and
    split() do not.

    Args:
        record (str): the record text.
        separator (str): the FS value.
        paragraph (bool): whether the record was read with an empty RS.
    """
    if separator == "":
        return list(record)
    if paragraph and len(separator) == 1:
        return split_fields(record.replace("\n", separator),
                            split_pattern(separator))
    return split_fields(record, split_pattern(separator))


def take_tail(buffer: str, start: int, final: bool) -> tuple[str | None, int]:
    """Hand out what is left of the input as its last record.

    Args:
        buffer (str): the decoded input.
        start (int): where the record starts in ``buffer``.
        final (bool): whether the input is exhausted.
    """
    if final and start < len(buffer):
        return buffer[start:], len(buffer)
    return None, start


def take_paragraph(buffer: str, start: int,
                   final: bool) -> tuple[str | None, int]:
    """Cut the next record in paragraph mode, where RS is empty.

    Records are separated by blank lines, and leading or trailing
    newlines never make an empty record. The whole run of newlines is
    the separator, so a run that reaches the end of the buffer waits for
    more input before the record is handed out.

    Args:
        buffer (str): the decoded input.
        start (int): where the record starts in ``buffer``.
        final (bool): whether the input is exhausted.
    """
    while start < len(buffer) and buffer[start] == "\n":
        start += 1
    end = buffer.find("\n\n", start)
    if end >= 0:
        stop = end + 2
        while stop < len(buffer) and buffer[stop] == "\n":
            stop += 1
        if stop < len(buffer) or final:
            return buffer[start:end], stop
        return None, start
    if not final or start == len(buffer):
        return None, start
    end = len(buffer) - 1 if buffer.endswith("\n") else len(buffer)
    return buffer[start:end], len(buffer)


def take_record(buffer: str, start: int, separator: str,
                final: bool) -> tuple[str | None, int]:
    """Cut the next record out of ``buffer`` with an RS value.

    A single character RS separates records literally and an empty RS
    is paragraph mode. A longer RS is an ERE, as in gawk, mawk and
    onetrueawk, where a match of nothing separates nothing. Until the
    input is exhausted a separator that reaches the end of the buffer
    could still grow, so that record waits for more input.

    Args:
        buffer (str): the decoded input.
        start (int): where the record starts in ``buffer``.
        separator (str): the RS value.
        final (bool): whether the input is exhausted.

    Returns:
        tuple[str | None, int]: the record, or None when ``buffer`` holds
        no complete one, and where the next record starts.
    """
    if separator == "":
        return take_paragraph(buffer, start, final)
    if len(separator) == 1:
        end = buffer.find(separator, start)
        if end >= 0:
            return buffer[start:end], end + len(separator)
        return take_tail(buffer, start, final)
    pattern = compile_ere(separator)
    pos = start
    while pos <= len(buffer):
        found = pattern.search(buffer, pos)
        if found is None:
            break
        if found.end() == found.start():
            pos = found.start() + 1
            continue
        if found.end() == len(buffer) and not final:
            return None, start
        return buffer[start:found.start()], found.end()
    return take_tail(buffer, start, final)


__all__ = [
    "expand_replacement",
    "match_position",
    "next_random",
    "pad",
    "read_spec",
    "render_char",
    "render_int",
    "render_one",
    "safe_exp",
    "safe_fmod",
    "safe_log",
    "safe_pow",
    "safe_sqrt",
    "safe_trig",
    "split_fields",
    "split_record",
    "sprintf",
    "substitute",
    "substr",
    "take_arg",
    "take_paragraph",
    "take_record",
    "take_tail",
]

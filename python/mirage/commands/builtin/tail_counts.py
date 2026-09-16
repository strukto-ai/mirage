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

from mirage.commands.builtin.utils.size_suffix import size_suffixes
from mirage.commands.quote import quote_text

_NUMBER_RE = re.compile(r"^[+-]?[0-9]+$")
# C `strtod` as `xstrtod` uses it, anchored at both ends because
# `xstrtod` refuses any leftover: optional LEADING whitespace (isspace,
# so CR and TAB count), a sign, then a decimal number, a C99 hex number,
# `inf`/`infinity` or `nan`, case-insensitively. Trailing whitespace is
# NOT part of it, which is the whole reason this exists -- python's
# `float()` and JavaScript's `Number()` both strip it, so both hosts
# accepted `tail -s $'1\r'` where GNU answers
# `invalid number of seconds: '1\r'` (measured, coreutils 9.4).
_STRTOD_RE = re.compile(
    r"""^[ \t\n\v\f\r]*[+-]?(?:
            (?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?
          | 0[xX](?:[0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?|\.[0-9a-fA-F]+)
            (?:[pP][+-]?[0-9]+)?
          | inf(?:inity)?
          | nan(?:\([0-9A-Za-z_]*\))?
        )$""", re.VERBOSE | re.IGNORECASE)
_HEX_RE = re.compile(r"^[ \t\n\v\f\r]*[+-]?0[xX]")
_NAN_RE = re.compile(r"^[ \t\n\v\f\r]*[+-]?nan", re.IGNORECASE)
_BYTE_RE = re.compile(r"^([+-]?)([0-9]+)([A-Za-z]*)$")
_BYTE_UNITS = {"": 1, **size_suffixes("bkKMGTPEZYRQ")}


def parse_byte_count(raw: str) -> int:
    """Parse GNU head/tail byte counts, including size suffixes."""
    match = _BYTE_RE.match(raw)
    if match is None:
        raise ValueError(raw)
    sign, digits, suffix = match.groups()
    multiplier = _BYTE_UNITS.get(suffix)
    if multiplier is None:
        raise ValueError(raw)
    count = int(digits) * multiplier
    return -count if sign == "-" else count


def parse_seconds(raw: str) -> float | None:
    """``tail -s``'s value, exactly as C ``strtod`` reads it, or None.

    GNU refuses the value when ``xstrtod`` does not consume all of it or
    when ``0 <= s`` is false, so the grammar and the range are two
    separate answers: ``inf`` is ACCEPTED (``0 <= inf``) while ``nan``
    is refused (``0 <= nan`` is false), and both were measured on
    coreutils 9.4. This returns the number the grammar names and leaves
    the range test to the caller, which is where GNU puts it too.

    Args:
        raw (str): the ``-s`` value as typed.

    Returns:
        float | None: the value, or None when the grammar refuses it.
    """
    if _STRTOD_RE.match(raw) is None:
        return None
    text = raw.strip(" \t\n\v\f\r")
    if _NAN_RE.match(raw) is not None:
        # glibc takes `nan(chars)` too, and every spelling of it is the
        # same quiet NaN; `float()` reads only the bare word.
        return math.nan
    if _HEX_RE.match(raw) is not None:
        # `float()` reads no hex float at all, and `float.fromhex` reads
        # every spelling the regex just allowed (`0x10`, `0x10.8`,
        # `0x.8p1`).
        return float.fromhex(text)
    return float(text)


def number_flag_error(cmd: str, n_raw: str | None,
                      c_raw: str | None) -> str | None:
    if n_raw is not None and not _NUMBER_RE.match(n_raw):
        return f"{cmd}: invalid number of lines: '{quote_text(n_raw)}'\n"
    if c_raw is not None:
        try:
            parse_byte_count(c_raw)
        except ValueError:
            return (f"{cmd}: invalid number of bytes: '{quote_text(c_raw)}'\n")
    return None


def _parse_n(n: str | None) -> tuple[int, bool]:
    if n is None:
        return 10, False
    if n.startswith("+"):
        return int(n[1:]), True
    return int(n), False


@dataclass(frozen=True, slots=True)
class TailCounts:
    lines: int | None = None
    from_line: int | None = None
    byte_count: int | None = None
    from_byte: int | None = None


def parse_counts(n: str | None, c: str | None) -> TailCounts:
    """Split tail's ``-n``/``-c`` values by which end they count from.

    GNU gives both flags the same sign grammar: a leading ``+`` counts
    forward from the start of the input, 1-indexed, so ``+0`` and ``+1``
    both mean the whole thing; any other spelling counts back from the
    end. Every caller used to apply that grammar to ``-n`` and take the
    absolute value of ``-c``, which silently turned ``tail -c +3`` into
    the last three bytes -- so the split lives here, once, beside the
    parser it is built from.

    Args:
        n (str | None): the raw ``-n`` value, or None when unset.
        c (str | None): the raw ``-c`` value, or None when unset.
    """
    lines: int | None = None
    from_line: int | None = None
    if n is not None:
        count, plus_mode = _parse_n(n)
        if plus_mode:
            from_line = count
        else:
            lines = count
    byte_count: int | None = None
    from_byte: int | None = None
    if c is not None:
        count = parse_byte_count(c)
        plus_mode = c.startswith("+")
        if plus_mode:
            from_byte = count
        else:
            byte_count = count
    return TailCounts(lines, from_line, byte_count, from_byte)

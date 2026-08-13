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

from mirage.utils.generated.width_data import WHITESPACE, WIDE, ZERO_WIDTH

TAB_WIDTH = 8

_CONTROL = ((0x00, 0x1F), (0x7F, 0x9F))


def _in_ranges(cp: int, ranges: tuple[tuple[int, int], ...]) -> bool:
    lo_index, hi_index = 0, len(ranges) - 1
    while lo_index <= hi_index:
        mid = (lo_index + hi_index) // 2
        lo, hi = ranges[mid]
        if cp < lo:
            hi_index = mid - 1
        elif cp > hi:
            lo_index = mid + 1
        else:
            return True
    return False


def char_width(ch: str) -> int:
    """How many terminal columns *ch* occupies.

    Mirrors what glibc's ``wcwidth`` reports to GNU ``wc -L``: 2 for an East
    Asian wide or fullwidth character, 0 for a combining mark, a Hangul jamo
    medial or final, or one of the zero-width format characters, and 1 for
    everything else. A control character measures 0, which is how ``wc``
    accounts for ``wcwidth``'s -1; callers handle tab, newline, carriage
    return and form feed themselves, since those move the cursor rather than
    occupy a column.

    Divergence: an unassigned code point measures 1 here and 0 in glibc,
    which would need the assigned-character set on top of the width table.

    Args:
        ch (str): A single character.

    Returns:
        int: 0, 1, or 2 columns.
    """
    cp = ord(ch)
    if _in_ranges(cp, _CONTROL):
        return 0
    if _in_ranges(cp, ZERO_WIDTH):
        return 0
    return 2 if _in_ranges(cp, WIDE) else 1


def is_space(ch: str) -> bool:
    """Whether *ch* separates words for ``wc -w``.

    GNU splits on glibc's ``iswspace``, which is Unicode White_Space minus
    U+0085. ``str.isspace`` is not that set: it also reports True for
    U+001C-U+001F and U+0085, so ``wc -w`` over-counted words containing
    them. The generated table is the pinned set.

    Args:
        ch (str): A single character.

    Returns:
        bool: True when GNU would break a word here.
    """
    return _in_ranges(ord(ch), WHITESPACE)


def advance_column(column: int, ch: str) -> int:
    """Move *column* past *ch*, GNU ``wc -L`` style.

    A tab jumps to the next multiple of ``TAB_WIDTH`` -- so a tab in column
    0 lands on 8, which is why ``printf 'a\\tb' | wc -L`` is 9 and not 3.
    Carriage return and form feed return the cursor to column 0 rather than
    ending the line, so ``printf 'a\\rb' | wc -L`` is 1. Callers handle the
    newline, which ends the line outright.

    Args:
        column (int): The current column.
        ch (str): The next character, never a newline.

    Returns:
        int: The column after *ch*.
    """
    if ch in ("\r", "\f"):
        return 0
    if ch == "\t":
        return column + TAB_WIDTH - (column % TAB_WIDTH)
    return column + char_width(ch)

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

import re

from mirage.commands.builtin.constants import C_SPACE

# The leading decimal run C's atoi reads, after blanks and one sign.
DECIMAL = re.compile(rf"{C_SPACE}([+-]?)([0-9]+)")
LONG_MIN = -(2**63)
LONG_MAX = 2**63 - 1
INT_MAX = 2**31 - 1


def atoi(text: str) -> int:
    """C's ``atoi``: the decimal number ``text`` begins with, after C
    blanks and one sign, 0 when it begins with none, saturated to the
    ``long`` range as glibc's ``strtol`` underneath it is.

    Args:
        text (str): the text, as a variable holds it.
    """
    match = DECIMAL.match(text)
    if match is None:
        return 0
    negative = match.group(1) == "-"
    limit = -LONG_MIN if negative else LONG_MAX
    value = bounded_decimal(match.group(2), limit + 1)
    magnitude = limit if value is None else value
    return -magnitude if negative else magnitude


def bounded_decimal(digits: str, bound: int) -> int | None:
    """ASCII decimal ``digits`` as a number, None when it is ``bound`` or
    more.

    Leading zeros go first and a run longer than the bound is refused by
    its length, so however many digits are typed, the conversion only
    ever sees as many as the bound has.

    Args:
        digits (str): ASCII decimal digits, no sign.
        bound (int): the least value refused.
    """
    significant = digits.lstrip("0")
    if len(significant) > len(str(bound)):
        return None
    value = int(significant or "0")
    return value if value < bound else None


__all__ = ["INT_MAX", "atoi", "bounded_decimal"]

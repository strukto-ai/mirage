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

from os.path import commonprefix

# The order glibc documents for strverscmp: text compares character by
# character, but when the first difference falls inside a run of digits the
# two whole runs compare as numbers, and a run that starts with "0" (longer
# than "0" itself) is a fraction that sorts before every whole number:
# 000 < 00 < 01 < 010 < 09 < 0 < 1 < 9 < 10. Measured against glibc 2.41
# on 637,100 random pairs: while the runs agree on zeros only, the one that
# stops sorts after the one that goes on ("00" > "001", "000" < "00").


def _digit(char: str) -> bool:
    return len(char) == 1 and "0" <= char <= "9"


def _digits_from(text: str, start: int) -> str:
    end = start
    while end < len(text) and _digit(text[end]):
        end += 1
    return text[start:end]


def _is_fraction(run: str) -> bool:
    return len(run) > 1 and run[0] == "0"


def _order(x: str, y: str) -> int:
    return (x > y) - (x < y)


def strverscmp(a: str, b: str) -> int:
    """Compare two strings in version order, as glibc's ``strverscmp``.

    Args:
        a (str): the first string.
        b (str): the second string.

    Returns:
        int: negative, zero or positive as ``a`` sorts before, level with
        or after ``b``.
    """
    if a == b:
        return 0
    split = len(commonprefix([a, b]))
    left, right = a[split : split + 1], b[split : split + 1]
    head = split
    while head > 0 and _digit(a[head - 1]):
        head -= 1
    run_a = _digits_from(a, head)
    run_b = _digits_from(b, head)
    if not run_a or not run_b:
        return _order(left, right)
    fraction_a, fraction_b = _is_fraction(run_a), _is_fraction(run_b)
    if fraction_a != fraction_b:
        return -1 if fraction_a else 1
    if not fraction_a and len(run_a) != len(run_b):
        return -1 if len(run_a) < len(run_b) else 1
    if fraction_a and not a[head:split].strip("0"):
        if _digit(left) != _digit(right):
            return -1 if _digit(left) else 1
    return _order(left, right)

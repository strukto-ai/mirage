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

# glibc strverscmp's automaton: a state per kind of run (none, integral,
# fractional, leading zeros), and what the first differing pair of
# characters decides in each, by the class of each (other, digit, zero).
S_N, S_I, S_F, S_Z = 0, 3, 6, 9
CMP, LEN = 2, 3
NEXT_STATE = (S_N, S_I, S_Z, S_N, S_I, S_I, S_N, S_F, S_F, S_N, S_F, S_Z)
RESULT_TYPE = (
    *(CMP, CMP, CMP, CMP, LEN, CMP, CMP, CMP, CMP),
    *(CMP, -1, -1, 1, LEN, LEN, 1, LEN, LEN),
    *(CMP, CMP, CMP, CMP, CMP, CMP, CMP, CMP, CMP),
    *(CMP, 1, 1, -1, CMP, CMP, -1, CMP, CMP),
)


def _char_at(text: str, i: int) -> str:
    """A C string's character at ``i``, NUL past its end.

    Args:
        text (str): the string.
        i (int): the index.
    """
    return text[i] if i < len(text) else "\0"


def _digit_class(char: str) -> int:
    return (char == "0") + ("0" <= char <= "9")


def strverscmp(a: str, b: str) -> int:
    """glibc's ``strverscmp``: compare as versions, ``v1.9`` before
    ``v1.10``.

    A digit run compares by its value, and one with a leading zero as a
    fraction that sorts first: ``000 < 00 < 01 < 010 < 09 < 0 < 1``.
    Only the sign of the result means anything.

    Args:
        a (str): the first value.
        b (str): the second value.
    """
    i = 0
    c1, c2 = _char_at(a, 0), _char_at(b, 0)
    state = S_N + _digit_class(c1)
    while c1 == c2:
        if c1 == "\0":
            return 0
        state = NEXT_STATE[state]
        i += 1
        c1, c2 = _char_at(a, i), _char_at(b, i)
        state += _digit_class(c1)
    diff = ord(c1) - ord(c2)
    result = RESULT_TYPE[state * 3 + _digit_class(c2)]
    if result == CMP:
        return diff
    if result == LEN:
        k = i + 1
        while _digit_class(_char_at(a, k)):
            if not _digit_class(_char_at(b, k)):
                return 1
            k += 1
        return -1 if _digit_class(_char_at(b, k)) else diff
    return result

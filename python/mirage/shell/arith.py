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


def plain_decimal(text: str) -> int | None:
    """``text`` as a plain decimal (ASCII digits, no leading ``0``, which
    would read as octal), wrapped to 64 bits; None when it is anything
    else and has to be evaluated.

    Args:
        text (str): a stored value or a subscript.
    """
    number = text.strip(" \t\n")
    if not (number.isdecimal() and number.isascii() and number[0] != "0"):
        return None
    value = 0
    for ch in number:
        value = (value * 10 + ord(ch) - 48) & 0xFFFFFFFFFFFFFFFF
    return value - (1 << 64) if value >> 63 else value

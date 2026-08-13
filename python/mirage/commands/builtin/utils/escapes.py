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

_SIMPLE_ESCAPES = {
    "a": "\a",
    "b": "\b",
    "f": "\f",
    "n": "\n",
    "r": "\r",
    "t": "\t",
    "v": "\v",
    "\\": "\\",
}

_OCTAL_DIGITS = frozenset("01234567")

_MAX_OCTAL = 0o400


def interpret_escapes(text: str) -> str:
    """Read one of tr's SET operands, resolving backslash escapes.

    This is tr's grammar, which is narrower than the shell's in two ways
    and wider in one. tr has no ``\\xHH`` and no ``\\c``: both are ordinary
    unknown escapes. An unknown escape *drops* the backslash and keeps the
    letter, where ``echo -e`` passes ``\\z`` through unchanged -- so
    ``tr '\\x41' -`` deletes ``x``, ``4`` and ``1``, not ``A``. Octal is
    written ``\\NNN`` with no leading zero required, greedy to three digits,
    so ``\\0141`` is ``\\014`` followed by a literal ``1``. A three-digit
    value above 255 is ambiguous; GNU backs off to the first two digits and
    leaves the third as a literal.

    Not covered: GNU also writes a warning to stderr for that ambiguous
    case (exit status is unaffected), which this pure reader has no channel
    for. Values 128-255 name a byte in GNU and a code point here, which is
    the same str-vs-bytes limit the rest of tr already carries.

    Args:
        text (str): One SET operand as typed on the command line.

    Returns:
        str: The operand with every escape sequence resolved.
    """
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        if text[i] != "\\" or i + 1 >= n:
            out.append(text[i])
            i += 1
            continue
        ch = text[i + 1]
        if ch in _SIMPLE_ESCAPES:
            out.append(_SIMPLE_ESCAPES[ch])
            i += 2
        elif ch in _OCTAL_DIGITS:
            digits = ""
            j = i + 1
            while j < n and len(digits) < 3 and text[j] in _OCTAL_DIGITS:
                digits += text[j]
                j += 1
            if len(digits) == 3 and int(digits, 8) >= _MAX_OCTAL:
                digits = digits[:2]
                j -= 1
            out.append(chr(int(digits, 8)))
            i = j
        else:
            out.append(ch)
            i += 2
    return "".join(out)

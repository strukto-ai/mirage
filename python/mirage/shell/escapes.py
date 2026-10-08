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

import shlex

from mirage.shell.bytes import byte_char, decode_text, encode_text

# The ANSI-C escape table bash decodes $'...' with. \e/\E
# are here although printf lacks them; \c takes an argument here while
# printf's \c means stop, which is why the printf reader is not reused.
_SIMPLE: dict[str, str] = {
    "a": "\a",
    "b": "\b",
    "e": "\x1b",
    "E": "\x1b",
    "f": "\f",
    "n": "\n",
    "r": "\r",
    "t": "\t",
    "v": "\v",
    "\\": "\\",
    "'": "'",
    '"': '"',
    "?": "?",
}
_HEX = "0123456789abcdefABCDEF"
_OCTAL = "01234567"


def _scan_hex(content: str, start: int, limit: int) -> tuple[str, int]:
    """Collect up to ``limit`` hex digits.

    Args:
        content (str): the string body being decoded.
        start (int): index of the first candidate digit.
        limit (int): most digits this escape accepts.
    """
    end = start
    while end < len(content) and end - start < limit and content[end] in _HEX:
        end += 1
    return content[start:end], end


def _u32_utf8(value: int) -> bytes:
    """bash's UTF-8 encoding of an escape's value past ASCII.

    UTF-8-shaped bytes for any 32-bit value: surrogate halves encode
    like ordinary three-byte characters, values past Unicode take the
    old-style four- to six-byte forms, and 0x80000000 and past produce
    nothing at all.

    Args:
        value (int): the code the escape named, above 0x7F.
    """
    if value < 0x800:
        return bytes((0xC0 | value >> 6, 0x80 | value & 0x3F))
    if value < 0x10000:
        return bytes(
            (0xE0 | value >> 12, 0x80 | value >> 6 & 0x3F, 0x80 | value & 0x3F)
        )
    if value < 0x200000:
        return bytes(
            (
                0xF0 | value >> 18,
                0x80 | value >> 12 & 0x3F,
                0x80 | value >> 6 & 0x3F,
                0x80 | value & 0x3F,
            )
        )
    if value < 0x4000000:
        return bytes(
            (
                0xF8 | value >> 24,
                0x80 | value >> 18 & 0x3F,
                0x80 | value >> 12 & 0x3F,
                0x80 | value >> 6 & 0x3F,
                0x80 | value & 0x3F,
            )
        )
    if value < 0x80000000:
        return bytes(
            (
                0xFC | value >> 30,
                0x80 | value >> 24 & 0x3F,
                0x80 | value >> 18 & 0x3F,
                0x80 | value >> 12 & 0x3F,
                0x80 | value >> 6 & 0x3F,
                0x80 | value & 0x3F,
            )
        )
    return b""


def code_point_text(value: int) -> str:
    """The text a ``\\u`` or ``\\U`` escape writes for its value.

    bash UTF-8-encodes every value under a UTF-8 locale: a
    valid scalar is its character, while surrogate halves and values
    past Unicode become raw UTF-8-shaped bytes, and 0x80000000 and past
    produce nothing. Pinned: ``\\uD800`` is ed a0 80, ``\\U00110000`` is
    f4 90 80 80, ``\\UFFFFFFFF`` is empty.

    Args:
        value (int): the value the escape's hex digits name.
    """
    if value <= 0x7F or (value <= 0x10FFFF and not 0xD800 <= value <= 0xDFFF):
        return chr(value)
    return "".join(byte_char(b) for b in _u32_utf8(value))


def _as_text(out: list[str]) -> str:
    """The decoded pieces as text, a byte run read back as its characters.

    bash builds a $'...' word as bytes, so ``\\xc3\\xa9`` is the two bytes
    of an é and names the same file as a typed one. The escapes arrive one
    raw byte at a time, so the joined word is read back once: a run that is
    valid UTF-8 becomes its characters and any other byte stays raw.

    Args:
        out (list[str]): the decoded pieces, raw bytes as their escapes.
    """
    return decode_text(encode_text("".join(out)))


def decode_ansi_c(content: str) -> str:
    """Decode the body of a $'...' word to the text it names.

    Follows bash 5.2 (under a UTF-8 locale): simple
    escapes, 1-3 octal digits with the value masked to a byte, \\xHH
    bytes, \\u and \\U values UTF-8-encoded (surrogates and
    values past Unicode come out as raw UTF-8-shaped bytes), \\cX
    control characters (X of ``?`` is DEL, an escaped backslash counts
    as one operand), and any other or incomplete escape kept verbatim,
    backslash included. A NUL truncates the rest of this word segment,
    the C-string behavior; the segment alone is cut, so ``x$'a\\0b'y``
    still expands to ``xay``.

    Args:
        content (str): the text between ``$'`` and the closing quote.
    """
    out: list[str] = []
    i = 0
    while i < len(content):
        char = content[i]
        if char != "\\" or i + 1 == len(content):
            out.append(char)
            i += 1
            continue
        marker = content[i + 1]
        if marker in _SIMPLE:
            out.append(_SIMPLE[marker])
            i += 2
            continue
        if marker in _OCTAL:
            end = i + 1
            while (
                end < len(content) and end - i <= 3 and content[end] in _OCTAL
            ):
                end += 1
            value = int(content[i + 1 : end], 8)
            # \400 is 256: the mask lands on NUL, which truncates too.
            if value & 0xFF == 0:
                return _as_text(out)
            out.append(byte_char(value))
            i = end
            continue
        if marker == "x":
            digits, end = _scan_hex(content, i + 2, 2)
            if not digits:
                out.append("\\x")
                i += 2
                continue
            value = int(digits, 16)
            if value == 0:
                return _as_text(out)
            out.append(byte_char(value))
            i = end
            continue
        if marker in ("u", "U"):
            digits, end = _scan_hex(content, i + 2, 4 if marker == "u" else 8)
            if not digits:
                out.append("\\" + marker)
                i += 2
                continue
            value = int(digits, 16)
            if value == 0:
                return _as_text(out)
            out.append(code_point_text(value))
            i = end
            continue
        if marker == "c":
            if i + 2 == len(content):
                out.append("\\c")
                i += 2
                continue
            operand = content[i + 2]
            i += 3
            if operand == "\\" and i < len(content) and content[i] == "\\":
                # \c\\ spells an escaped backslash operand; both
                # characters belong to it.
                i += 1
            value = 0x7F if operand == "?" else ord(operand.upper()) & 0x1F
            if value == 0:
                return _as_text(out)
            out.append(chr(value))
            continue
        out.append(char + marker)
        i += 2
    return _as_text(out)


def unescape_unquoted(text: str) -> str:
    """The text an unquoted word's backslash escapes name.

    Args:
        text (str): the word as typed.
    """
    if "\\" not in text:
        return text
    try:
        parts = shlex.split(text, posix=True)
    except ValueError:
        return text
    return parts[0] if parts else text


def unescape_dquoted(text: str) -> str:
    """The text a double-quoted segment's escapes name.

    Bash recognizes ``\\$``, ``\\```, ``\\"``, ``\\\\`` and
    ``\\<newline>`` inside double quotes; every other backslash stays.

    Args:
        text (str): the segment between the quotes, as typed.
    """
    text = text.replace("\\\\", "\x00")
    text = text.replace('\\"', '"')
    text = text.replace("\\$", "$")
    text = text.replace("\\`", "`")
    text = text.replace("\\\n", "")
    return text.replace("\x00", "\\")

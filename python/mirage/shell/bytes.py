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

SURROGATE_BASE = 0xDC00
ASCII_MAX = 0x80
BYTE_MASK = 0xFF
LOCALE_VARS = ("LC_ALL", "LC_CTYPE", "LANG")
UTF8_CODESET = "utf8"


def byte_char(value: int) -> str:
    """Stand in for one raw output byte inside a text string.

    `\\xHH` and `\\NNN` name a byte, not a code point: bash writes
    `\\xff` as the single byte 0xFF, which is not valid UTF-8 on its own
    and so has no character to stand for it. A byte above ASCII is
    therefore carried as its surrogate escape, the same convention
    Python's own filesystem paths use, and `encode_text` turns it back
    into that byte.

    Three octal digits reach past one byte (`\\400` is 256, `\\777` is
    511) and bash writes the low byte of those, so the value is masked
    rather than refused.

    Args:
        value (int): the value the escape asked for, masked to one byte.
    """
    byte = value & BYTE_MASK
    return chr(byte) if byte < ASCII_MAX else chr(SURROGATE_BASE + byte)


def encode_text(text: str) -> bytes:
    """Encode shell text for output, byte escapes included.

    Every place the shell turns its own text into bytes goes through
    here, because a string that reached it from `byte_char` cannot be
    encoded as plain UTF-8 at all.

    Args:
        text (str): the text to write.
    """
    return text.encode("utf-8", "surrogateescape")


def decode_text(data: bytes) -> str:
    """Read bytes back as shell text, the inverse of ``encode_text``.

    Valid UTF-8 comes back as its characters and every other byte as its
    surrogate escape, the stand-in ``byte_char`` makes, so the text
    round-trips to exactly the bytes it was read from. A lossy decode
    cannot: one invalid byte becomes U+FFFD, three bytes wide, and every
    byte offset counted back past it runs ahead of GNU's.

    Args:
        data (bytes): the bytes to read as text.
    """
    return data.decode("utf-8", "surrogateescape")


def utf8_locale(env: Mapping[str, str] | None) -> bool:
    """Whether the environment names a UTF-8 locale, as setlocale reads it.

    POSIX takes the character type from the first of ``LC_ALL``,
    ``LC_CTYPE`` and ``LANG`` that is set and not empty, so
    ``LC_ALL=C`` outranks ``LANG=C.UTF-8``. A name is
    ``language[_territory][.codeset][@modifier]``, and glibc compares
    the codeset with case and punctuation dropped, so ``C.UTF-8``,
    ``en_US.utf8`` and ``de_DE.UTF-8@euro`` all name UTF-8. Every UTF-8
    name counts as installed, where glibc falls back to the C locale
    for one it lacks.

    Args:
        env (Mapping[str, str] | None): the command's environment.
    """
    for name in LOCALE_VARS:
        value = (env or {}).get(name, "")
        if value:
            codeset = value.partition("@")[0].partition(".")[2]
            return (
                "".join(ch for ch in codeset.lower() if ch.isalnum())
                == UTF8_CODESET
            )
    return False


def byte_view(value: str | bytes, utf8: bool = False) -> str:
    """The same bytes as a string of one character per byte.

    A command that runs in GNU's C locale (grep, sed, awk, tr, expr)
    counts, matches and indexes bytes, not characters: `.` matches one
    byte, `length` counts bytes, and a match may end inside a character.
    All of that follows from running on this representation and
    converting only at the command's edges, where a typed `é`, its
    `$'\\xc3\\xa9'` spelling and the file's own bytes all arrive as the
    same two characters.

    Under a UTF-8 locale (``utf8``) grep, sed and expr count, match and
    index characters instead, so the view is the text itself: a byte
    that is no part of a character stays its surrogate escape, one
    element of its own, as it does in glibc's matcher.

    Args:
        value (str | bytes): shell text, a raw byte riding as its
            surrogate escape, or bytes as read.
        utf8 (bool): one element per character rather than per byte.
    """
    if utf8:
        return value if isinstance(value, str) else decode_text(value)
    return (encode_text(value) if isinstance(value, str) else value).decode(
        "latin-1"
    )


def from_byte_view(view: str, utf8: bool = False) -> bytes:
    """The bytes a byte view stands for, the inverse of ``byte_view``.

    An invalid sequence or half a character comes back as itself, which
    is what GNU writes.

    Args:
        view (str): one character per byte, every code point below 256,
            or under ``utf8`` the text itself.
        utf8 (bool): the view is one element per character.
    """
    return encode_text(view) if utf8 else view.encode("latin-1")


def text_view(view: str, utf8: bool = False) -> str:
    """A byte view as shell text again, for a path or a nested command line.

    Args:
        view (str): one character per byte, every code point below 256,
            or under ``utf8`` the text itself.
        utf8 (bool): the view is one element per character.
    """
    return view if utf8 else decode_text(from_byte_view(view))

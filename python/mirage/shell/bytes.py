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

SURROGATE_BASE = 0xDC00
ASCII_MAX = 0x80
BYTE_MASK = 0xFF


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

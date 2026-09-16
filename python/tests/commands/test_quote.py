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

import pytest

from mirage.commands.quote import quote_text, quote_word

# Every row a measured GNU coreutils 9.4 answer under `LC_ALL=C`
# (ground truth EX2-C, re-derived in NL3-A). GNU passes the word it names
# in a diagnostic through gnulib's `quote()`, which in the C locale
# escapes a backslash, a single quote, the seven named C escapes, and
# every other byte outside 0x20-0x7e as three octal digits.
#
# ONE table, not one per command: NL3-A placed all 255 reachable bytes in
# the quoted slot of `nl`, `expand`, `shuf`, `cut` and `expr`, and all
# five agreed byte for byte. That is why this lives as a leaf under
# `commands/` rather than as a copy in each command. Mirrored in
# quote.test.ts.
QUOTE_WORDS = [
    (b"a\\b", r"a\\b"),
    (b"a\\\\b", r"a\\\\b"),
    (b"\\", r"\\"),
    (b"a'b", r"a\'b"),
    (b"'", r"\'"),
    (b"a\\'b", r"a\\\'b"),
    (b"", ""),
    # The seven escapes gnulib spells by name rather than in octal.
    (b"a\x07b", r"a\ab"),
    (b"a\x08b", r"a\bb"),
    (b"a\tb", r"a\tb"),
    (b"a\nb", r"a\nb"),
    (b"a\x0bb", r"a\vb"),
    (b"a\x0cb", r"a\fb"),
    (b"a\rb", r"a\rb"),
    # Everything else outside 0x20-0x7e is three octal digits, always
    # padded so a following digit cannot be read into the escape.
    (b"a\x01b", r"a\001b"),
    (b"a\x1fb", r"a\037b"),
    (b"a\x7fb", r"a\177b"),
    (b"a\x80b", r"a\200b"),
    (b"a\xffb", r"a\377b"),
    (b"\x011", r"\0011"),
    # A multibyte character is its bytes, one octal escape each.
    ("é".encode(), r"\303\251"),
    ("日".encode(), r"\346\227\245"),
    ("\U0001f600".encode(), r"\360\237\230\200"),
    # Printable ASCII passes through, including the ones a shell would
    # care about and the double quote gnulib leaves alone.
    (b"a b", "a b"),
    (b'a"b', 'a"b'),
    (b"a$b", "a$b"),
    (b"a`b", "a`b"),
    (b"~^:!%*", "~^:!%*"),
]


@pytest.mark.parametrize("word,escaped", QUOTE_WORDS)
def test_quote_word_matches_gnulib(word, escaped):
    """`quote_word` takes a byte view, one character per byte."""
    view = word.decode("latin-1")
    assert quote_word(view) == escaped


@pytest.mark.parametrize("word,escaped", QUOTE_WORDS)
def test_quote_text_matches_gnulib(word, escaped):
    """`quote_text` takes the decoded string a command actually holds.

    Same table, reached the way `nl`, `expand`, `shuf` and `cut` reach
    it: they hold a flag value as a `str`, so the encode is theirs to
    do and a two-byte character must still come out as two escapes.
    """
    assert quote_text(word.decode("utf-8", "surrogateescape")) == escaped


@pytest.mark.parametrize("byte", list(range(1, 256)))
def test_quote_word_is_ascii_for_every_byte(byte):
    """Whatever goes in, what comes out is safe to put in a message.

    Every rendering is printable ASCII, which is what lets a caller
    interpolate it into a diagnostic and encode the result without a
    surrogate or a stray control byte escaping into stderr.
    """
    rendered = quote_word(chr(byte))
    assert rendered.isascii()
    assert all(" " <= ch <= "~" for ch in rendered)


@pytest.mark.parametrize("byte", list(range(1, 256)))
def test_quote_text_agrees_with_quote_word_per_byte(byte):
    """The two entry points cannot drift: one calls the other.

    Pinned per byte anyway, because the encode in between is where a
    raw byte would turn into U+FFFD's three bytes if the
    `surrogateescape` were dropped.
    """
    raw = bytes([byte])
    assert quote_text(raw.decode("utf-8", "surrogateescape")) == quote_word(
        raw.decode("latin-1"))


def test_quote_word_pads_octal_to_three_digits():
    """`\\0011` is one escape and a digit, not `\\01` and `11`."""
    assert quote_word("\x011") == r"\0011"
    assert quote_word("\x0009".replace("\x00", "\x01")) == r"\00109"

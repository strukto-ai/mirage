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

from mirage.types import JsonValue

_HEX_LETTERS = frozenset("abcdef")
# The letters a JSON escape ends with: ``\b \f \n \r \t``, and the hex
# digit closing a ``\u00XX`` control character. Each can run into the word
# after it, so ``\nice`` holds "nice" where the message holds "ice".
_ESCAPE_LETTERS = frozenset("abcdefnrt")
# A word a provider's search reads as grep -w does: ASCII letters and
# digits, with sentence punctuation around them at most.
# The largest rendered file whose text a listing entry keeps (``kept_text``).
KEPT_TEXT_MAX = 8192
_PLAIN_WORD = re.compile(r"[.,;:!?\"'()\[\]]*[A-Za-z0-9]+[.,;:!?\"'()\[\]]*")


def record_queries(
    text: str, keys: frozenset[str], whole_word: bool
) -> list[str] | None:
    """The searches whose hits together hold every mounted record
    ``text`` may match, or None when a provider's search cannot say.

    A mounted message is the provider's record as JSON, which holds more
    than its search reads: key names, ids, counts, timestamps and flags,
    spelled with JSON escapes. ``text`` is searched only when it is ASCII
    letters and spaces, so no digit, quote or backslash can match outside
    the text the search reads, and when none of its words is one of
    ``keys`` or a run of hex letters, which an id can hold. Without
    whole-word matching a text inside a key is refused too. A text
    starting with a letter an escape ends with may start inside one, so
    the rest of it is searched as well (alone without whole-word
    matching, where it is the wider search); such a letter alone is
    refused.

    Args:
        text (str): what grep or rg searches for.
        keys (frozenset[str]): the record's key names and fixed values,
            lowercase.
        whole_word (bool): whether only whole words of ``text`` match.
    """
    if not text.strip() or not all(
        char == " " or (char.isascii() and char.isalpha()) for char in text
    ):
        return None
    words = text.lower().split()
    if any(word in keys or set(word) <= _HEX_LETTERS for word in words):
        return None
    if not whole_word and len(words) == 1 and any(words[0] in k for k in keys):
        return None
    if text[0].lower() not in _ESCAPE_LETTERS:
        return [text]
    rest = text[1:].strip()
    if not rest:
        return None
    return [text, rest] if whole_word else [rest]


def non_plain_words(text: str) -> list[str]:
    """The words of ``text`` a provider's search may split otherwise than
    grep -w: a link, an address, markup, an entity, a hyphenated or
    non-ASCII word.

    Args:
        text (str): a field the provider's search reads.
    """
    return [word for word in text.split() if not _PLAIN_WORD.fullmatch(word)]


def may_hold(
    asked: list[list[str]],
    named: dict[str, set[str]],
    record_id: str,
    kept: str,
) -> bool:
    """Whether a record may hold one of the asked texts: each word of one
    is named for the record by the provider's search, asked word by word,
    or held by the text the listing kept.

    Args:
        asked (list[list[str]]): each searched text's lowercase words.
        named (dict[str, set[str]]): the record ids each word's search
            named.
        record_id (str): the record's id.
        kept (str): the record's kept text, lowercase.
    """
    return any(
        all(record_id in named[word] or word in kept for word in words)
        for words in asked
    )


def kept_text(rendered: bytes) -> dict[str, JsonValue]:
    """A listing entry's ``extra`` keeping its file's rendered text,
    lowercased, so grep can check the file without reading it; empty past
    ``KEPT_TEXT_MAX`` bytes, where the file is read as usual.

    Args:
        rendered (bytes): the file as a read renders it.
    """
    if len(rendered) > KEPT_TEXT_MAX:
        return {}
    return {"text": rendered.decode().lower()}

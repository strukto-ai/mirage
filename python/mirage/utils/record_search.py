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

_HEX_LETTERS = frozenset("abcdef")
# The letters a JSON escape ends with: ``\b \f \n \r \t``, and the hex
# digit closing a ``\u00XX`` control character. Each can run into the word
# after it, so ``\nice`` holds "nice" where the message holds "ice".
_ESCAPE_LETTERS = frozenset("abcdefnrt")


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

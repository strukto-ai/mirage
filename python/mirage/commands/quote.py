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

# The seven C escapes gnulib spells by name, plus the two printable
# characters it still escapes because they would otherwise close or
# confuse the quotes it wrapped the word in. Every other byte outside
# 0x20-0x7e becomes three octal digits.
QUOTE_ESCAPES = {
    "\x07": "\\a",
    "\x08": "\\b",
    "\t": "\\t",
    "\n": "\\n",
    "\x0b": "\\v",
    "\f": "\\f",
    "\r": "\\r",
    "'": "\\'",
    "\\": "\\\\",
}


def quote_word(view: str) -> str:
    r"""One word as gnulib's `quote()` renders it inside a diagnostic.

    Every GNU coreutils diagnostic that names a word passes it through
    gnulib's quotearg in `locale_quoting_style`, which in the C locale
    wraps it in single quotes and escapes what would be unreadable
    inside them. This is the body only; the quotes belong to the
    message templates, because a few clauses spell them differently
    (`cut` writes `invalid field value '<w>'` with no colon before the
    quote).

    ONE rule, not one per command. It was derived from all 255
    reachable byte values in each of `nl`, `expand`, `shuf`, `cut` and
    `expr`, and all five agree byte for byte, which is what makes this
    a shared leaf rather than a copy in each command.

    It sits directly under `commands/` because both halves of the tree
    need it: every builtin that refuses a flag value, and the shared
    ARGMATCH renderer in `commands/spec/usage.py`. A leaf beside
    `commands/errors.py` is reachable from `spec` and from `builtin`
    alike, where the old home under `commands/builtin/utils/` would
    have made `spec` import `builtin` -- the one direction nothing in
    this tree takes.

    The rule is per byte, which is why this takes a byte view: a
    two-byte character is two octal escapes
    (`expr '(' <e-acute>` names `\303\251`, not the character), and a
    byte above 0x7f is not printable in the C locale. Callers holding
    an ordinary decoded string want `quote_text`.

    Not every quoted word goes through this. getopt's own
    `unrecognized option '<w>'` prints `argv[optind]` with a plain
    `%s`, so it carries the raw bytes and must NOT be routed here.

    Args:
        view (str): the word as a byte view, one character per byte.

    Returns:
        str: the escaped body, still a byte view since every character
            it emits is ASCII.
    """
    out = []
    for ch in view:
        named = QUOTE_ESCAPES.get(ch)
        if named is not None:
            out.append(named)
        elif " " <= ch <= "~":
            out.append(ch)
        else:
            out.append(f"\\{ord(ch):03o}")
    return "".join(out)


def quote_text(text: str) -> str:
    r"""`quote_word` for a caller holding an ordinary decoded string.

    The commands that refuse a flag value hold it as a `str`, not as
    the byte view `expr`'s parser runs on, so they need the encode
    first: the rule counts bytes, and `é` must render as two octal
    escapes rather than one. `surrogateescape` is what carries a raw
    non-UTF-8 byte through as itself, since such a byte reaches a
    command as its lone surrogate and would otherwise be encoded as
    U+FFFD's three bytes.

    Args:
        text (str): the refused word as the command holds it.

    Returns:
        str: the escaped body, ASCII only.
    """
    return quote_word(
        text.encode("utf-8", "surrogateescape").decode("latin-1"))

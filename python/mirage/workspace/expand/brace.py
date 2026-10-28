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

from collections.abc import Iterable, Iterator

from mirage.workspace.expand.constants import (
    CHAR_SEQ,
    INERT_CLOSE,
    INERT_OPEN,
    NUM_SEQ,
)
from mirage.workspace.expand.types import Chunk, Piece


def make_inert(index: int) -> str:
    """Encode an already-expanded chunk as an opaque template atom.

    Inert atoms never contribute brace metacharacters, matching bash's
    ordering where brace expansion runs before parameter and command
    substitution (`{a,$v}` alternates on the atom, `{1..$n}` stays
    literal). Shell input cannot contain NUL, so the sentinel bytes
    cannot collide with template text.

    Args:
        index (int): position of the chunk's value in the values list.
    """
    return f"{INERT_OPEN}{index}{INERT_CLOSE}"


def substitute(word: str, values: list[list[Chunk]]) -> list[Chunk]:
    """Replace inert atoms in an expanded template word with their pieces.

    The template's own text is literal and never splits; an atom keeps
    the pieces its expansion produced. An empty word has no pieces, so
    it is no word at all: ``{,x}`` is ``x``.

    Args:
        word (str): one word produced by expand_template.
        values (list[list[Chunk]]): expanded atom pieces, indexed by atom.
    """
    out: list[Chunk] = []
    i = 0
    while True:
        j = word.find(INERT_OPEN, i)
        literal = word[i:] if j < 0 else word[i:j]
        if literal:
            out.append(Piece(literal))
        if j < 0:
            return out
        k = word.index(INERT_CLOSE, j)
        out.extend(values[int(word[j + 1 : k])])
        i = k + 1


def _is_padded(text: str) -> bool:
    digits = text[1:] if text.startswith("-") else text
    return len(digits) > 1 and digits.startswith("0")


def _parse_integer(text: str) -> int | None:
    negative = text.startswith("-")
    digits = text[1:] if text.startswith(("-", "+")) else text
    digits = digits.lstrip("0") or "0"
    if len(digits) > 19:
        return None
    value = int(digits) * (-1 if negative else 1)
    return value if -(1 << 63) <= value < (1 << 63) else None


def _parse_step(step_text: str | None, descending: bool) -> int | None:
    if step_text is None:
        return 1
    value = _parse_integer(step_text)
    if value is None or (value == -(1 << 63) and not descending):
        return None
    step = abs(value)
    return step if step else 1


def _seq_values(lo: int, hi: int, step: int) -> range:
    if lo <= hi:
        return range(lo, hi + 1, step)
    return range(lo, hi - 1, -step)


def _gen_sequence(body: str) -> Iterable[str] | None:
    """Generate `{x..y[..step]}` sequence words, or None if not a range.

    A range body must be pure literal text: an inert atom or escape
    anywhere inside disqualifies it (`{1..$n}` stays literal in bash).
    Numeric endpoints with leading zeros zero-pad every output to the
    widest endpoint, the minus sign counting toward the width
    (`{-05..5..5}` yields `-05 000 005`). Step direction follows the
    endpoints; the step's own sign is ignored and 0 acts as 1. The
    words are made as they are read.

    Args:
        body (str): text between the braces.
    """
    if INERT_OPEN in body or "\\" in body:
        return None
    m = NUM_SEQ.fullmatch(body)
    if m:
        lo_text, hi_text, step_text = m.group(1), m.group(2), m.group(3)
        lo, hi = _parse_integer(lo_text), _parse_integer(hi_text)
        if lo is None or hi is None:
            return None
        step = _parse_step(step_text, lo >= hi)
        if step is None:
            return None
        # Pinned Bash leaves these directed spans literal, even with a large step.
        max_span = (1 << 63) - 3
        if (lo < 0 and hi - lo > max_span) or (lo > 0 and lo - hi > max_span):
            return None
        values = _seq_values(lo, hi, step)
        if _is_padded(lo_text) or _is_padded(hi_text):
            width = max(len(lo_text), len(hi_text))
            return (f"{v:0{width}d}" for v in values)
        return map(str, values)
    m = CHAR_SEQ.fullmatch(body)
    if m:
        step = _parse_step(m.group(3), m.group(1) >= m.group(2))
        if step is None:
            return None
        values = _seq_values(ord(m.group(1)), ord(m.group(2)), step)
        return map(chr, values)
    return None


def _match_close(text: str, open_idx: int) -> int:
    depth = 1
    i = open_idx + 1
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "\\":
            i += 2
            continue
        if ch == INERT_OPEN:
            i = text.index(INERT_CLOSE, i) + 1
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


def _split_alternatives(body: str) -> list[str] | None:
    alts: list[str] = []
    depth = 0
    start = 0
    i = 0
    n = len(body)
    while i < n:
        ch = body[i]
        if ch == "\\":
            i += 2
            continue
        if ch == INERT_OPEN:
            i = body.index(INERT_CLOSE, i) + 1
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
        elif ch == "," and depth == 0:
            alts.append(body[start:i])
            start = i + 1
        i += 1
    if not alts:
        return None
    alts.append(body[start:])
    return alts


def _expand(template: str) -> Iterator[str]:
    i = 0
    n = len(template)
    while i < n:
        ch = template[i]
        if ch == "\\":
            i += 2
            continue
        if ch == INERT_OPEN:
            i = template.index(INERT_CLOSE, i) + 1
            continue
        if ch != "{":
            i += 1
            continue
        close = _match_close(template, i)
        if close < 0:
            i += 1
            continue
        body = template[i + 1 : close]
        sequence = _gen_sequence(body)
        if sequence is None:
            alts = _split_alternatives(body)
            if alts is None:
                # `{abc}` and friends stay literal; the next `{` (even
                # one inside this body) may still expand, like GNU.
                i += 1
                continue
            groups: list[Iterable[str]] = [_expand(alt) for alt in alts]
        else:
            groups = [sequence]
        prefix = template[:i]
        # The suffix words are made once, as the first alternative takes
        # them, and kept for the rest.
        suffixes: list[str] = []
        tail: Iterator[str] | None = _expand(template[close + 1 :])
        for group in groups:
            for alt in group:
                if tail is not None:
                    for suffix in tail:
                        suffixes.append(suffix)
                        yield prefix + alt + suffix
                    tail = None
                    continue
                for suffix in suffixes:
                    yield prefix + alt + suffix
        return
    yield template


def expand_template(template: str) -> Iterable[str] | None:
    """Brace-expand a template word into its word list.

    The words are made as they are read, so a caller that yields as it
    reads them stops inside a long range. A word an expansion makes is
    shorter than the template it came from, so a first word equal to
    the template means nothing expanded.

    Args:
        template (str): literal shell text where already-expanded
            chunks appear as inert atoms from make_inert.

    Returns:
        Iterable[str] | None: expanded words (inert atoms preserved),
        or None when the template contains nothing brace-expandable so
        callers can fall back to plain concatenation.
    """
    if next(_expand(template)) == template:
        return None
    return _expand(template)

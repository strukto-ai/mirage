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

from mirage.workspace.expand.constants import (CHAR_SEQ, INERT_CLOSE,
                                               INERT_OPEN, NUM_SEQ)


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


def substitute(word: str, values: list[str]) -> str:
    """Replace inert atoms in an expanded template word with values.

    Args:
        word (str): one word produced by expand_template.
        values (list[str]): expanded chunk values, indexed by atom.
    """
    if INERT_OPEN not in word:
        return word
    out: list[str] = []
    i = 0
    while True:
        j = word.find(INERT_OPEN, i)
        if j < 0:
            out.append(word[i:])
            break
        out.append(word[i:j])
        k = word.index(INERT_CLOSE, j)
        out.append(values[int(word[j + 1:k])])
        i = k + 1
    return "".join(out)


def _is_padded(text: str) -> bool:
    digits = text[1:] if text.startswith("-") else text
    return len(digits) > 1 and digits.startswith("0")


def _parse_step(step_text: str | None) -> int:
    if step_text is None:
        return 1
    step = abs(int(step_text))
    return step if step else 1


def _seq_values(lo: int, hi: int, step: int) -> list[int]:
    if lo <= hi:
        return list(range(lo, hi + 1, step))
    return list(range(lo, hi - 1, -step))


def _gen_sequence(amble: str) -> list[str] | None:
    """Generate `{x..y[..step]}` sequence words, or None if not a range.

    A range body must be pure literal text: an inert atom or escape
    anywhere inside disqualifies it (`{1..$n}` stays literal in bash).
    Numeric endpoints with leading zeros zero-pad every output to the
    widest endpoint, the minus sign counting toward the width
    (`{-05..5..5}` yields `-05 000 005`). Step direction follows the
    endpoints; the step's own sign is ignored and 0 acts as 1.

    Args:
        amble (str): text between the braces.
    """
    if INERT_OPEN in amble or "\\" in amble:
        return None
    m = NUM_SEQ.match(amble)
    if m:
        lo_text, hi_text, step_text = m.group(1), m.group(2), m.group(3)
        values = _seq_values(int(lo_text), int(hi_text),
                             _parse_step(step_text))
        if _is_padded(lo_text) or _is_padded(hi_text):
            width = max(len(lo_text), len(hi_text))
            return [f"{v:0{width}d}" for v in values]
        return [str(v) for v in values]
    m = CHAR_SEQ.match(amble)
    if m:
        values = _seq_values(ord(m.group(1)), ord(m.group(2)),
                             _parse_step(m.group(3)))
        return [chr(v) for v in values]
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


def _split_alternatives(amble: str) -> list[str] | None:
    alts: list[str] = []
    depth = 0
    start = 0
    i = 0
    n = len(amble)
    while i < n:
        ch = amble[i]
        if ch == "\\":
            i += 2
            continue
        if ch == INERT_OPEN:
            i = amble.index(INERT_CLOSE, i) + 1
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
        elif ch == "," and depth == 0:
            alts.append(amble[start:i])
            start = i + 1
        i += 1
    if not alts:
        return None
    alts.append(amble[start:])
    return alts


def _expand(template: str) -> list[str]:
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
        amble = template[i + 1:close]
        alternatives = _gen_sequence(amble)
        if alternatives is None:
            alts = _split_alternatives(amble)
            if alts is None:
                # `{abc}` and friends stay literal; the next `{` (even
                # one inside this body) may still expand, like GNU.
                i += 1
                continue
            alternatives = [w for alt in alts for w in _expand(alt)]
        prefix = template[:i]
        suffixes = _expand(template[close + 1:])
        return [
            prefix + alt + suffix for alt in alternatives
            for suffix in suffixes
        ]
    return [template]


def expand_template(template: str) -> list[str] | None:
    """Brace-expand a template word into its word list.

    Args:
        template (str): literal shell text where already-expanded
            chunks appear as inert atoms from make_inert.

    Returns:
        list[str] | None: expanded words (inert atoms preserved), or
        None when the template contains nothing brace-expandable so
        callers can fall back to plain concatenation.
    """
    words = _expand(template)
    if len(words) == 1 and words[0] == template:
        return None
    return words

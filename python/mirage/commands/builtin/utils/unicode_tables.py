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

# The \h and \v lists are those of PCRE2 10.43 and 10.46 (BSD-3-Clause
# WITH PCRE2-exception; see licenses/third_party/pcre2.txt).

import re
import unicodedata
from functools import cache

from mirage.commands.builtin.utils.charset import ALL, MAX_CODE_POINT, CharSet

# The planes that hold assigned characters other than private use. The
# rest is private use (planes 15 and 16) or unassigned, so the category
# scan stays a quarter of the code space.
SCANNED = ((0, 0x3FFFF), (0xE0000, 0xE0FFF))
PRIVATE_USE = ((0xF0000, 0xFFFFD), (0x100000, 0x10FFFD))
# Where every cased letter lives, for the case-folding scan.
CASED_LIMIT = 0x20000

GROUPS = {
    "L": ("Lu", "Ll", "Lt", "Lm", "Lo"),
    "LC": ("Lu", "Ll", "Lt"),
    "M": ("Mn", "Mc", "Me"),
    "N": ("Nd", "Nl", "No"),
    "P": ("Pc", "Pd", "Ps", "Pe", "Pi", "Pf", "Po"),
    "S": ("Sm", "Sc", "Sk", "So"),
    "Z": ("Zs", "Zl", "Zp"),
    "C": ("Cc", "Cf", "Cs", "Co", "Cn"),
}

# UAX #44's long names for the General_Category values, the spelling
# both Rust's `\p{Letter}` and PCRE2's `\p{Letter}` accept.
LONG_NAMES = {
    "letter": "L",
    "casedletter": "LC",
    "uppercaseletter": "Lu",
    "lowercaseletter": "Ll",
    "titlecaseletter": "Lt",
    "modifierletter": "Lm",
    "otherletter": "Lo",
    "mark": "M",
    "combiningmark": "M",
    "nonspacingmark": "Mn",
    "spacingmark": "Mc",
    "enclosingmark": "Me",
    "number": "N",
    "decimalnumber": "Nd",
    "digit": "Nd",
    "letternumber": "Nl",
    "othernumber": "No",
    "punctuation": "P",
    "punct": "P",
    "connectorpunctuation": "Pc",
    "dashpunctuation": "Pd",
    "openpunctuation": "Ps",
    "closepunctuation": "Pe",
    "initialpunctuation": "Pi",
    "finalpunctuation": "Pf",
    "otherpunctuation": "Po",
    "symbol": "S",
    "mathsymbol": "Sm",
    "currencysymbol": "Sc",
    "modifiersymbol": "Sk",
    "othersymbol": "So",
    "separator": "Z",
    "spaceseparator": "Zs",
    "lineseparator": "Zl",
    "paragraphseparator": "Zp",
    "other": "C",
    "control": "Cc",
    "cntrl": "Cc",
    "format": "Cf",
    "surrogate": "Cs",
    "privateuse": "Co",
    "unassigned": "Cn",
}

# White_Space (PropList.txt), what Rust's Unicode `\s` is.
WHITE_SPACE = CharSet.of(
    (0x09, 0x0D),
    (0x20, 0x20),
    (0x85, 0x85),
    (0xA0, 0xA0),
    (0x1680, 0x1680),
    (0x2000, 0x200A),
    (0x2028, 0x2029),
    (0x202F, 0x202F),
    (0x205F, 0x205F),
    (0x3000, 0x3000),
)
# PCRE2's `\h` and `\v`, its fixed horizontal and vertical space lists,
# whose union is its UCP `\s` (U+180E stays in `\h`: pcre2_tables.c).
PCRE_HSPACE = CharSet.of(
    (0x09, 0x09),
    (0x20, 0x20),
    (0xA0, 0xA0),
    (0x1680, 0x1680),
    (0x180E, 0x180E),
    (0x2000, 0x200A),
    (0x202F, 0x202F),
    (0x205F, 0x205F),
    (0x3000, 0x3000),
)
PCRE_VSPACE = CharSet.of((0x0A, 0x0D), (0x85, 0x85), (0x2028, 0x2029))
# The Alphabetic code points that are neither a letter, a letter number
# nor a mark: the circled and squared Latin letters, which Rust's `\w`
# counts (`rg -o '\w+'` over `aⒶb` is one word).
OTHER_ALPHABETIC_SYMBOLS = CharSet.of(
    (0x24B6, 0x24E9),
    (0x1F130, 0x1F149),
    (0x1F150, 0x1F169),
    (0x1F170, 0x1F189),
)
JOIN_CONTROL = CharSet.of((0x200C, 0x200D))

ASCII = CharSet.of((0, 0x7F))
ASCII_DIGIT = CharSet.of((0x30, 0x39))
ASCII_WORD = CharSet.of((0x30, 0x39), (0x41, 0x5A), (0x5F, 0x5F), (0x61, 0x7A))
ASCII_SPACE = CharSet.of((0x09, 0x0D), (0x20, 0x20))
# The POSIX classes in the ASCII reading both dialects give them (Rust
# always, PCRE2 without UCP), `word` included.
ASCII_CLASSES = {
    "alnum": CharSet.of((0x30, 0x39), (0x41, 0x5A), (0x61, 0x7A)),
    "alpha": CharSet.of((0x41, 0x5A), (0x61, 0x7A)),
    "ascii": ASCII,
    "blank": CharSet.of((0x09, 0x09), (0x20, 0x20)),
    "cntrl": CharSet.of((0, 0x1F), (0x7F, 0x7F)),
    "digit": ASCII_DIGIT,
    "graph": CharSet.of((0x21, 0x7E)),
    "lower": CharSet.of((0x61, 0x7A)),
    "print": CharSet.of((0x20, 0x7E)),
    "punct": CharSet.of(
        (0x21, 0x2F), (0x3A, 0x40), (0x5B, 0x60), (0x7B, 0x7E)
    ),
    "space": ASCII_SPACE,
    "upper": CharSet.of((0x41, 0x5A)),
    "word": ASCII_WORD,
    "xdigit": CharSet.of((0x30, 0x39), (0x41, 0x46), (0x61, 0x66)),
}

LOOSE = re.compile(r"[\s_-]+")


@cache
def categories() -> dict[str, CharSet]:
    """Every two-letter General_Category, from this host's Unicode data.

    Each host reads its own tables -- python 3.12's are Unicode 15.0,
    the one ripgrep 14.1.1 bundles too, while a JavaScript engine carries
    its ICU's -- so a character assigned after 15.0 may classify
    differently between the two hosts.

    Returns:
        dict[str, CharSet]: category to members.
    """
    runs: dict[str, list[tuple[int, int]]] = {}
    for low, high in SCANNED:
        start = low
        current = unicodedata.category(chr(low))
        for cp in range(low + 1, high + 2):
            category = unicodedata.category(chr(cp)) if cp <= high else ""
            if category != current:
                runs.setdefault(current, []).append((start, cp - 1))
                start, current = cp, category
    runs.setdefault("Co", []).extend(PRIVATE_USE)
    table = {name: CharSet.of(*ranges) for name, ranges in runs.items()}
    assigned = CharSet()
    for name, members in table.items():
        if name != "Cn":
            assigned = assigned.union(members)
    table["Cn"] = CharSet.of((0, MAX_CODE_POINT)).intersect(
        CharSet.of(*_gaps(assigned))
    )
    return table


def _gaps(cs: CharSet) -> list[tuple[int, int]]:
    """The code points in no range of a set, surrogates included.

    Args:
        cs (CharSet): the set.
    """
    out: list[tuple[int, int]] = []
    low = 0
    for start, end in cs.ranges:
        if start > low:
            out.append((low, start - 1))
        low = end + 1
    if low <= MAX_CODE_POINT:
        out.append((low, MAX_CODE_POINT))
    return out


def category(name: str) -> CharSet:
    """One General_Category value or group, by its short name.

    Args:
        name (str): ``Lu``, ``L``, ``LC`` and so on.
    """
    table = categories()
    members = GROUPS.get(name, (name,))
    out = CharSet()
    for member in members:
        out = out.union(table.get(member, CharSet()))
    return out


def canonical_category(name: str) -> str | None:
    """A General_Category spelling as its short name, or None.

    Matching is loose, as both engines match it: case, spaces,
    underscores and hyphens are ignored, and a ``gc=`` or
    ``General_Category=`` prefix is allowed.

    Args:
        name (str): the name as typed.
    """
    key = LOOSE.sub("", name).lower()
    for prefix in ("generalcategory=", "gc=", "generalcategory:", "gc:"):
        if key.startswith(prefix):
            key = key[len(prefix) :]
    for short in (*GROUPS, *{c for g in GROUPS.values() for c in g}):
        if key == short.lower():
            return short
    return LONG_NAMES.get(key)


def unicode_property(name: str) -> CharSet | None:
    """A Unicode property both dialects spell alike, or None.

    General_Category values and groups, ``Any``, ``ASCII`` and
    ``Assigned``. Scripts and the other binary properties are not in
    python's Unicode data, so they are not here in either host.

    Args:
        name (str): the name as typed between the braces.
    """
    key = LOOSE.sub("", name).lower()
    if key == "any":
        return ALL
    if key == "ascii":
        return ASCII
    if key == "assigned":
        return category("Cn").negate()
    short = canonical_category(name)
    return category(short) if short is not None else None


@cache
def rust_word() -> CharSet:
    """Rust's Unicode ``\\w``: Alphabetic, marks, Nd, Pc, Join_Control."""
    return (
        category("L")
        .union(category("Nl"))
        .union(category("M"))
        .union(category("Nd"))
        .union(category("Pc"))
        .union(JOIN_CONTROL)
        .union(OTHER_ALPHABETIC_SYMBOLS)
    )


@cache
def pcre_word() -> CharSet:
    """PCRE2's UCP ``\\w``: letters, numbers, Mn and Pc (10.43)."""
    return (
        category("L")
        .union(category("N"))
        .union(category("Mn"))
        .union(category("Pc"))
    )


@cache
def fold_orbits() -> dict[int, tuple[int, ...]]:
    """Each cased code point's simple case-folding equivalence class.

    Two code points are linked when one is the other's lowercase,
    uppercase or case fold and both fold alike, which is simple case
    folding: ``K`` (U+212A) joins ``k``, ``ſ`` joins ``s``, and ``ı``
    stays alone because it folds to itself.

    Returns:
        dict[int, tuple[int, ...]]: code point to its sorted class, for
            every code point whose class has more than one member.
    """
    parent: dict[int, int] = {}

    def find(cp: int) -> int:
        while parent.get(cp, cp) != cp:
            cp = parent[cp]
        return cp

    for cp in range(CASED_LIMIT):
        ch = chr(cp)
        for other in (ch.lower(), ch.upper(), ch.casefold()):
            if len(other) != 1 or other == ch:
                continue
            if ch.casefold() != other.casefold():
                continue
            a, b = find(cp), find(ord(other))
            if a != b:
                parent[max(a, b)] = min(a, b)
    members: dict[int, list[int]] = {}
    for cp in list(parent):
        members.setdefault(find(cp), []).append(cp)
    orbits: dict[int, tuple[int, ...]] = {}
    for root, group in members.items():
        orbit = tuple(sorted({root, *group}))
        for cp in orbit:
            orbits[cp] = orbit
    return orbits


@cache
def cased() -> tuple[int, ...]:
    """Every code point with a non-trivial case-folding class, sorted."""
    return tuple(sorted(fold_orbits()))


def fold(cs: CharSet, ascii_only: bool) -> CharSet:
    """A set closed under simple case folding.

    Args:
        cs (CharSet): the set.
        ascii_only (bool): fold only the ASCII letters into each other.
    """
    if ascii_only:
        upper = cs.intersect(CharSet.of((0x41, 0x5A)))
        lower = cs.intersect(CharSet.of((0x61, 0x7A)))
        return cs.union(
            CharSet.of(*((a + 32, b + 32) for a, b in upper.ranges))
        ).union(CharSet.of(*((a - 32, b - 32) for a, b in lower.ranges)))
    orbits = fold_orbits()
    extra: list[int] = []
    for cp in cased():
        if cs.contains(cp):
            extra.extend(orbits[cp])
    return cs.union(CharSet.chars(*extra))

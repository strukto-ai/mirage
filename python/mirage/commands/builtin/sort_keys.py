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
from dataclasses import dataclass
from functools import cmp_to_key, partial
from typing import TypeAlias

from mirage.commands.builtin.errors import SortKeyError
from mirage.commands.builtin.utils.strtod import STRTOD, strtod_double
from mirage.commands.quote import quote_text


@dataclass(frozen=True, slots=True)
class NumericKey:
    """A decimal with no leading or trailing zeroes; zero is never negative."""

    negative: bool
    integer: str
    fraction: str


# One run of a version string: digits rank before non-digits, so the two
# shapes never compare against each other.
_VersionPart: TypeAlias = tuple[int, int] | tuple[int, str]
# What one key field collapses to before comparison: a month index, a
# parsed number, the (unit, number) pair -h orders by, the (rank, value)
# pair -g uses to order junk before NaN before real numbers, the version
# run list, or the text itself.
_SortKey: TypeAlias = (
    NumericKey
    | str
    | int
    | float
    | tuple[int, NumericKey]
    | tuple[int, float]
    | list[_VersionPart]
)
# sort.c's `unit_order`: the suffixes -h ranks, lowercase only for k.
_UNIT_ORDERS = {
    "K": 1,
    "k": 1,
    "M": 2,
    "G": 3,
    "T": 4,
    "P": 5,
    "E": 6,
    "Z": 7,
    "Y": 8,
    "R": 9,
    "Q": 10,
}
# sort.c's `blanks`: isblank() in the C locale plus the newline a -z
# record can hold. They separate fields, and -b, -n, -h and -M skip them.
_FIELD_BLANKS = " \t\n"
# strnumcmp's number in the C locale: no `+`, exponent or thousands
# separator. find_unit_order reads the byte after the digits and points.
_NUMBER_RE = re.compile(r"[ \t\n]*(-?)([0-9]*)(?:\.([0-9]*))?")
_UNIT_RE = re.compile(r"[ \t\n]*(-?)([0-9.]*)(.?)")
_VERSION_RE = re.compile(r"([0-9]+)|([^0-9]+)")
_MONTHS = {
    "jan": 1,
    "feb": 2,
    "mar": 3,
    "apr": 4,
    "may": 5,
    "jun": 6,
    "jul": 7,
    "aug": 8,
    "sep": 9,
    "oct": 10,
    "nov": 11,
    "dec": 12,
}
# The letters sort.c's `set_ordering` takes after a KEYDEF position. R is
# recognized, so it still keeps a key off the global options and counts
# against the others it is incompatible with, but it does not shuffle.
_ORDER_LETTERS = frozenset("bdfghiMnRrV")
# What strtoumax skips before a number, isspace() in the C locale.
_BLANKS = frozenset(" \t\n\v\f\r")


@dataclass(frozen=True, slots=True)
class KeyMods:
    numeric: bool = False
    general_numeric: bool = False
    human: bool = False
    version: bool = False
    month: bool = False
    fold: bool = False
    reverse: bool = False
    dictionary: bool = False
    ignore_nonprinting: bool = False
    random: bool = False


@dataclass(frozen=True, slots=True)
class Key:
    start_field: int
    start_char: int
    start_skip: bool
    end_field: int | None
    end_char: int | None
    end_skip: bool
    mods: KeyMods


@dataclass(frozen=True, slots=True)
class SortConfig:
    keys: tuple[Key, ...]
    field_sep: str | None
    reverse: bool
    unique: bool
    stable: bool


def _field_count(spec: str, pos: int, what: str) -> tuple[int, int]:
    """sort.c's ``parse_field_count``: the decimal starting at ``pos``.

    strtoumax's reading, so leading blanks and a ``+`` are taken and the
    number ends at the first byte that is not an ASCII digit, which the
    caller reads on from. A ``-``, or no digit at all, is refused with the
    text from ``pos`` on.

    Args:
        spec (str): the whole KEYDEF.
        pos (int): where the number should start.
        what (str): what the number is, for the refusal.

    Returns:
        tuple[int, int]: the number and the index just past it.

    Raises:
        SortKeyError: no number starts at ``pos``.
    """
    end = pos
    while end < len(spec) and spec[end] in _BLANKS:
        end += 1
    if end < len(spec) and spec[end] == "+":
        end += 1
    digits = end
    while end < len(spec) and "0" <= spec[end] <= "9":
        end += 1
    if end == digits:
        raise SortKeyError(
            f"{what}: invalid count at start of '{quote_text(spec[pos:])}'"
        )
    return int(spec[digits:end]), end


def _bad_field_spec(spec: str, why: str) -> SortKeyError:
    return SortKeyError(
        f"{why}: invalid field specification '{quote_text(spec)}'"
    )


def _ordering(spec: str, pos: int) -> tuple[str, int]:
    end = pos
    while end < len(spec) and spec[end] in _ORDER_LETTERS:
        end += 1
    return spec[pos:end], end


def _mods_from_letters(letters: str) -> KeyMods:
    return KeyMods(
        numeric="n" in letters,
        general_numeric="g" in letters,
        human="h" in letters,
        version="V" in letters,
        month="M" in letters,
        fold="f" in letters,
        reverse="r" in letters,
        dictionary="d" in letters,
        ignore_nonprinting="i" in letters,
        random="R" in letters,
    )


def parse_keydef(spec: str, global_mods: KeyMods, global_skip: bool) -> Key:
    """One ``-k`` KEYDEF, read and refused the way sort.c's option loop does.

    ``F[.C][OPTS][,F[.C][OPTS]]``, taken left to right: each number is
    checked as it is read, so ``-k0.x`` names the zero field and not the
    bad offset, and ordering letters run until the first byte that is not
    one, where anything left over is a stray character. A start offset
    of zero is refused and an end offset of zero means the end of its
    field. A key that carries any letter of its own, ``b`` included,
    takes none of the global options.

    Args:
        spec (str): the KEYDEF as typed.
        global_mods (KeyMods): the global ordering options.
        global_skip (bool): the global ``-b``.

    Raises:
        SortKeyError: a KEYDEF GNU refuses, in its words.
    """
    start_field, pos = _field_count(spec, 0, "invalid number at field start")
    if start_field == 0:
        raise _bad_field_spec(spec, "field number is zero")
    start_char = 1
    if pos < len(spec) and spec[pos] == ".":
        start_char, pos = _field_count(
            spec, pos + 1, "invalid number after '.'"
        )
        if start_char == 0:
            raise _bad_field_spec(spec, "character offset is zero")
    start_letters, pos = _ordering(spec, pos)
    end_field: int | None = None
    end_char: int | None = None
    end_letters = ""
    if pos < len(spec) and spec[pos] == ",":
        end_field, pos = _field_count(
            spec, pos + 1, "invalid number after ','"
        )
        if end_field == 0:
            raise _bad_field_spec(spec, "field number is zero")
        if pos < len(spec) and spec[pos] == ".":
            end_char, pos = _field_count(
                spec, pos + 1, "invalid number after '.'"
            )
        end_letters, pos = _ordering(spec, pos)
    if pos < len(spec):
        raise _bad_field_spec(spec, "stray character in field spec")
    if start_letters or end_letters:
        mods = _mods_from_letters(start_letters + end_letters)
        start_skip = "b" in start_letters
        end_skip = "b" in end_letters
    else:
        mods = global_mods
        start_skip = global_skip
        end_skip = global_skip
    return Key(
        start_field=start_field,
        start_char=start_char,
        start_skip=start_skip,
        end_field=end_field,
        end_char=end_char,
        end_skip=end_skip,
        mods=mods,
    )


def _incompatible_letters(mods: KeyMods) -> str:
    """The letters sort.c's ``check_ordering_compatibility`` refuses.

    A key orders by at most one of ``-n``, ``-g``, ``-h``, ``-M`` and the
    group ``-V``, ``-R``, ``-d``, ``-i``, whose members combine with each
    other but with none of the rest. The refusal spells the key the way
    ``key_to_opts`` does, without ``-b`` and ``-r``, and ``-d`` hides
    ``-i`` because GNU keeps only the stronger of the two filters.

    Args:
        mods (KeyMods): one key's options, inherited ones included.

    Returns:
        str: the letters to name, or ``""`` for a compatible key.
    """
    text_orders = (
        mods.version
        or mods.random
        or mods.dictionary
        or mods.ignore_nonprinting
    )
    orderings = (
        mods.numeric
        + mods.general_numeric
        + mods.human
        + mods.month
        + text_orders
    )
    if orderings <= 1:
        return ""
    spelled = (
        ("d", mods.dictionary),
        ("f", mods.fold),
        ("g", mods.general_numeric),
        ("h", mods.human),
        ("i", mods.ignore_nonprinting and not mods.dictionary),
        ("M", mods.month),
        ("n", mods.numeric),
        ("R", mods.random),
        ("V", mods.version),
    )
    return "".join(letter for letter, given in spelled if given)


def build_config(
    key_defs: list[str],
    field_sep: str | None,
    reverse: bool,
    numeric: bool,
    unique: bool,
    fold_case: bool,
    human_numeric: bool,
    version_sort: bool,
    month_sort: bool,
    ignore_blanks: bool,
    stable: bool,
    general_numeric: bool = False,
    dictionary: bool = False,
    ignore_nonprinting: bool = False,
) -> SortConfig:
    """The comparison sort runs, refusing a key that mixes orderings.

    GNU checks the orderings once the option loop is done, key by key in
    the order the keys were typed, so a bad KEYDEF, a second ``-o`` or a
    second check mode outranks it and it outranks ``-c``'s operand
    checks. The global options count only through the keys that inherit
    them, so ``sort -n -g -k1,1n`` runs; with no ``-k`` they are the one
    key.

    Args:
        key_defs (list[str]): each ``-k`` as typed.
        field_sep (str | None): ``-t``.
        reverse (bool): ``-r``.
        numeric (bool): ``-n``.
        unique (bool): ``-u``.
        fold_case (bool): ``-f``.
        human_numeric (bool): ``-h``.
        version_sort (bool): ``-V``.
        month_sort (bool): ``-M``.
        ignore_blanks (bool): ``-b``.
        stable (bool): ``-s``.
        general_numeric (bool): ``-g``.
        dictionary (bool): ``-d``.
        ignore_nonprinting (bool): ``-i``.

    Raises:
        SortKeyError: a KEYDEF GNU refuses, or a key whose orderings are
            incompatible.
    """
    global_mods = KeyMods(
        numeric=numeric,
        general_numeric=general_numeric,
        human=human_numeric,
        version=version_sort,
        month=month_sort,
        fold=fold_case,
        reverse=reverse,
        dictionary=dictionary,
        ignore_nonprinting=ignore_nonprinting,
    )
    if key_defs:
        keys = tuple(
            parse_keydef(spec, global_mods, ignore_blanks) for spec in key_defs
        )
    else:
        keys = (
            Key(1, 1, ignore_blanks, None, None, ignore_blanks, global_mods),
        )
    for key in keys:
        letters = _incompatible_letters(key.mods)
        if letters:
            raise SortKeyError(f"options '-{letters}' are incompatible")
    return SortConfig(
        keys=keys,
        field_sep=field_sep,
        reverse=reverse,
        unique=unique,
        stable=stable,
    )


def _compute_fields(
    line: str, field_sep: str | None
) -> list[tuple[int, int, int]]:
    fields: list[tuple[int, int, int]] = []
    n = len(line)
    if field_sep:
        pos = 0
        seplen = len(field_sep)
        while True:
            nxt = line.find(field_sep, pos)
            if nxt == -1:
                fields.append((pos, pos, n))
                break
            fields.append((pos, pos, nxt))
            pos = nxt + seplen
        return fields
    i = 0
    while i < n:
        lead_start = i
        while i < n and line[i] in _FIELD_BLANKS:
            i += 1
        content_start = i
        while i < n and line[i] not in _FIELD_BLANKS:
            i += 1
        fields.append((lead_start, content_start, i))
    return fields


def _extract(line: str, fields: list[tuple[int, int, int]], key: Key) -> str:
    n = len(line)
    nf = len(fields)
    if key.start_field > nf:
        return ""
    lead_start, content_start, _ = fields[key.start_field - 1]
    base = content_start if key.start_skip else lead_start
    start = min(base + (key.start_char - 1), n)
    if key.end_field is None:
        end = n
    elif key.end_field > nf:
        end = n
    else:
        e_lead, e_content, e_end = fields[key.end_field - 1]
        if key.end_char is None or key.end_char == 0:
            end = e_end
        else:
            e_base = e_content if key.end_skip else e_lead
            end = min(e_base + key.end_char, n)
    if end < start:
        end = start
    return line[start:end]


def _version_key(s: str) -> list[_VersionPart]:
    parts: list[_VersionPart] = []
    for m in _VERSION_RE.finditer(s):
        if m.group(1):
            parts.append((0, int(m.group(1))))
        else:
            parts.append((1, m.group(2)))
    return parts


def _leading_number(field: str) -> NumericKey:
    """Read a C-locale GNU -n prefix without losing decimal precision.

    Args:
        field (str): extracted sort key, possibly followed by nonnumeric text.
    """
    match = _NUMBER_RE.match(field)
    assert match is not None
    integer = match[2].lstrip("0")
    fraction = (match[3] or "").rstrip("0")
    return NumericKey(
        bool(match[1] and (integer or fraction)), integer, fraction
    )


def _human_number(field: str) -> tuple[int, NumericKey]:
    """sort.c's ``human_numcompare`` key: the unit's order, then the number.

    The unit is the byte after the run of digits and decimal points, so
    ``5.K`` carries K. Its order is negated for a negative number and is
    zero for a zero one, and it outranks the magnitude, so ``1500`` sorts
    before ``1K``.

    Args:
        field (str): extracted sort key, possibly followed by other text.
    """
    match = _UNIT_RE.match(field)
    assert match is not None
    order = 0
    if any("1" <= char <= "9" for char in match[2]):
        order = _UNIT_ORDERS.get(match[3], 0)
    return (-order if match[1] else order), _leading_number(field)


def _parse_general_float(field: str) -> float | None:
    """The number strtold reads at the start of a field, None for none.

    The rest of the field is ignored, as GNU sort -g ignores it.

    Args:
        field (str): the key field.
    """
    found = STRTOD.match(field)
    return None if found is None else strtod_double(found)


def _transform(field: str, mods: KeyMods) -> _SortKey:
    if mods.dictionary:
        field = "".join(
            char for char in field if char.isalnum() or char in _FIELD_BLANKS
        )
    elif mods.ignore_nonprinting:
        field = "".join(char for char in field if char.isprintable())
    if mods.month:
        return _MONTHS.get(field.lstrip(_FIELD_BLANKS)[:3].lower(), 0)
    if mods.human:
        return _human_number(field)
    if mods.version:
        return _version_key(field)
    if mods.numeric:
        return _leading_number(field)
    if mods.general_numeric:
        value = _parse_general_float(field)
        if value is None:
            return (0, 0.0)
        if value != value:
            return (1, 0.0)
        return (2, value)
    if mods.fold:
        return field.lower()
    return field


def _cmp(a: _SortKey | _VersionPart, b: _SortKey | _VersionPart) -> int:
    if isinstance(a, NumericKey) and isinstance(b, NumericKey):
        if a.negative != b.negative:
            return -1 if a.negative else 1
        left = (len(a.integer), a.integer, a.fraction)
        right = (len(b.integer), b.integer, b.fraction)
        order = (left > right) - (left < right)
        return -order if a.negative else order
    if isinstance(a, tuple) and isinstance(b, tuple):
        return _cmp(a[0], b[0]) or _cmp(a[1], b[1])
    if isinstance(a, list) and isinstance(b, list):
        for x, y in zip(a, b):
            c = _cmp(x, y)
            if c:
                return c
        return (len(a) > len(b)) - (len(a) < len(b))
    return (a > b) - (a < b)  # type: ignore[operator]


def compare_lines(a: str, b: str, cfg: SortConfig) -> int:
    """GNU sort's ``compare``: the keys, then the whole line as a last resort.

    ``-s`` and ``-u`` both stop at the keys, so under ``-u`` two lines
    whose keys tie are equal however else they differ, which is what makes
    ``sort -u -k2,2`` keep the first of them in input order and what makes
    ``sort -c -u`` call the pair a disorder. GNU's own condition is
    ``diff || unique || stable``.

    Args:
        a (str): the earlier line.
        b (str): the later line.
        cfg (SortConfig): the keys and global options to compare by.
    """
    fa = _compute_fields(a, cfg.field_sep)
    fb = _compute_fields(b, cfg.field_sep)
    for key in cfg.keys:
        ka = _transform(_extract(a, fa, key), key.mods)
        kb = _transform(_extract(b, fb, key), key.mods)
        c = _cmp(ka, kb)
        if key.mods.reverse:
            c = -c
        if c:
            return c
    if cfg.stable or cfg.unique:
        return 0
    c = (a > b) - (a < b)
    if cfg.reverse:
        c = -c
    return c


def sort_lines(lines: list[str], cfg: SortConfig) -> list[str]:
    compare = partial(compare_lines, cfg=cfg)
    ordered = sorted(lines, key=cmp_to_key(compare))
    if not cfg.unique:
        return ordered
    deduped: list[str] = []
    for line in ordered:
        if not deduped or compare_lines(deduped[-1], line, cfg) != 0:
            deduped.append(line)
    return deduped


def _merge_before(
    runs: list[list[str]], heads: list[int], a: int, b: int, cfg: SortConfig
) -> bool:
    c = compare_lines(runs[a][heads[a]], runs[b][heads[b]], cfg)
    return c < 0 or (c == 0 and a < b)


def merge_lines(runs: list[list[str]], cfg: SortConfig) -> list[str]:
    """GNU sort's ``mergefps``: merge runs it trusts to be sorted already.

    The line emitted next is always the smallest head, a tie going to the
    earlier run, and a run is never reordered, so ``sort -m`` over an
    unsorted file hands it back as it found it, the way GNU does. The runs
    are kept ordered by their heads and a run whose head moves is
    reinserted by binary search, GNU's own ``ord`` table, so a merge of
    ``k`` runs costs ``log k`` comparisons a line. Under ``-u`` a line is
    dropped when it compares equal to the first line of the series it
    would extend, so only adjacent duplicates collapse: ``a b a`` stays
    three lines.

    Args:
        runs (list[list[str]]): one record list per input, in operand
            order.
        cfg (SortConfig): the comparison every line is merged by.
    """
    heads = [0] * len(runs)
    order: list[int] = []
    for run in (i for i, lines in enumerate(runs) if lines):
        slot = len(order)
        while slot > 0 and _merge_before(
            runs, heads, run, order[slot - 1], cfg
        ):
            slot -= 1
        order.insert(slot, run)
    merged: list[str] = []
    saved: str | None = None
    while order:
        run = order[0]
        line = runs[run][heads[run]]
        if (
            not cfg.unique
            or saved is None
            or compare_lines(saved, line, cfg) != 0
        ):
            merged.append(line)
            saved = line
        heads[run] += 1
        if heads[run] == len(runs[run]):
            order.pop(0)
            continue
        lo, hi = 1, len(order)
        while lo < hi:
            probe = (lo + hi) // 2
            if _merge_before(runs, heads, run, order[probe], cfg):
                hi = probe
            else:
                lo = probe + 1
        order[0:lo] = order[1:lo] + [run]
    return merged

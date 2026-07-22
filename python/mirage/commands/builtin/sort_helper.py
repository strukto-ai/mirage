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

_HUMAN_SUFFIXES = {"K": 1e3, "M": 1e6, "G": 1e9, "T": 1e12, "P": 1e15}
_VERSION_RE = re.compile(r"(\d+)|(\D+)")
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
_KEYDEF_RE = re.compile(r"^(\d+)(?:\.(\d+))?([a-zA-Z]*)$")
# GNU key modifier letters. n/g map to numeric; h/V/M/f/r/b are honored;
# d/i/R are recognized so they still suppress global options (per GNU
# key_init) but are not yet applied as filters.
_ORDER_LETTERS = frozenset("bdfgiMnRrV")


class SortKeyError(ValueError):
    pass


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


def _parse_pos(spec: str, is_end: bool) -> tuple[int, int | None, str]:
    match = _KEYDEF_RE.match(spec)
    if match is None:
        raise SortKeyError(f"invalid field specification '{spec}'")
    field = int(match.group(1))
    if field == 0:
        raise SortKeyError(f"field number is zero: invalid field "
                           f"specification '{spec}'")
    char_group = match.group(2)
    letters = match.group(3)
    for letter in letters:
        if letter not in _ORDER_LETTERS:
            raise SortKeyError(f"invalid ordering option '{letter}'")
    if char_group is None:
        char = None if is_end else 1
    else:
        char = int(char_group)
        if not is_end and char == 0:
            char = 1
    return field, char, letters


def _mods_from_letters(*letter_runs: str) -> tuple[KeyMods, bool]:
    letters = "".join(letter_runs)
    has_own = any(letter in _ORDER_LETTERS for letter in letters)
    numeric = "n" in letters
    return KeyMods(
        numeric=numeric,
        general_numeric="g" in letters,
        human="h" in letters,
        version="V" in letters,
        month="M" in letters,
        fold="f" in letters,
        reverse="r" in letters,
        dictionary="d" in letters,
        ignore_nonprinting="i" in letters,
    ), has_own


def parse_keydef(spec: str, global_mods: KeyMods, global_skip: bool) -> Key:
    start_spec, _, end_spec = spec.partition(",")
    start_field, start_char, start_letters = _parse_pos(start_spec, False)
    if end_spec:
        end_field, end_char, end_letters = _parse_pos(end_spec, True)
    else:
        end_field, end_char, end_letters = None, None, ""
    own_mods, has_own = _mods_from_letters(start_letters, end_letters)
    if has_own:
        mods = own_mods
        start_skip = "b" in start_letters
        end_skip = "b" in end_letters
    else:
        mods = global_mods
        start_skip = global_skip
        end_skip = global_skip
    return Key(
        start_field=start_field,
        start_char=start_char if start_char is not None else 1,
        start_skip=start_skip,
        end_field=end_field,
        end_char=end_char,
        end_skip=end_skip,
        mods=mods,
    )


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
            parse_keydef(spec, global_mods, ignore_blanks)
            for spec in key_defs)
    else:
        keys = (Key(1, 1, ignore_blanks, None, None, ignore_blanks,
                    global_mods), )
    return SortConfig(
        keys=keys,
        field_sep=field_sep,
        reverse=reverse,
        unique=unique,
        stable=stable,
    )


def _compute_fields(line: str,
                    field_sep: str | None) -> list[tuple[int, int, int]]:
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
        while i < n and line[i] in " \t":
            i += 1
        content_start = i
        while i < n and line[i] not in " \t":
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


def _parse_human(s: str) -> float:
    s = s.strip()
    if not s:
        return 0.0
    suffix = s[-1].upper()
    if suffix in _HUMAN_SUFFIXES:
        try:
            return float(s[:-1]) * _HUMAN_SUFFIXES[suffix]
        except ValueError:
            return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


def _version_key(s: str) -> list[object]:
    parts: list[object] = []
    for m in _VERSION_RE.finditer(s):
        if m.group(1):
            parts.append((0, int(m.group(1))))
        else:
            parts.append((1, m.group(2)))
    return parts


def _leading_number(field: str) -> float:
    field = field.lstrip()
    num_end = 0
    for ch in field:
        if ch.isdigit() or (ch in ".+-" and num_end == 0):
            num_end += 1
        else:
            break
    try:
        return float(field[:num_end]) if num_end else 0.0
    except ValueError:
        return 0.0


def _transform(field: str, mods: KeyMods) -> object:
    if mods.dictionary:
        field = "".join(char for char in field
                        if char.isalnum() or char in " \t")
    elif mods.ignore_nonprinting:
        field = "".join(char for char in field if char.isprintable())
    if mods.month:
        return _MONTHS.get(field.strip()[:3].lower(), 0)
    if mods.human:
        return _parse_human(field)
    if mods.version:
        return _version_key(field)
    if mods.numeric:
        return _leading_number(field)
    if mods.general_numeric:
        stripped = field.lstrip()
        try:
            value = float(stripped)
        except ValueError:
            return (0, 0.0)
        if value != value:
            return (1, 0.0)
        return (2, value)
    if mods.fold:
        return field.lower()
    return field


def _cmp(a: object, b: object) -> int:
    if isinstance(a, list) and isinstance(b, list):
        for x, y in zip(a, b):
            c = _cmp(x, y)
            if c:
                return c
        return (len(a) > len(b)) - (len(a) < len(b))
    return (a > b) - (a < b)  # type: ignore[operator]


def compare_lines(a: str, b: str, cfg: SortConfig) -> int:
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
    if cfg.stable:
        return 0
    c = (a > b) - (a < b)
    if cfg.reverse:
        c = -c
    return c


def _dedup_key(line: str, cfg: SortConfig) -> tuple[object, ...]:
    fields = _compute_fields(line, cfg.field_sep)
    parts: list[object] = []
    for key in cfg.keys:
        value = _transform(_extract(line, fields, key), key.mods)
        parts.append(tuple(value) if isinstance(value, list) else value)
    return tuple(parts)


def sort_lines(lines: list[str], cfg: SortConfig) -> list[str]:
    compare = partial(compare_lines, cfg=cfg)
    ordered = sorted(lines, key=cmp_to_key(compare))
    if not cfg.unique:
        return ordered
    seen: set[tuple[object, ...]] = set()
    deduped: list[str] = []
    for line in ordered:
        dk = _dedup_key(line, cfg)
        if dk not in seen:
            seen.add(dk)
            deduped.append(line)
    return deduped

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


def _sort_key(
    line: str,
    key_field: int | None,
    field_sep: str | None,
    ignore_case: bool,
    numeric: bool,
    human_numeric: bool = False,
    version: bool = False,
    month: bool = False,
    strip_blanks: bool = False,
) -> object:
    if key_field is not None:
        sep = field_sep if field_sep else None
        parts = line.split(sep)
        field = parts[key_field - 1] if key_field - 1 < len(parts) else ""
        # GNU -b: ignore the key field's leading blanks; the default
        # whitespace separator already strips them, -t does not.
        if strip_blanks:
            field = field.lstrip(" \t")
    else:
        field = line
    if ignore_case:
        field_lower = field.lower()
        if not numeric and not human_numeric and not version and not month:
            return (field_lower, field)
        field = field_lower
    if month:
        abbr = field.strip()[:3].lower()
        return _MONTHS.get(abbr, 0)
    if human_numeric:
        return _parse_human(field)
    if version:
        return _version_key(field)
    if numeric:
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
    return field


def _unique_key(key: object) -> object:
    if isinstance(key, tuple):
        return key[0]
    if isinstance(key, list):
        return tuple(key)
    return key

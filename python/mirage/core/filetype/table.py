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

import math
import re
from typing import Any

from mirage.core.filetype.constants import CANONICAL_TYPES


def canonical_type(raw: str) -> str:
    key = raw.strip().lower()
    return CANONICAL_TYPES.get(key, key)


def js_number(value: float) -> str:
    if math.isnan(value):
        return "NaN"
    if value == math.inf:
        return "Infinity"
    if value == -math.inf:
        return "-Infinity"
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    text = repr(abs(value))
    mantissa, _, exp_part = text.partition("e")
    exp = int(exp_part) if exp_part else 0
    int_part, _, frac_part = mantissa.partition(".")
    digits = int_part + frac_part
    point = len(int_part) + exp
    lead = 0
    while lead < len(digits) - 1 and digits[lead] == "0":
        lead += 1
        point -= 1
    digits = digits[lead:].rstrip("0") or "0"
    k = len(digits)
    n = point
    if k <= n <= 21:
        body = digits + "0" * (n - k)
    elif 0 < n <= 21:
        body = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        body = "0." + "0" * (-n) + digits
    else:
        rest = digits[1:]
        mant = digits[0] + ("." + rest if rest else "")
        e = n - 1
        body = f"{mant}e{'+' if e >= 0 else '-'}{abs(e)}"
    return sign + body


def format_cell(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return js_number(value)
    if isinstance(value, str):
        return value
    if isinstance(value, (bytes, bytearray)):
        return f"<{len(value)}B>"
    return str(value)


def render_schema(fields: list[tuple[str, str]]) -> list[str]:
    lines = ["## Schema"]
    for name, type_name in fields:
        lines.append(f"  {name}: {type_name}")
    return lines


def render_table(rows: list[dict[str, Any]], label: str,
                 count: int) -> list[str]:
    lines = [f"## {label} ({count} rows)", ""]
    if not rows:
        lines.append("(empty)")
        lines.append("")
        return lines
    columns = list(rows[0].keys())
    widths = {c: len(c) for c in columns}
    rendered: list[list[str]] = []
    for row in rows:
        cells = [format_cell(row.get(c)) for c in columns]
        for i, c in enumerate(columns):
            widths[c] = max(widths[c], len(cells[i]))
        rendered.append(cells)
    lines.append(" ".join(c.rjust(widths[c]) for c in columns))
    for cells in rendered:
        lines.append(" ".join(cells[i].rjust(widths[columns[i]])
                              for i in range(len(columns))))
    lines.append("")
    return lines


def _csv_escape(value: object) -> str:
    if value is None:
        return ""
    text = format_cell(value)
    if "," in text or '"' in text or "\n" in text:
        return '"' + text.replace('"', '""') + '"'
    return text


def to_csv(rows: list[dict[str, Any]]) -> bytes:
    if not rows:
        return b""
    columns = list(rows[0].keys())
    lines = [",".join(columns)]
    for row in rows:
        lines.append(",".join(_csv_escape(row.get(c)) for c in columns))
    return ("\n".join(lines) + "\n").encode()


def grep_rows(rows: list[dict[str, Any]],
              pattern: str,
              ignore_case: bool = False) -> list[dict[str, Any]]:
    flags = re.IGNORECASE if ignore_case else 0
    regex = re.compile(pattern, flags)
    matched = []
    for row in rows:
        if any(isinstance(v, str) and regex.search(v) for v in row.values()):
            matched.append(row)
    return matched


def cut_columns(rows: list[dict[str, Any]], schema_names: list[str],
                columns: list[str]) -> list[dict[str, Any]]:
    for col in columns:
        if col not in schema_names:
            raise ValueError(f"column not found: {col}")
    return [{col: row.get(col) for col in columns} for row in rows]

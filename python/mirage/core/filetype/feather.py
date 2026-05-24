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

import io
import re

import pandas as pd
import pyarrow as pa
import pyarrow.feather as feather

_MAX_PREVIEW_ROWS = 20


def _read_table(raw: bytes) -> pa.Table:
    return feather.read_table(io.BytesIO(raw))


def _render_schema(schema: pa.Schema) -> list[str]:
    lines = ["## Schema"]
    for field in schema:
        lines.append(f"  {field.name}: {field.type}")
    return lines


def _render_table(table: pa.Table, label: str, count: int) -> list[str]:
    lines = [f"## {label} ({count} rows)", ""]
    lines.append(table.to_pandas().to_string(index=False))
    lines.append("")
    return lines


def cat(raw: bytes, max_rows: int = _MAX_PREVIEW_ROWS) -> bytes:
    table = _read_table(raw)
    schema = table.schema
    num_rows = table.num_rows
    preview = table.slice(0, max_rows)
    preview_count = min(num_rows, max_rows)
    lines = [f"# Rows: {num_rows}, Columns: {len(schema)}", ""]
    lines.extend(_render_schema(schema))
    lines.append("")
    lines.extend(_render_table(preview, "Preview", preview_count))
    return "\n".join(lines).encode()


def head(raw: bytes, n: int = 10) -> bytes:
    table = _read_table(raw)
    schema = table.schema
    num_rows = table.num_rows
    rows_needed = min(n, num_rows)
    result = table.slice(0, rows_needed)
    lines = [f"# Rows: {num_rows}, Columns: {len(schema)}", ""]
    lines.extend(_render_schema(schema))
    lines.append("")
    lines.extend(_render_table(result, f"First {rows_needed}", rows_needed))
    return "\n".join(lines).encode()


def tail(raw: bytes, n: int = 10) -> bytes:
    table = _read_table(raw)
    schema = table.schema
    num_rows = table.num_rows
    rows_needed = min(n, num_rows)
    result = table.slice(max(0, num_rows - rows_needed), rows_needed)
    lines = [f"# Rows: {num_rows}, Columns: {len(schema)}", ""]
    lines.extend(_render_schema(schema))
    lines.append("")
    lines.extend(_render_table(result, f"Last {rows_needed}", rows_needed))
    return "\n".join(lines).encode()


def wc(raw: bytes) -> int:
    table = _read_table(raw)
    return table.num_rows


def stat(raw: bytes) -> bytes:
    table = _read_table(raw)
    schema = table.schema
    num_rows = table.num_rows
    lines = [
        "# Feather file",
        f"rows: {num_rows}",
        f"columns: {len(schema)}",
        "",
    ]
    lines.extend(_render_schema(schema))
    lines.append("")
    return "\n".join(lines).encode()


def grep(raw: bytes, pattern: str, ignore_case: bool = False) -> bytes:
    flags = re.IGNORECASE if ignore_case else 0
    regex = re.compile(pattern, flags)
    table = _read_table(raw)
    df = table.to_pandas()
    str_cols = df.select_dtypes(include=["object", "string"]).columns
    if len(str_cols) == 0:
        return df.head(0).to_csv(index=False).encode()
    row_mask = pd.Series(False, index=df.index)
    for col_name in str_cols:
        row_mask = row_mask | df[col_name].astype(str).str.contains(regex,
                                                                    na=False)
    matched = df[row_mask]
    return matched.to_csv(index=False).encode()


def cut(raw: bytes, columns: list[str]) -> bytes:
    table = _read_table(raw)
    schema_names = [f.name for f in table.schema]
    for col in columns:
        if col not in schema_names:
            raise ValueError(f"column not found: {col}")
    result = table.select(columns)
    return result.to_pandas().to_csv(index=False).encode()


def file(raw: bytes) -> bytes:
    table = _read_table(raw)
    schema = table.schema
    cols = ", ".join(f"{f.name}: {f.type}" for f in schema)
    return (f"feather, {table.num_rows} rows, {len(schema)} columns"
            f" ({cols})").encode()


def ls(raw: bytes) -> tuple[int, int]:
    table = _read_table(raw)
    return table.num_rows, len(table.schema)

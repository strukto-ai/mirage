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
import pyarrow.parquet as pq

_MAX_PREVIEW_ROWS = 20


def _open(raw: bytes) -> pq.ParquetFile:
    return pq.ParquetFile(io.BytesIO(raw))


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
    pf = _open(raw)
    schema = pf.schema_arrow
    num_rows = pf.metadata.num_rows
    batches: list[pa.Table] = []
    collected = 0
    for i in range(pf.metadata.num_row_groups):
        if collected >= max_rows:
            break
        rg = pf.read_row_group(i)
        batches.append(rg)
        collected += rg.num_rows
    table = pa.concat_tables(batches).slice(0, max_rows)
    preview_count = min(num_rows, max_rows)
    lines = [f"# Rows: {num_rows}, Columns: {len(schema)}", ""]
    lines.extend(_render_schema(schema))
    lines.append("")
    lines.extend(_render_table(table, "Preview", preview_count))
    return "\n".join(lines).encode()


def head(raw: bytes, n: int = 10) -> bytes:
    pf = _open(raw)
    schema = pf.schema_arrow
    num_rows = pf.metadata.num_rows
    rows_needed = min(n, num_rows)
    batches: list[pa.Table] = []
    collected = 0
    for i in range(pf.metadata.num_row_groups):
        if collected >= rows_needed:
            break
        rg = pf.read_row_group(i)
        batches.append(rg)
        collected += rg.num_rows
    table = pa.concat_tables(batches).slice(0, rows_needed)
    lines = [f"# Rows: {num_rows}, Columns: {len(schema)}", ""]
    lines.extend(_render_schema(schema))
    lines.append("")
    lines.extend(_render_table(table, f"First {rows_needed}", rows_needed))
    return "\n".join(lines).encode()


def tail(raw: bytes, n: int = 10) -> bytes:
    pf = _open(raw)
    schema = pf.schema_arrow
    num_rows = pf.metadata.num_rows
    rows_needed = min(n, num_rows)
    batches: list[pa.Table] = []
    collected = 0
    for i in range(pf.metadata.num_row_groups - 1, -1, -1):
        if collected >= rows_needed:
            break
        rg = pf.read_row_group(i)
        batches.insert(0, rg)
        collected += rg.num_rows
    combined = pa.concat_tables(batches)
    table = combined.slice(max(0, combined.num_rows - rows_needed),
                           rows_needed)
    lines = [f"# Rows: {num_rows}, Columns: {len(schema)}", ""]
    lines.extend(_render_schema(schema))
    lines.append("")
    lines.extend(_render_table(table, f"Last {rows_needed}", rows_needed))
    return "\n".join(lines).encode()


def wc(raw: bytes) -> int:
    pf = _open(raw)
    return pf.metadata.num_rows


def stat(raw: bytes) -> bytes:
    pf = _open(raw)
    meta = pf.metadata
    schema = pf.schema_arrow
    lines = [
        "# Parquet file",
        f"rows: {meta.num_rows}",
        f"columns: {meta.num_columns}",
        f"row_groups: {meta.num_row_groups}",
        f"format_version: {meta.format_version}",
        f"serialized_size: {meta.serialized_size}",
        "",
    ]
    lines.extend(_render_schema(schema))
    lines.append("")
    for i in range(meta.num_row_groups):
        rg = meta.row_group(i)
        lines.append(f"## Row group {i}")
        lines.append(f"  rows: {rg.num_rows}")
        lines.append(f"  total_byte_size: {rg.total_byte_size}")
    lines.append("")
    return "\n".join(lines).encode()


def grep(raw: bytes, pattern: str, ignore_case: bool = False) -> bytes:
    flags = re.IGNORECASE if ignore_case else 0
    regex = re.compile(pattern, flags)
    pf = _open(raw)
    table = pf.read()
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
    pf = _open(raw)
    schema_names = [f.name for f in pf.schema_arrow]
    for col in columns:
        if col not in schema_names:
            raise ValueError(f"column not found: {col}")
    table = pf.read(columns=columns)
    return table.to_pandas().to_csv(index=False).encode()


def file(raw: bytes) -> bytes:
    pf = _open(raw)
    meta = pf.metadata
    cols = ", ".join(f"{f.name}: {f.type}" for f in pf.schema_arrow)
    return (f"parquet, {meta.num_rows} rows, {meta.num_columns} columns"
            f" ({cols})").encode()


def ls(raw: bytes) -> tuple[int, int]:
    pf = _open(raw)
    return pf.metadata.num_rows, len(pf.schema_arrow)

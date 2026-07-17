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

import pyarrow as pa
import pyarrow.parquet as pq

from mirage.core.filetype import table as tbl
from mirage.core.filetype.constants import MAX_PREVIEW_ROWS


def _open(raw: bytes) -> pq.ParquetFile:
    return pq.ParquetFile(io.BytesIO(raw))


def _fields(schema: pa.Schema) -> list[tuple[str, str]]:
    return [(f.name, tbl.canonical_type(str(f.type))) for f in schema]


def _columns(schema: pa.Schema) -> list[str]:
    return [f.name for f in schema]


def _read_head(pf: pq.ParquetFile, rows_needed: int) -> pa.Table:
    batches: list[pa.Table] = []
    collected = 0
    for i in range(pf.metadata.num_row_groups):
        if collected >= rows_needed:
            break
        rg = pf.read_row_group(i)
        batches.append(rg)
        collected += rg.num_rows
    if not batches:
        return pf.read().slice(0, 0)
    return pa.concat_tables(batches).slice(0, rows_needed)


def cat(raw: bytes, max_rows: int = MAX_PREVIEW_ROWS) -> bytes:
    pf = _open(raw)
    schema = pf.schema_arrow
    num_rows = pf.metadata.num_rows
    preview_count = min(num_rows, max_rows)
    rows = _read_head(pf, preview_count).to_pylist()
    lines = [f"# Rows: {num_rows}, Columns: {len(schema)}", ""]
    lines.extend(tbl.render_schema(_fields(schema)))
    lines.append("")
    lines.extend(tbl.render_table(rows, "Preview", preview_count))
    return "\n".join(lines).encode()


def head(raw: bytes, n: int = 10) -> bytes:
    pf = _open(raw)
    schema = pf.schema_arrow
    num_rows = pf.metadata.num_rows
    rows_needed = min(n, num_rows)
    rows = _read_head(pf, rows_needed).to_pylist()
    lines = [f"# Rows: {num_rows}, Columns: {len(schema)}", ""]
    lines.extend(tbl.render_schema(_fields(schema)))
    lines.append("")
    lines.extend(tbl.render_table(rows, f"First {rows_needed}", rows_needed))
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
    combined = pa.concat_tables(batches) if batches else pf.read().slice(0, 0)
    result = combined.slice(max(0, combined.num_rows - rows_needed),
                            rows_needed)
    rows = result.to_pylist()
    lines = [f"# Rows: {num_rows}, Columns: {len(schema)}", ""]
    lines.extend(tbl.render_schema(_fields(schema)))
    lines.append("")
    lines.extend(tbl.render_table(rows, f"Last {rows_needed}", rows_needed))
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
    lines.extend(tbl.render_schema(_fields(schema)))
    lines.append("")
    for i in range(meta.num_row_groups):
        rg = meta.row_group(i)
        lines.append(f"## Row group {i}")
        lines.append(f"  rows: {rg.num_rows}")
        lines.append(f"  total_byte_size: {rg.total_byte_size}")
    lines.append("")
    return "\n".join(lines).encode()


def grep(raw: bytes, pattern: str, ignore_case: bool = False) -> bytes:
    pf = _open(raw)
    rows = pf.read().to_pylist()
    matched = tbl.grep_rows(rows, pattern, ignore_case)
    return tbl.to_csv(matched)


def cut(raw: bytes, columns: list[str]) -> bytes:
    pf = _open(raw)
    rows = pf.read().to_pylist()
    projected = tbl.cut_columns(rows, _columns(pf.schema_arrow), list(columns))
    return tbl.to_csv(projected)


def file(raw: bytes) -> bytes:
    pf = _open(raw)
    meta = pf.metadata
    cols = ", ".join(f"{name}: {type_name}"
                     for name, type_name in _fields(pf.schema_arrow))
    return (f"parquet, {meta.num_rows} rows, {meta.num_columns} columns"
            f" ({cols})").encode()

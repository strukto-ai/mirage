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
import pyarrow.orc as orc

from mirage.core.filetype import table as tbl
from mirage.core.filetype.constants import MAX_PREVIEW_ROWS


def _open(raw: bytes) -> orc.ORCFile:
    return orc.ORCFile(io.BytesIO(raw))


def _fields(schema: pa.Schema) -> list[tuple[str, str]]:
    return [(f.name, tbl.canonical_type(str(f.type))) for f in schema]


def _columns(schema: pa.Schema) -> list[str]:
    return [f.name for f in schema]


def _read_head(f: orc.ORCFile, rows_needed: int) -> pa.Table:
    batches: list[pa.RecordBatch] = []
    collected = 0
    for i in range(f.nstripes):
        if collected >= rows_needed:
            break
        stripe = f.read_stripe(i)
        batches.append(stripe)
        collected += stripe.num_rows
    if not batches:
        return f.read().slice(0, 0)
    return pa.Table.from_batches(batches).slice(0, rows_needed)


def cat(raw: bytes, max_rows: int = MAX_PREVIEW_ROWS) -> bytes:
    f = _open(raw)
    schema = f.schema
    num_rows = f.nrows
    preview_count = min(num_rows, max_rows)
    rows = _read_head(f, preview_count).to_pylist()
    lines = [f"# Rows: {num_rows}, Columns: {len(schema)}", ""]
    lines.extend(tbl.render_schema(_fields(schema)))
    lines.append("")
    lines.extend(tbl.render_table(rows, "Preview", preview_count))
    return "\n".join(lines).encode()


def head(raw: bytes, n: int = 10) -> bytes:
    f = _open(raw)
    schema = f.schema
    num_rows = f.nrows
    rows_needed = min(n, num_rows)
    rows = _read_head(f, rows_needed).to_pylist()
    lines = [f"# Rows: {num_rows}, Columns: {len(schema)}", ""]
    lines.extend(tbl.render_schema(_fields(schema)))
    lines.append("")
    lines.extend(tbl.render_table(rows, f"First {rows_needed}", rows_needed))
    return "\n".join(lines).encode()


def tail(raw: bytes, n: int = 10) -> bytes:
    f = _open(raw)
    schema = f.schema
    num_rows = f.nrows
    rows_needed = min(n, num_rows)
    batches: list[pa.RecordBatch] = []
    collected = 0
    for i in range(f.nstripes - 1, -1, -1):
        if collected >= rows_needed:
            break
        stripe = f.read_stripe(i)
        batches.insert(0, stripe)
        collected += stripe.num_rows
    combined = pa.Table.from_batches(batches) if batches else f.read().slice(
        0, 0)
    result = combined.slice(max(0, combined.num_rows - rows_needed),
                            rows_needed)
    rows = result.to_pylist()
    lines = [f"# Rows: {num_rows}, Columns: {len(schema)}", ""]
    lines.extend(tbl.render_schema(_fields(schema)))
    lines.append("")
    lines.extend(tbl.render_table(rows, f"Last {rows_needed}", rows_needed))
    return "\n".join(lines).encode()


def wc(raw: bytes) -> int:
    f = _open(raw)
    return f.nrows


def stat(raw: bytes) -> bytes:
    f = _open(raw)
    schema = f.schema
    num_rows = f.nrows
    lines = [
        "# ORC file",
        f"rows: {num_rows}",
        f"columns: {len(schema)}",
        f"stripes: {f.nstripes}",
        "",
    ]
    lines.extend(tbl.render_schema(_fields(schema)))
    lines.append("")
    for i in range(f.nstripes):
        stripe = f.read_stripe(i)
        lines.append(f"## Stripe {i}")
        lines.append(f"  rows: {stripe.num_rows}")
    lines.append("")
    return "\n".join(lines).encode()


def grep(raw: bytes, pattern: str, ignore_case: bool = False) -> bytes:
    f = _open(raw)
    rows = f.read().to_pylist()
    matched = tbl.grep_rows(rows, pattern, ignore_case)
    return tbl.to_csv(matched)


def cut(raw: bytes, columns: list[str]) -> bytes:
    f = _open(raw)
    rows = f.read().to_pylist()
    projected = tbl.cut_columns(rows, _columns(f.schema), list(columns))
    return tbl.to_csv(projected)


def file(raw: bytes) -> bytes:
    f = _open(raw)
    schema = f.schema
    cols = ", ".join(f"{name}: {type_name}"
                     for name, type_name in _fields(schema))
    return (f"orc, {f.nrows} rows, {len(schema)} columns, "
            f"{f.nstripes} stripes ({cols})").encode()


def ls(raw: bytes) -> tuple[int, int]:
    f = _open(raw)
    return f.nrows, len(f.schema)

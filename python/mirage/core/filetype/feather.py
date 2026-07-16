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
import pyarrow.feather as feather

from mirage.core.filetype import table as tbl
from mirage.core.filetype.constants import MAX_PREVIEW_ROWS


def _read_table(raw: bytes) -> pa.Table:
    return feather.read_table(io.BytesIO(raw))


def _fields(schema: pa.Schema) -> list[tuple[str, str]]:
    return [(f.name, tbl.canonical_type(str(f.type))) for f in schema]


def _columns(schema: pa.Schema) -> list[str]:
    return [f.name for f in schema]


def cat(raw: bytes, max_rows: int = MAX_PREVIEW_ROWS) -> bytes:
    table = _read_table(raw)
    schema = table.schema
    num_rows = table.num_rows
    preview_count = min(num_rows, max_rows)
    rows = table.slice(0, preview_count).to_pylist()
    lines = [f"# Rows: {num_rows}, Columns: {len(schema)}", ""]
    lines.extend(tbl.render_schema(_fields(schema)))
    lines.append("")
    lines.extend(tbl.render_table(rows, "Preview", preview_count))
    return "\n".join(lines).encode()


def head(raw: bytes, n: int = 10) -> bytes:
    table = _read_table(raw)
    schema = table.schema
    num_rows = table.num_rows
    rows_needed = min(n, num_rows)
    rows = table.slice(0, rows_needed).to_pylist()
    lines = [f"# Rows: {num_rows}, Columns: {len(schema)}", ""]
    lines.extend(tbl.render_schema(_fields(schema)))
    lines.append("")
    lines.extend(tbl.render_table(rows, f"First {rows_needed}", rows_needed))
    return "\n".join(lines).encode()


def tail(raw: bytes, n: int = 10) -> bytes:
    table = _read_table(raw)
    schema = table.schema
    num_rows = table.num_rows
    rows_needed = min(n, num_rows)
    rows = table.slice(max(0, num_rows - rows_needed), rows_needed).to_pylist()
    lines = [f"# Rows: {num_rows}, Columns: {len(schema)}", ""]
    lines.extend(tbl.render_schema(_fields(schema)))
    lines.append("")
    lines.extend(tbl.render_table(rows, f"Last {rows_needed}", rows_needed))
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
    lines.extend(tbl.render_schema(_fields(schema)))
    lines.append("")
    return "\n".join(lines).encode()


def grep(raw: bytes, pattern: str, ignore_case: bool = False) -> bytes:
    table = _read_table(raw)
    rows = table.to_pylist()
    matched = tbl.grep_rows(rows, pattern, ignore_case)
    return tbl.to_csv(matched)


def cut(raw: bytes, columns: list[str]) -> bytes:
    table = _read_table(raw)
    rows = table.to_pylist()
    projected = tbl.cut_columns(rows, _columns(table.schema), list(columns))
    return tbl.to_csv(projected)


def file(raw: bytes) -> bytes:
    table = _read_table(raw)
    schema = table.schema
    cols = ", ".join(f"{name}: {type_name}"
                     for name, type_name in _fields(schema))
    return (f"feather, {table.num_rows} rows, {len(schema)} columns"
            f" ({cols})").encode()


def ls(raw: bytes) -> tuple[int, int]:
    table = _read_table(raw)
    return table.num_rows, len(table.schema)

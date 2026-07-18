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

import tempfile
from typing import Any

import h5py
import pandas as pd

from mirage.core.filetype import table as tbl
from mirage.core.filetype.constants import MAX_PREVIEW_ROWS


def _read_df(raw: bytes) -> pd.DataFrame:
    with tempfile.NamedTemporaryFile(suffix=".h5", delete=False) as f:
        f.write(raw)
        tmp = f.name
    try:
        store = pd.HDFStore(tmp, mode="r")
        try:
            keys = store.keys()
            if not keys:
                raise ValueError("no datasets found in HDF5 file")
            return store[keys[0]]
        finally:
            store.close()
    except Exception:
        with h5py.File(tmp, "r") as hf:
            keys = list(hf.keys())
            if not keys:
                raise ValueError("no datasets found in HDF5 file")
            dset = hf[keys[0]]
            if hasattr(dset, "shape") and len(dset.shape) == 2:
                return pd.DataFrame(dset[:])
            if hasattr(dset, "dtype") and dset.dtype.names:
                return pd.DataFrame(dset[:])
            raise ValueError("unsupported HDF5 dataset structure")


def _scalar(value: object) -> object:
    if hasattr(value, "item"):
        value = value.item()
    if isinstance(value, (bytes, bytearray)):
        return value.decode("utf-8", "replace")
    return value


def _columns(df: pd.DataFrame) -> list[str]:
    return [str(c) for c in df.columns]


def _fields(df: pd.DataFrame) -> list[tuple[str, str]]:
    return [(str(c), tbl.canonical_type(str(df[c].dtype))) for c in df.columns]


def _rows(df: pd.DataFrame) -> list[dict[str, Any]]:
    columns = _columns(df)
    out: list[dict[str, Any]] = []
    for record in df.to_dict("records"):
        out.append({
            col: _scalar(value)
            for col, value in zip(columns, record.values())
        })
    return out


def cat(raw: bytes, max_rows: int = MAX_PREVIEW_ROWS) -> bytes:
    df = _read_df(raw)
    num_rows = len(df)
    preview_count = min(num_rows, max_rows)
    rows = _rows(df.head(max_rows))
    lines = [f"# Rows: {num_rows}, Columns: {len(df.columns)}", ""]
    lines.extend(tbl.render_schema(_fields(df)))
    lines.append("")
    lines.extend(tbl.render_table(rows, "Preview", preview_count))
    return "\n".join(lines).encode()


def head(raw: bytes, n: int = 10) -> bytes:
    df = _read_df(raw)
    num_rows = len(df)
    rows_needed = min(n, num_rows)
    rows = _rows(df.head(rows_needed))
    lines = [f"# Rows: {num_rows}, Columns: {len(df.columns)}", ""]
    lines.extend(tbl.render_schema(_fields(df)))
    lines.append("")
    lines.extend(tbl.render_table(rows, f"First {rows_needed}", rows_needed))
    return "\n".join(lines).encode()


def tail(raw: bytes, n: int = 10) -> bytes:
    df = _read_df(raw)
    num_rows = len(df)
    rows_needed = min(n, num_rows)
    rows = _rows(df.tail(rows_needed))
    lines = [f"# Rows: {num_rows}, Columns: {len(df.columns)}", ""]
    lines.extend(tbl.render_schema(_fields(df)))
    lines.append("")
    lines.extend(tbl.render_table(rows, f"Last {rows_needed}", rows_needed))
    return "\n".join(lines).encode()


def wc(raw: bytes) -> int:
    return len(_read_df(raw))


def stat(raw: bytes) -> bytes:
    df = _read_df(raw)
    lines = [
        "# HDF5 file",
        f"rows: {len(df)}",
        f"columns: {len(df.columns)}",
        "",
    ]
    lines.extend(tbl.render_schema(_fields(df)))
    lines.append("")
    return "\n".join(lines).encode()


def grep(raw: bytes, pattern: str, ignore_case: bool = False) -> bytes:
    df = _read_df(raw)
    matched = tbl.grep_rows(_rows(df), pattern, ignore_case)
    return tbl.to_csv(matched)


def cut(raw: bytes, columns: list[str]) -> bytes:
    df = _read_df(raw)
    projected = tbl.cut_columns(_rows(df), _columns(df), list(columns))
    return tbl.to_csv(projected)


def file(raw: bytes) -> bytes:
    df = _read_df(raw)
    cols = ", ".join(f"{name}: {type_name}" for name, type_name in _fields(df))
    return (f"hdf5, {len(df)} rows, {len(df.columns)} columns"
            f" ({cols})").encode()

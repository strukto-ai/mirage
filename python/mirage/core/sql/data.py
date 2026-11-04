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

from collections.abc import Sequence

from mirage.accessor.sql import SqlAccessor
from mirage.core.sql.constants import SQL
from mirage.core.sql.inode import Inode, InoRef, by_ino, insert_rows
from mirage.vfs.sql.types import SqlRow, SqlStatement, SqlValue


def _bytes_of(value: SqlValue | None) -> bytes:
    return (
        bytes(value)
        if isinstance(value, (bytes, bytearray, memoryview))
        else b""
    )


async def read_bytes(
    accessor: SqlAccessor,
    node: Inode,
    offset: int = 0,
    length: int | None = None,
) -> bytes:
    """The bytes ``[offset, offset + length)`` of ``node``, cut at its
    size; a row the file never wrote, or one shorter than the chunk
    size, reads as zeros, as a sparse file does. Mirrors TypeScript's
    ``readBytes``."""
    stop = node.size if length is None else min(offset + length, node.size)
    if stop <= offset:
        return b""
    cs = await accessor.chunk_size()
    rows = await accessor.query(
        SQL["chunks"], (node.ino, offset // cs, (stop - 1) // cs)
    )
    return fill_bytes(rows, cs, offset, stop)


def fill_bytes(
    rows: Sequence[SqlRow], cs: int, offset: int, stop: int
) -> bytes:
    """The bytes ``[offset, stop)`` that ``fs_data`` rows of ``cs``
    bytes hold, zeros where none does. Mirrors TypeScript's
    ``fillBytes``."""
    out = bytearray(stop - offset)
    for row in rows:
        base = int(row["chunk_index"] or 0) * cs
        data = _bytes_of(row["data"])
        start = max(base, offset)
        end = min(base + len(data), stop)
        if end > start:
            out[start - offset : end - offset] = data[
                start - base : end - base
            ]
    return bytes(out)


async def place_bytes(
    accessor: SqlAccessor,
    ino: InoRef,
    node: Inode | None,
    offset: int,
    data: bytes,
) -> list[SqlStatement]:
    """The statements that put ``data`` at ``offset`` of a file: its
    rows from the one ``offset`` falls in to the one the end falls in,
    rewritten whole. The first and last of them keep the bytes outside
    ``data`` they held, read first, so only those two rows are read
    whatever ``data`` spans. ``node`` is the file when it has rows; a
    file a statement earlier in the batch makes has none. Mirrors
    TypeScript's ``placeBytes``."""
    if not data:
        return []
    cs = await accessor.chunk_size()
    size = node.size if node is not None else 0
    end = offset + len(data)
    first = offset // cs
    last = (end - 1) // cs
    start = first * cs
    region = bytearray(min((last + 1) * cs, max(end, size)) - start)
    out: list[SqlStatement] = []
    if node is not None:
        keep_head = offset > start and size > start
        keep_tail = start + len(region) > end
        if keep_head or keep_tail:
            edges = sorted(
                {first if keep_head else last, last if keep_tail else first}
            )
            rows = await accessor.query(
                "SELECT chunk_index, data FROM fs_data WHERE ino = ? AND"
                f" chunk_index IN ({', '.join('?' for _ in edges)})",
                (node.ino, *edges),
            )
            for row in rows:
                at = (int(row["chunk_index"] or 0) - first) * cs
                kept = _bytes_of(row["data"])[: len(region) - at]
                region[at : at + len(kept)] = kept
        out.append(
            SqlStatement(
                f"DELETE FROM fs_data WHERE ino = {by_ino(node.ino).sql}"
                " AND chunk_index >= ? AND chunk_index <= ?",
                (first, last),
            )
        )
    region[offset - start : end - start] = data
    rows_in: list[tuple[SqlValue, ...]] = []
    for i in range(first, last + 1):
        at = (i - first) * cs
        rows_in.append((*ino.params, i, bytes(region[at : at + cs])))
    out += insert_rows(
        "INSERT INTO fs_data (ino, chunk_index, data)",
        f"({ino.sql}, ?, ?)",
        rows_in,
    )
    return out


async def cut_bytes(
    accessor: SqlAccessor,
    node: Inode,
    length: int,
) -> list[SqlStatement]:
    """The statements that cut ``node``'s rows to ``length`` bytes: rows
    past it go, and the one it ends in keeps only its head, so bytes cut
    now never read back after the file grows again. Growing writes
    nothing; the size alone pads. Mirrors TypeScript's ``cutBytes``."""
    if length >= node.size:
        return []
    cs = await accessor.chunk_size()
    ino = by_ino(node.ino)
    keep = -(-length // cs)
    out = [
        SqlStatement(
            f"DELETE FROM fs_data WHERE ino = {ino.sql} AND chunk_index >= ?",
            (keep,),
        )
    ]
    tail = length % cs
    if tail == 0:
        return out
    rows = await accessor.query(SQL["chunks"], (node.ino, keep - 1, keep - 1))
    data = _bytes_of(rows[0]["data"]) if rows else b""
    if len(data) <= tail:
        return out
    out += [
        SqlStatement(
            f"DELETE FROM fs_data WHERE ino = {ino.sql} AND chunk_index = ?",
            (keep - 1,),
        ),
        SqlStatement(
            "INSERT INTO fs_data (ino, chunk_index, data)"
            f" VALUES ({ino.sql}, ?, ?)",
            (keep - 1, data[:tail]),
        ),
    ]
    return out

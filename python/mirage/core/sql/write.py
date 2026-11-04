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

from contextlib import aclosing
from dataclasses import replace

from mirage.accessor.sql import SqlAccessor
from mirage.core.sql.constants import FLUSH_BYTES
from mirage.core.sql.data import place_bytes
from mirage.core.sql.inode import (
    Inode,
    by_entry,
    by_ino,
    make_node,
    now_stamp,
    resized,
)
from mirage.core.sql.path import (
    Walk,
    check_dest_parents,
    check_write_target,
    found,
    leaf,
    parent_ref,
    target,
    walk,
)
from mirage.io.cooperative import chunks
from mirage.io.stream import materialize
from mirage.io.types import ByteSource
from mirage.observe.context import record, start_op
from mirage.types import PathSpec, VFSName
from mirage.utils.stat_view import FILE_MODE
from mirage.vfs.sql.types import SqlStatement


def _landing(
    accessor: SqlAccessor,
    w: Walk,
    node: Inode | None,
    data: bytes,
    append: bool,
) -> list[SqlStatement]:
    # The statements that land ``data`` whole: a new file made with it,
    # an existing one's rows replaced, or ``data`` added at its end.
    now = now_stamp()
    if node is None:
        ref = by_entry(parent_ref(w), leaf(w))
        return [
            *make_node(
                accessor, parent_ref(w), leaf(w), FILE_MODE, len(data), now
            ),
            *place_bytes(accessor, ref, None, 0, data),
        ]
    ino = by_ino(node.ino)
    if append:
        return [
            *place_bytes(accessor, ino, node, node.size, data),
            resized(ino, node.size + len(data), now),
        ]
    return [
        SqlStatement(f"DELETE FROM fs_data WHERE ino = {ino.sql}"),
        *place_bytes(accessor, ino, None, 0, data),
        resized(ino, len(data), now),
    ]


async def write(
    accessor: SqlAccessor,
    path: PathSpec,
    data: ByteSource,
    append: bool = False,
    atomic: bool = False,
) -> None:
    """Replace a file's bytes, or add them to its end.

    Bytes land in one transaction, as does a stream under ``atomic``,
    staged until it ends. Any other stream lands ``FLUSH_BYTES`` at a
    time, so a reader watches the file grow: a replacement empties the
    file first and writes at its own position, an append writes past the
    file's end. An append that brings nothing leaves an existing file as
    it was (``true >> f``). Mirrors TypeScript's ``write``.

    Args:
        accessor (SqlAccessor): the database.
        path (PathSpec): the destination.
        data (ByteSource): bytes consumed once.
        append (bool): append instead of replacing.
        atomic (bool): stage a stream until successful EOF.
    """
    timer = start_op()
    w = walk(accessor, path)
    check_dest_parents(w, path)
    check_write_target(w, path)
    op = "append" if append else "write"
    existing = target(w)
    if isinstance(data, bytes) or atomic:
        whole = await materialize(data)
        if append and not whole and existing is not None:
            return
        accessor.batch(_landing(accessor, w, existing, whole, append))
        record(op, path.virtual, VFSName.SQL, len(whole), timer)
        return
    if existing is None or not append:
        accessor.batch(_landing(accessor, w, existing, b"", False))
    node = found(walk(accessor, path), path)
    offset = node.size if append else 0
    pending = bytearray()
    written = 0

    def flush() -> None:
        nonlocal node, offset, written
        if not pending:
            return
        block = bytes(pending)
        ino = by_ino(node.ino)
        size = max(node.size, offset + len(block))
        accessor.batch(
            [
                *place_bytes(accessor, ino, node, offset, block),
                resized(ino, size, now_stamp()),
            ]
        )
        node = replace(node, size=size)
        offset += len(block)
        written += len(block)
        pending.clear()

    async with aclosing(chunks(data)) as source:
        async for chunk in source:
            if not chunk:
                continue
            pending.extend(chunk)
            if len(pending) >= FLUSH_BYTES:
                flush()
    flush()
    record(op, path.virtual, VFSName.SQL, written, timer)

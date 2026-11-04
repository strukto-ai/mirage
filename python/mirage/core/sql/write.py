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

from collections.abc import Awaitable, Callable
from contextlib import aclosing
from dataclasses import replace

from mirage.accessor.sql import SqlAccessor
from mirage.core.sql.constants import FILE, FLUSH_BYTES
from mirage.core.sql.data import place_bytes
from mirage.core.sql.inode import (
    Inode,
    by_entry,
    by_ino,
    make_node,
    now_stamp,
    resized,
    resized_from,
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
from mirage.vfs.sql.types import SqlStatement

# The tries a write that read a file gets when other writers keep
# changing it.
_TRIES = 3


async def _land_fresh(
    accessor: SqlAccessor,
    path: PathSpec,
    node: Inode,
    build: Callable[[Inode], Awaitable[list[SqlStatement]]],
) -> Inode:
    """Land what ``build`` makes of the file as last read, reading it
    again and building afresh when another writer changed it since (the
    guard in ``resized_from`` failed the batch whole); the file as the
    batch found it."""
    tries = 1
    while True:
        try:
            await accessor.batch(await build(node))
            return node
        except Exception:
            fresh = target(await walk(accessor, path))
            same = fresh is not None and (
                fresh.size,
                fresh.mtime,
                fresh.mtime_nsec,
            ) == (node.size, node.mtime, node.mtime_nsec)
            if tries == _TRIES or fresh is None or same:
                raise
            node = fresh
            tries += 1


async def _landing(
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
            *make_node(accessor, parent_ref(w), leaf(w), FILE, len(data), now),
            *await place_bytes(accessor, ref, None, 0, data),
        ]
    ino = by_ino(node.ino)
    if append:
        return [
            *await place_bytes(accessor, ino, node, node.size, data),
            resized_from(node, node.size + len(data), now),
        ]
    return [
        SqlStatement(f"DELETE FROM fs_data WHERE ino = {ino.sql}"),
        *await place_bytes(accessor, ino, None, 0, data),
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
    w = await walk(accessor, path)
    check_dest_parents(w, path)
    check_write_target(w, path)
    op = "append" if append else "write"
    existing = target(w)
    if isinstance(data, bytes) or atomic:
        whole = await materialize(data)
        if append and not whole and existing is not None:
            return
        if append and existing is not None:

            async def appended(n: Inode) -> list[SqlStatement]:
                return await _landing(accessor, w, n, whole, True)

            await _land_fresh(accessor, path, existing, appended)
        else:
            await accessor.batch(
                await _landing(accessor, w, existing, whole, append)
            )
        record(op, path.virtual, VFSName.SQL, len(whole), timer)
        return
    if existing is None or not append:
        await accessor.batch(await _landing(accessor, w, existing, b"", False))
    node = found(await walk(accessor, path), path)
    offset = node.size if append else 0
    pending = bytearray()
    written = 0

    # Each block lands on the file as it is now: an append at its end,
    # which another writer may have moved.
    async def flush() -> None:
        nonlocal node, offset, written
        if not pending:
            return
        block = bytes(pending)
        stamp = now_stamp()
        at = offset
        size = 0

        async def placed(n: Inode) -> list[SqlStatement]:
            nonlocal at, size
            at = n.size if append else offset
            size = max(n.size, at + len(block))
            return [
                *await place_bytes(accessor, by_ino(n.ino), n, at, block),
                resized_from(n, size, stamp),
            ]

        used = await _land_fresh(accessor, path, node, placed)
        node = replace(used, size=size, mtime=stamp[0], mtime_nsec=stamp[1])
        offset = at + len(block)
        written += len(block)
        pending.clear()

    async with aclosing(chunks(data)) as source:
        async for chunk in source:
            if not chunk:
                continue
            pending.extend(chunk)
            if len(pending) >= FLUSH_BYTES:
                await flush()
    await flush()
    record(op, path.virtual, VFSName.SQL, written, timer)

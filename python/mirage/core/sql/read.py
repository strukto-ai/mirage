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

from mirage.accessor.sql import SqlAccessor
from mirage.core.sql.constants import MAX_PARAMS, entries_named, rows_of
from mirage.core.sql.data import fill_bytes, read_bytes
from mirage.core.sql.inode import Inode, inode_of, is_dir, is_file
from mirage.core.sql.path import found, names_of, target, walk
from mirage.errors.fs import eisdir
from mirage.observe.context import record, record_stream, start_op
from mirage.types import PathSpec, VFSName
from mirage.utils.path import norm
from mirage.vfs.sql.types import SqlRow


async def read(
    accessor: SqlAccessor,
    path: PathSpec,
    offset: int = 0,
    size: int | None = None,
) -> bytes:
    """Read a file, optionally only a byte range of it.

    Args:
        accessor (SqlAccessor): the database.
        path (PathSpec): the path to read.
        offset (int): where the window starts.
        size (int | None): the window's length; None to the end.
    """
    timer = start_op()
    node = found(await walk(accessor, path), path)
    if is_dir(node):
        raise eisdir(path)
    data = await read_bytes(accessor, node, offset, size)
    record("read", path.virtual, VFSName.SQL, len(data), timer)
    return data


async def read_many(
    accessor: SqlAccessor,
    paths: list[PathSpec],
    limit: int,
    room: int | None = None,
) -> dict[str, bytes]:
    """Several whole files by virtual path, in a few queries whatever
    their number: each folder they sit in walked once, its entries the
    files name in one query, and every row of the files kept in one more.
    A file is kept only from what its inode says, before its rows are
    asked for: one that is gone or no file, one longer than ``limit``, and
    one that does not fit in ``room`` beside the files kept before it is
    left out for its own read to meet. Each file read is recorded as a
    whole streamed read records it.

    Args:
        accessor (SqlAccessor): the database.
        paths (list[PathSpec]): the files, all on this mount.
        limit (int): the most bytes worth fetching for one file.
        room (int | None): the most bytes the files kept may come to
            together, None for no bound.
    """
    folders: dict[str, list[tuple[PathSpec, str]]] = {}
    for spec in paths:
        names = names_of(norm(spec.mount_path))
        if names:
            folder = "/" + "/".join(names[:-1])
            folders.setdefault(folder, []).append((spec, names[-1]))
    kept: list[tuple[PathSpec, Inode]] = []
    total = 0
    for folder, files in folders.items():
        node = target(await walk(accessor, folder))
        if node is None or not is_dir(node):
            continue
        entries = await _inodes_named(
            accessor, node.ino, [name for _, name in files]
        )
        for spec, name in files:
            entry = entries.get(name)
            if (
                entry is None
                or not is_file(entry)
                or entry.size > limit
                or (room is not None and total + entry.size > room)
            ):
                continue
            total += entry.size
            kept.append((spec, entry))
    rows = await _rows_by_ino(
        accessor, [entry.ino for _, entry in kept if entry.size]
    )
    cs = await accessor.chunk_size()
    read: dict[str, bytes] = {}
    for spec, entry in kept:
        data = fill_bytes(rows.get(entry.ino, []), cs, 0, entry.size)
        rec = record_stream("read", spec.virtual, VFSName.SQL)
        if rec is not None:
            rec.bytes = len(data)
            rec.complete = True
        read[spec.virtual] = data
    return read


async def _inodes_named(
    accessor: SqlAccessor, folder: int, names: list[str]
) -> dict[str, Inode]:
    """The inode each of ``names`` holds in the folder ``folder``, by
    name; a name the folder does not hold is left out.

    Args:
        accessor (SqlAccessor): the database.
        folder (int): the folder's inode.
        names (list[str]): the names, each once.
    """
    out: dict[str, Inode] = {}
    step = MAX_PARAMS - 1
    for at in range(0, len(names), step):
        part = names[at : at + step]
        for row in await accessor.query(
            entries_named(len(part)), (folder, *part)
        ):
            node = inode_of(row)
            if node is not None:
                out[str(row["name"])] = node
    return out


async def _rows_by_ino(
    accessor: SqlAccessor, inos: list[int]
) -> dict[int, list[SqlRow]]:
    """Every ``fs_data`` row of the files ``inos`` names, by inode.

    Args:
        accessor (SqlAccessor): the database.
        inos (list[int]): the files' inodes.
    """
    out: dict[int, list[SqlRow]] = {}
    for at in range(0, len(inos), MAX_PARAMS):
        part = inos[at : at + MAX_PARAMS]
        for row in await accessor.query(rows_of(len(part)), part):
            out.setdefault(int(row["ino"] or 0), []).append(row)
    return out

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
from mirage.core.sql.constants import (
    MAX_PARAMS,
    READ_RUN_BYTES,
    entries_named,
    rows_of,
)
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
    files name in one query, and the rows of the files kept in one more
    for each ``READ_RUN_BYTES`` of them (``_runs``), so the rows alive
    beside the files built never pass a run. A file is kept only from what
    its inode says, before its rows are asked for: one that is gone or no
    file, one longer than ``limit``, and one that does not fit in ``room``
    beside the files kept before it is left out for its own read to meet.
    A path named twice is kept once. Each file read is recorded as a whole
    streamed read records it.

    Args:
        accessor (SqlAccessor): the database.
        paths (list[PathSpec]): the files, all on this mount.
        limit (int): the most bytes worth fetching for one file.
        room (int | None): the most bytes the files kept may come to
            together, None for no bound.
    """
    folders: dict[str, list[tuple[PathSpec, str]]] = {}
    for spec in {p.virtual: p for p in paths}.values():
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
    cs = await accessor.chunk_size()
    read: dict[str, bytes] = {}
    built: dict[int, bytes] = {}
    for run in _runs(kept):
        rows = await _rows_by_ino(
            accessor,
            [e for _, e in run if e.size and e.ino not in built],
            cs,
        )
        for spec, entry in run:
            data = built.get(entry.ino)
            if data is None:
                data = fill_bytes(rows.pop(entry.ino, []), cs, 0, entry.size)
                built[entry.ino] = data
            rec = record_stream("read", spec.virtual, VFSName.SQL)
            if rec is not None:
                rec.bytes = len(data)
                rec.complete = True
            read[spec.virtual] = data
    return read


def _runs(
    kept: list[tuple[PathSpec, Inode]],
) -> list[list[tuple[PathSpec, Inode]]]:
    """``kept`` cut into runs whose rows one query fetches: at most
    ``READ_RUN_BYTES`` of files, a longer file alone, and at most the
    files ``MAX_PARAMS`` binds at two parameters a file (``rows_of``).

    Args:
        kept (list[tuple[PathSpec, Inode]]): the files kept, in order.
    """
    runs: list[list[tuple[PathSpec, Inode]]] = []
    size = 0
    for spec, entry in kept:
        last = runs[-1] if runs else None
        if (
            last is None
            or len(last) == MAX_PARAMS // 2
            or size + entry.size > READ_RUN_BYTES
        ):
            runs.append([(spec, entry)])
            size = entry.size
        else:
            last.append((spec, entry))
            size += entry.size
    return runs


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
    accessor: SqlAccessor, files: list[Inode], cs: int
) -> dict[int, list[SqlRow]]:
    """The ``fs_data`` rows of ``files``, by inode, each file's only as
    far as the size its inode gave when it was kept (``rows_of``).

    Args:
        accessor (SqlAccessor): the database.
        files (list[Inode]): the files, each with bytes.
        cs (int): the bytes one row holds.
    """
    out: dict[int, list[SqlRow]] = {}
    step = MAX_PARAMS // 2
    for at in range(0, len(files), step):
        part = files[at : at + step]
        params = [v for e in part for v in (e.ino, (e.size - 1) // cs)]
        for row in await accessor.query(rows_of(len(part)), params):
            out.setdefault(int(row["ino"] or 0), []).append(row)
    return out

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

from collections import deque

from mirage.accessor.sql import SqlAccessor
from mirage.core.sql.constants import SQL, TREE_ENTRY_BYTES, children_of
from mirage.core.sql.inode import (
    Inode,
    inode_of,
    inode_stat,
    is_dir,
    subdir_counts,
)
from mirage.core.sql.path import not_listable, target, walk
from mirage.io.memory import memory_room
from mirage.types import FileStat, PathSpec


def _under(p: str) -> str:
    return "/" if p == "/" else f"{p}/"


async def readdir(accessor: SqlAccessor, path: PathSpec) -> list[FileStat]:
    # A pattern spec addresses the directory whose entries the glob
    # filters.
    w = await walk(accessor, path.dir if path.pattern is not None else path)
    node = target(w)
    if node is None or not is_dir(node):
        raise await not_listable(w, path)
    entries: list[tuple[str, Inode]] = []
    for row in await accessor.query(SQL["children"], (node.ino,)):
        child = inode_of(row)
        if child is not None:
            entries.append((str(row["name"]), child))
    entries.sort(key=lambda e: e[0])
    counts = await subdir_counts(accessor, [child for _, child in entries])
    return [
        inode_stat(_under(w.p) + name, child, counts.get(child.ino, 0))
        for name, child in entries
    ]


def _tree_stats(
    prefix: str, entries: list[tuple[str, Inode]]
) -> dict[str, FileStat]:
    """A whole subtree's rows by relative path, each folder's link count
    read off the folders the rows hold under it.

    Args:
        prefix (str): the subtree's mount path, ending in a slash.
        entries (list[tuple[str, Inode]]): every entry under it, by
            relative path.
    """
    subdirs: dict[str, int] = {}
    for rel, child in entries:
        if is_dir(child):
            up = rel.rpartition("/")[0]
            subdirs[up] = subdirs.get(up, 0) + 1
    return {
        rel: inode_stat(prefix + rel, child, subdirs.get(rel, 0))
        for rel, child in sorted(entries, key=lambda entry: entry[0])
    }


async def tree(
    accessor: SqlAccessor,
    path: PathSpec,
    limit: int | None = None,
) -> dict[str, FileStat] | None:
    """Every entry under a directory, each as ``stat``
    answers it, keyed by its relative path. Decline an oversized snapshot
    so the walk can list directories. Mirrors TypeScript's ``tree``."""
    w = await walk(accessor, path)
    node = target(w)
    if node is None or not is_dir(node):
        return None
    ceiling = limit if limit is not None and limit >= 0 else None
    room = memory_room()
    if room is not None:
        fits = room // TREE_ENTRY_BYTES
        ceiling = fits if ceiling is None else min(ceiling, fits)
    if ceiling is not None:
        return await _bounded_tree(accessor, node, _under(w.p), ceiling)
    rows = await accessor.query(SQL["subtree"], (node.ino,))
    entries: list[tuple[str, Inode]] = []
    for row in rows:
        child = inode_of(row)
        if child is not None:
            entries.append((str(row["rel"]), child))
    return _tree_stats(_under(w.p), entries)


async def _bounded_tree(
    accessor: SqlAccessor, root: Inode, prefix: str, limit: int
) -> dict[str, FileStat] | None:
    """Fetch only direct names in indexed batches. A wide directory never
    fills a recursive SQL queue, and deep relative paths count against room
    before they enter the snapshot."""
    pending = deque([(root.ino, "")])
    entries: list[tuple[str, Inode]] = []
    used = 0
    while pending:
        parents = dict(pending.popleft() for _ in range(min(len(pending), 64)))
        remaining = limit - len(entries)
        rows = await accessor.query(
            children_of(len(parents)), (*parents, remaining + 1)
        )
        if len(rows) > remaining:
            return None
        room = memory_room()
        if room is not None and used > room:
            return None
        for row in rows:
            child = inode_of(row)
            if child is None:
                continue
            parent = parents[int(row["parent_ino"] or 0)]
            name = str(row["name"])
            rel = f"{parent}/{name}" if parent else name
            used += TREE_ENTRY_BYTES + len(rel.encode())
            if room is not None and used > room:
                return None
            entries.append((rel, child))
            if is_dir(child):
                pending.append((child.ino, rel))
    return _tree_stats(prefix, entries)

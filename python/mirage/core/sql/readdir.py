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
from mirage.core.sql.constants import SQL, TREE_ENTRY_BYTES
from mirage.core.sql.inode import Inode, inode_of, inode_stat, is_dir
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
    return [inode_stat(_under(w.p) + name, child) for name, child in entries]


async def tree(
    accessor: SqlAccessor,
    path: PathSpec,
    limit: int | None = None,
) -> dict[str, FileStat] | None:
    """Every entry under a directory from one query, each as ``stat``
    answers it, keyed by its relative path. Decline an oversized snapshot
    so the walk can list directories. Mirrors TypeScript's ``tree``."""
    w = await walk(accessor, path)
    node = target(w)
    if node is None or not is_dir(node):
        return None
    ceiling = limit if limit is not None and limit >= 0 else None
    room = memory_room()
    if room is not None:
        entries = room // TREE_ENTRY_BYTES
        ceiling = entries if ceiling is None else min(ceiling, entries)
    if ceiling is None:
        rows = await accessor.query(SQL["subtree"], (node.ino,))
    else:
        rows = await accessor.query(
            SQL["subtree"] + " LIMIT ?", (node.ino, ceiling + 1)
        )
        if len(rows) > ceiling:
            return None
    room = memory_room()
    if room is not None and len(rows) * TREE_ENTRY_BYTES > room:
        return None
    rows.sort(key=lambda row: str(row["rel"]))
    found: dict[str, FileStat] = {}
    prefix = _under(w.p)
    for row in rows:
        child = inode_of(row)
        if child is not None:
            rel = str(row["rel"])
            found[rel] = inode_stat(prefix + rel, child)
    return found

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
from mirage.core.sql.constants import DIR
from mirage.core.sql.inode import (
    by_entry,
    by_ino,
    is_dir,
    make_node,
    now_stamp,
)
from mirage.core.sql.path import (
    check_dest_parents,
    leaf,
    parent_ref,
    target,
    walk,
)
from mirage.errors.fs import eexist, enoent, enotdir
from mirage.types import PathSpec
from mirage.utils.key_prefix import mounted_path
from mirage.vfs.sql.types import SqlStatement

# A new directory's entry names its parent by the entry above it, a
# subquery a level, so the deepest statement grows faster than one level
# a level: SQLite counts a batch's deepest entry, and the lookup of the
# last directory it made, at most 83 deep for six levels and past 100
# for seven, where D1 and Durable Objects stop. ``mkdir -p`` lands this
# many levels a batch.
_LEVELS_PER_BATCH = 6


async def mkdir(
    accessor: SqlAccessor,
    path: PathSpec,
    parents: bool = False,
) -> None:
    """Make a directory.

    Plain mkdir is one mkdir(2) on the whole path, so an existing target
    is EEXIST whichever kind it is. ``mkdir -p`` walks the chain itself,
    so it reports the component it trips on (``mkdir -p a.txt/sub`` is
    ENOTDIR on ``a.txt``), reaching the target as a plain file is EEXIST,
    and an existing directory anywhere is success. The directories it
    makes land ``_LEVELS_PER_BATCH`` levels a transaction. Mirrors
    TypeScript's ``mkdir``.
    """
    w = await walk(accessor, path)
    now = now_stamp()
    if not parents:
        if target(w) is not None:
            raise eexist(path)
        check_dest_parents(w, path)
        await accessor.batch(
            make_node(accessor, parent_ref(w), leaf(w), DIR, 0, now)
        )
        return
    top = w.chain[0]
    if top is None:
        raise enoent(path)
    statements: list[SqlStatement] = []
    parent = by_ino(top.ino)
    levels = 0
    for i, name in enumerate(w.names):
        node = w.chain[i + 1]
        if node is not None:
            if not is_dir(node):
                named = mounted_path(path, "/" + "/".join(w.names[: i + 1]))
                raise (
                    eexist(named) if i == len(w.names) - 1 else enotdir(named)
                )
            parent = by_ino(node.ino)
            levels = 0
            continue
        if levels == _LEVELS_PER_BATCH:
            await accessor.batch(statements)
            statements = []
            made = await accessor.query(
                f"SELECT ino FROM fs_inode WHERE ino = {parent.sql}",
                parent.params,
            )
            ino = made[0]["ino"] if made else None
            if ino is None:
                raise enoent(mounted_path(path, "/" + "/".join(w.names[:i])))
            parent = by_ino(int(ino))
            levels = 0
        statements += make_node(accessor, parent, name, DIR, 0, now)
        parent = by_entry(parent, name)
        levels += 1
    await accessor.batch(statements)

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
from mirage.core.sql.constants import DIR, ROOT_INO
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
# subquery a level, which SQLite bounds; ``mkdir -p`` lands this many
# levels a batch.
_LEVELS_PER_BATCH = 16


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
    statements: list[SqlStatement] = []
    parent = by_ino(ROOT_INO)
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
            above = "/" + "/".join(w.names[:i])
            made = target(await walk(accessor, above))
            if made is None:
                raise enoent(mounted_path(path, above))
            parent = by_ino(made.ino)
            levels = 0
        statements += make_node(accessor, parent, name, DIR, 0, now)
        parent = by_entry(parent, name)
        levels += 1
    await accessor.batch(statements)

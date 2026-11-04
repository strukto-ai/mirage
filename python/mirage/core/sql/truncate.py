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
from mirage.core.sql.constants import FILE
from mirage.core.sql.data import cut_bytes
from mirage.core.sql.inode import by_ino, make_node, now_stamp, resized
from mirage.core.sql.path import (
    check_dest_parents,
    check_write_target,
    leaf,
    parent_ref,
    target,
    walk,
)
from mirage.observe.context import record, start_op
from mirage.types import PathSpec, VFSName


async def truncate(
    accessor: SqlAccessor,
    path: PathSpec,
    length: int,
    no_create: bool = False,
) -> None:
    """Resize a file to ``length`` bytes: cut its rows, or grow it by its
    size alone, which reads as zeros. A missing file is made at that
    size unless ``no_create``. Mirrors TypeScript's ``truncate``."""
    timer = start_op()
    w = await walk(accessor, path)
    check_dest_parents(w, path)
    check_write_target(w, path)
    node = target(w)
    now = now_stamp()
    if node is None:
        if no_create:
            return
        await accessor.batch(
            make_node(accessor, parent_ref(w), leaf(w), FILE, length, now)
        )
    else:
        await accessor.batch(
            [
                *await cut_bytes(accessor, node, length),
                resized(by_ino(node.ino), length, now),
            ]
        )
    record("truncate", path.virtual, VFSName.SQL, 0, timer)

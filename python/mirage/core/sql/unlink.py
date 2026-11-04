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
from mirage.core.sql.constants import SQL
from mirage.core.sql.inode import drop_inodes, is_dir
from mirage.core.sql.path import found, leaf, parent_of, walk
from mirage.errors.fs import eisdir
from mirage.types import PathSpec
from mirage.vfs.sql.types import SqlStatement


async def unlink(accessor: SqlAccessor, path: PathSpec) -> None:
    """Remove a file's entry, and the file with it unless another entry
    names it."""
    w = walk(accessor, path)
    node = found(w, path)
    if is_dir(node):
        raise eisdir(path)
    parent = parent_of(w)
    accessor.batch(
        [
            SqlStatement(
                SQL["remove_entry"],
                (parent.ino if parent is not None else None, leaf(w)),
            ),
            *drop_inodes([node.ino]),
        ]
    )

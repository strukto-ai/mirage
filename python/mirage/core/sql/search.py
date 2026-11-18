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

import re

from mirage.accessor.sql import SqlAccessor
from mirage.core.sql.constants import candidate_files
from mirage.core.sql.inode import is_dir
from mirage.core.sql.path import target, walk
from mirage.types import PathSpec
from mirage.utils.key_prefix import child_spec
from mirage.vfs.sql.types import SqlDialect

MAX_CANDIDATES = 512


async def files_containing(
    accessor: SqlAccessor, path: PathSpec, text: str, ignore_case: bool
) -> list[PathSpec] | None:
    """Find possible matches in SQLite chunk rows. A printable ASCII needle
    no longer than a chunk spans at most two rows. One of its halves must
    appear in full. Keep potential UTF-16 files for rg's BOM decoding.

    Args:
        accessor (SqlAccessor): the database holding the files.
        path (PathSpec): the directory being searched.
        text (str): a literal present in each possible match.
        ignore_case (bool): whether the caller folds case.
    """
    if (
        accessor.driver.dialect != SqlDialect.SQLITE
        or not text
        or not text.isascii()
        or not text.isprintable()
    ):
        return None
    literal = (
        max(re.split("[iks]", text.lower()), key=len) if ignore_case else text
    )
    if not literal:
        return None
    node = target(await walk(accessor, path))
    if node is None or not is_dir(node):
        return None
    chunk_size = await accessor.chunk_size()
    needle = literal[:chunk_size].encode("ascii")
    cut = (len(needle) + 1) // 2
    first = needle[:cut]
    second = needle[cut:] or first
    overlap = len(needle) - 1
    rows = await accessor.query(
        candidate_files(ignore_case),
        (
            node.ino,
            needle,
            chunk_size,
            -overlap,
            first,
            overlap,
            second,
            MAX_CANDIDATES + 1,
        ),
    )
    if len(rows) > MAX_CANDIDATES:
        return None
    return [child_spec(path, str(row["rel"])) for row in rows]

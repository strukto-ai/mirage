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

from mirage.accessor.lancedb import LanceDBAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.hierarchy.read import Reader
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.lancedb.query import row_record
from mirage.core.lancedb.render import render_card
from mirage.core.lancedb.types import LanceRow
from mirage.core.vector.read import blob_bytes
from mirage.core.vector.scope import table_of
from mirage.errors.fs import enoent
from mirage.types import PathSpec


async def _row_of(
    accessor: LanceDBAccessor, match: ScopeMatch, virtual: str
) -> LanceRow:
    config = accessor.config
    row = await row_record(
        accessor,
        table_of(config.table, match),
        config.id_column,
        match.slots["row_id"],
    )
    if row is None:
        raise enoent(virtual)
    return row


async def _read_card(
    accessor: LanceDBAccessor,
    match: ScopeMatch,
    path: PathSpec,
    index: IndexCacheStore,
) -> bytes:
    row = await _row_of(accessor, match, path.virtual)
    return render_card(row, accessor.config)


async def _read_blob(
    accessor: LanceDBAccessor,
    match: ScopeMatch,
    path: PathSpec,
    index: IndexCacheStore,
) -> bytes:
    config = accessor.config
    if not config.blob_column:
        raise enoent(path)
    row = await _row_of(accessor, match, path.virtual)
    return blob_bytes(row.get(config.blob_column))


READERS: dict[str, Reader[LanceDBAccessor]] = {
    "row_card": _read_card,
    "row_blob": _read_blob,
}

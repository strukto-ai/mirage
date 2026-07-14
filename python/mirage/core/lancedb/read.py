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

import base64

from mirage.accessor.lancedb import LanceDBAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.lancedb.query import row_record
from mirage.core.lancedb.render import render_card
from mirage.core.lancedb.scope import ScopeLevel, detect_scope
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def _resolve_row(accessor: LanceDBAccessor, scope, config,
                       virtual: str) -> dict:
    row = await row_record(accessor, scope.table, config.id_column,
                           scope.row_id)
    if row is None:
        raise enoent(virtual)
    return row


def _blob_bytes(value: object) -> bytes:
    if isinstance(value, bytes):
        return value
    if isinstance(value, str):
        return base64.b64decode(value)
    raise ValueError("blob column is not bytes or base64 str")


async def read(
    accessor: LanceDBAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> bytes:
    config = accessor.config
    scope = detect_scope(path, config)
    if scope.level != ScopeLevel.ROW:
        raise enoent(path)
    row = await _resolve_row(accessor, scope, config, path.virtual)
    if scope.blob:
        if not config.blob_column:
            raise enoent(path)
        return _blob_bytes(row.get(config.blob_column))
    return render_card(row, config)

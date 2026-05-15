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

from collections.abc import AsyncIterator

from bson.json_util import RELAXED_JSON_OPTIONS, dumps

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.mongodb._client import iter_documents
from mirage.core.mongodb.scope import detect_scope
from mirage.types import PathSpec


async def read_stream(
    accessor: MongoDBAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
    batch_size: int = 100,
) -> AsyncIterator[bytes]:
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    config = accessor.config
    single = config.databases is not None and len(config.databases) == 1
    single_name = config.databases[0] if single else None
    scope = detect_scope(path,
                         single_db=single,
                         single_db_name=single_name)
    if scope.level != "file":
        raise FileNotFoundError(path.original)
    async for doc in iter_documents(
            accessor.client,
            scope.database,
            scope.collection,
            sort=[("_id", 1)],
            batch_size=batch_size,
    ):
        yield (dumps(doc, json_options=RELAXED_JSON_OPTIONS) + "\n").encode()

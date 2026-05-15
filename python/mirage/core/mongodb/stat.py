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

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.mongodb._client import count_documents, get_indexes, is_view
from mirage.core.mongodb.scope import MongoEntityKind, detect_scope
from mirage.types import FileStat, FileType, PathSpec


async def stat(
    accessor: MongoDBAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> FileStat:
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    scope = detect_scope(path)

    if scope.level == "root":
        return FileStat(name="/", type=FileType.DIRECTORY)

    if scope.level == "database":
        return FileStat(
            name=scope.database,
            type=FileType.DIRECTORY,
            extra={"database": scope.database},
        )

    if scope.level == "kind_dir":
        return FileStat(
            name=_kind_dir_name(scope.kind),
            type=FileType.DIRECTORY,
            extra={"database": scope.database, "kind": scope.kind},
        )

    if scope.level == "entity":
        doc_count = await count_documents(accessor.client, scope.database,
                                           scope.name)
        return FileStat(
            name=scope.name,
            type=FileType.DIRECTORY,
            extra={
                "database": scope.database,
                "kind": scope.kind,
                "name": scope.name,
                "document_count": doc_count,
            },
        )

    if scope.level == "documents":
        return await _documents_stat(accessor, scope.database, scope.kind,
                                      scope.name)

    if scope.level == "schema_json":
        return FileStat(
            name="schema.json",
            type=FileType.TEXT,
            extra={
                "database": scope.database,
                "kind": scope.kind,
                "name": scope.name,
            },
        )

    if scope.level == "database_json":
        return FileStat(
            name="database.json",
            type=FileType.TEXT,
            extra={"database": scope.database},
        )

    raise FileNotFoundError(path.original)


def _kind_dir_name(kind: MongoEntityKind) -> str:
    return "collections" if kind == "collection" else "views"


async def _documents_stat(
    accessor: MongoDBAccessor,
    database: str,
    kind: MongoEntityKind,
    name: str,
) -> FileStat:
    view = kind == "view" or await is_view(accessor.client, database, name)
    doc_count = await count_documents(accessor.client, database, name)
    if view:
        index_info: list[dict] = []
    else:
        indexes = await get_indexes(accessor.client, database, name)
        index_info = [{
            "name": idx.get("name"),
            "keys": dict(idx.get("key", {}))
        } for idx in indexes]
    return FileStat(
        name="documents.jsonl",
        type=FileType.TEXT,
        extra={
            "database": database,
            "name": name,
            "kind": "view" if view else "collection",
            "document_count": doc_count,
            "indexes": index_info,
        },
    )

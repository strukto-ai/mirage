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
from mirage.core.mongodb._client import (count_documents, database_exists,
                                         entity_exists, get_indexes, is_view)
from mirage.core.mongodb.scope import detect_scope
from mirage.core.mongodb.types import KIND_TO_DIR, EntityKind, ScopeLevel
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent


async def stat(
    accessor: MongoDBAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> FileStat:
    if isinstance(path, str):
        path = PathSpec(virtual=path,
                        directory=path,
                        resource_path=path.strip("/"))
    scope = detect_scope(path)

    if scope.level == ScopeLevel.ROOT:
        return FileStat(name="/", type=FileType.DIRECTORY)

    if scope.level == ScopeLevel.DATABASE:
        if not await database_exists(accessor.client, accessor.config,
                                     scope.database, accessor):
            raise enoent(path)
        return FileStat(
            name=scope.database,
            type=FileType.DIRECTORY,
            extra={"database": scope.database},
        )

    if scope.level == ScopeLevel.KIND_DIR:
        if not await database_exists(accessor.client, accessor.config,
                                     scope.database, accessor):
            raise enoent(path)
        return FileStat(
            name=_kind_dir_name(scope.kind),
            type=FileType.DIRECTORY,
            extra={
                "database": scope.database,
                "kind": scope.kind
            },
        )

    if scope.level == ScopeLevel.ENTITY:
        if not await entity_exists(accessor.client, accessor.config,
                                   scope.database, scope.name, scope.kind,
                                   accessor):
            raise enoent(path)
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

    if scope.level == ScopeLevel.DOCUMENTS:
        if not await entity_exists(accessor.client, accessor.config,
                                   scope.database, scope.name, scope.kind,
                                   accessor):
            raise enoent(path)
        return await _documents_stat(accessor, scope.database, scope.kind,
                                     scope.name)

    if scope.level == ScopeLevel.SCHEMA_JSON:
        if not await entity_exists(accessor.client, accessor.config,
                                   scope.database, scope.name, scope.kind,
                                   accessor):
            raise enoent(path)
        return FileStat(
            name="schema.json",
            type=FileType.TEXT,
            extra={
                "database": scope.database,
                "kind": scope.kind,
                "name": scope.name,
            },
        )

    if scope.level == ScopeLevel.DATABASE_JSON:
        if not await database_exists(accessor.client, accessor.config,
                                     scope.database, accessor):
            raise enoent(path)
        return FileStat(
            name="database.json",
            type=FileType.TEXT,
            extra={"database": scope.database},
        )

    raise enoent(path)


def _kind_dir_name(kind: EntityKind) -> str:
    return KIND_TO_DIR[kind]


async def _documents_stat(
    accessor: MongoDBAccessor,
    database: str,
    kind: EntityKind,
    name: str,
) -> FileStat:
    view = (kind == EntityKind.VIEW
            or await is_view(accessor.client, database, name))
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
            "kind": EntityKind.VIEW if view else EntityKind.COLLECTION,
            "document_count": doc_count,
            "indexes": index_info,
        },
    )

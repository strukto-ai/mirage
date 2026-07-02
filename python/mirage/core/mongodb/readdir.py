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
from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.core.mongodb._client import (database_exists, entity_exists,
                                         list_collections, list_databases)
from mirage.core.mongodb.scope import detect_scope
from mirage.core.mongodb.types import (KIND_TO_DIR, KIND_TO_RESOURCE_TYPE,
                                       RESOURCE_TYPE_DATABASE, EntityKind,
                                       ScopeLevel)
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_prefix_of


def is_dir_name(child: str) -> bool:
    # Entries are recognized by extension, so classification never needs the
    # stat fallback.
    name = child.rsplit("/", 1)[-1]
    return not (name.endswith(".json") or name.endswith(".jsonl"))


async def readdir(
    accessor: MongoDBAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> list[str]:
    if isinstance(path, str):
        path = PathSpec(virtual=path,
                        directory=path,
                        resource_path=path.strip("/"))
    prefix = mount_prefix_of(path.virtual, path.resource_path) or ""
    scope = detect_scope(path)
    virtual_key = (prefix + scope.resource_path).rstrip("/") or "/"

    if scope.level == ScopeLevel.ROOT:
        return await _list_root(accessor, virtual_key, index, prefix)

    if scope.level == ScopeLevel.DATABASE:
        if not await database_exists(accessor.client, accessor.config,
                                     scope.database, accessor):
            raise enoent(path)
        base = f"{prefix}/{scope.database}"
        return [
            f"{base}/database.json",
            f"{base}/collections",
            f"{base}/views",
        ]

    if scope.level == ScopeLevel.KIND_DIR:
        if not await database_exists(accessor.client, accessor.config,
                                     scope.database, accessor):
            raise enoent(path)
        return await _list_kind_dir(accessor, scope.database, scope.kind,
                                    virtual_key, index, prefix)

    if scope.level == ScopeLevel.ENTITY:
        if not await entity_exists(accessor.client, accessor.config,
                                   scope.database, scope.name, scope.kind,
                                   accessor):
            raise enoent(path)
        base = (f"{prefix}/{scope.database}/"
                f"{KIND_TO_DIR[scope.kind]}/{scope.name}")
        return [
            f"{base}/schema.json",
            f"{base}/documents.jsonl",
        ]

    raise enoent(path)


async def _list_root(
    accessor: MongoDBAccessor,
    virtual_key: str,
    index: IndexCacheStore | None,
    prefix: str,
) -> list[str]:
    if index is not None:
        listing = await index.list_dir(virtual_key)
        if listing.entries is not None:
            return listing.entries
    dbs = await list_databases(accessor.client, accessor.config)
    entries: list[tuple[str, IndexEntry]] = []
    names: list[str] = []
    for db_name in dbs:
        entry = IndexEntry(
            id=db_name,
            name=db_name,
            resource_type=RESOURCE_TYPE_DATABASE,
            vfs_name=db_name,
        )
        entries.append((db_name, entry))
        names.append(f"{prefix}/{db_name}")
    if index is not None:
        await index.set_dir(virtual_key, entries)
    return names


async def _list_kind_dir(
    accessor: MongoDBAccessor,
    database: str,
    kind: EntityKind,
    virtual_key: str,
    index: IndexCacheStore | None,
    prefix: str,
) -> list[str]:
    if index is not None:
        listing = await index.list_dir(virtual_key)
        if listing.entries is not None:
            return listing.entries
    names = await list_collections(accessor.client, database, kind=kind)
    base = f"{prefix}/{database}/{KIND_TO_DIR[kind]}"
    entries: list[tuple[str, IndexEntry]] = []
    out: list[str] = []
    for name in names:
        entry = IndexEntry(
            id=name,
            name=name,
            resource_type=KIND_TO_RESOURCE_TYPE[kind],
            vfs_name=name,
        )
        entries.append((name, entry))
        out.append(f"{base}/{name}")
    if index is not None:
        await index.set_dir(virtual_key, entries)
    return out

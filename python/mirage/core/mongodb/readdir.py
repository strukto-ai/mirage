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
from mirage.cache.index import IndexEntry
from mirage.core.hierarchy.readdir import make_readdir
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.mongodb.client import (
    database_exists,
    entity_exists,
    list_collections,
    list_databases,
)
from mirage.core.mongodb.scope import detect_scope, entity_kind
from mirage.core.mongodb.types import (
    KIND_TO_DIR,
    KIND_TO_RESOURCE_TYPE,
    RESOURCE_TYPE_DATABASE,
)
from mirage.errors.fs import enoent

ENTITY_FILES = ("schema.json", "documents.jsonl")


async def database_guard(
    accessor: MongoDBAccessor, match: ScopeMatch, virtual: str
) -> None:
    """ENOENT unless the slotted database exists.

    Args:
        accessor (MongoDBAccessor): backend handle.
        match (ScopeMatch): a match whose slots hold ``database``.
        virtual (str): virtual path for the error.
    """
    if not await database_exists(
        accessor.client, accessor.config, match.slots["database"], accessor
    ):
        raise enoent(virtual)


async def entity_guard(
    accessor: MongoDBAccessor, match: ScopeMatch, virtual: str
) -> None:
    """ENOENT unless the slotted collection or view exists.

    Args:
        accessor (MongoDBAccessor): backend handle.
        match (ScopeMatch): a match whose slots hold ``database``,
            ``kind`` and ``name``.
        virtual (str): virtual path for the error.
    """
    if not await entity_exists(
        accessor.client,
        accessor.config,
        match.slots["database"],
        match.slots["name"],
        entity_kind(match),
        accessor,
    ):
        raise enoent(virtual)


async def documents_exist(
    accessor: MongoDBAccessor, match: ScopeMatch, virtual: str
) -> bool:
    """Whether ``entity_guard`` admits the collection a match names.

    For the bespoke fast paths (``tail`` and ``wc -l`` on
    ``documents.jsonl``), which query the collection by the names in the
    path: they take the fast path only for a collection the mount can
    see, and otherwise hand the operand to the generic, which stats it
    through the same guard and reports it the way GNU names a missing
    file. ``count_documents`` answers 0 for a collection that does not
    exist, so without it ``wc -l`` printed a count for a missing file.

    Args:
        accessor (MongoDBAccessor): backend handle.
        match (ScopeMatch): a match whose slots hold ``database``,
            ``kind`` and ``name``.
        virtual (str): the operand's virtual path.
    """
    try:
        await entity_guard(accessor, match, virtual)
    except FileNotFoundError:
        return False
    return True


async def _list_root(
    accessor: MongoDBAccessor, match: ScopeMatch
) -> list[tuple[str, IndexEntry]]:
    dbs = await list_databases(accessor.client, accessor.config)
    return [
        (
            db_name,
            IndexEntry(
                id=db_name,
                name=db_name,
                resource_type=RESOURCE_TYPE_DATABASE,
                vfs_name=db_name,
            ),
        )
        for db_name in dbs
    ]


async def _list_database(
    accessor: MongoDBAccessor, match: ScopeMatch
) -> list[tuple[str, IndexEntry]]:
    # database.json, collections/ and views/ exist by construction under
    # every database that exists at all (the guard has already run).
    names = ("database.json",) + tuple(KIND_TO_DIR.values())
    return [
        (
            name,
            IndexEntry(
                id=name,
                name=name,
                resource_type="mongodb/database_entry",
                vfs_name=name,
            ),
        )
        for name in names
    ]


async def _list_kind_dir(
    accessor: MongoDBAccessor, match: ScopeMatch
) -> list[tuple[str, IndexEntry]]:
    kind = entity_kind(match)
    names = await list_collections(
        accessor.client, match.slots["database"], kind=kind
    )
    return [
        (
            name,
            IndexEntry(
                id=name,
                name=name,
                resource_type=KIND_TO_RESOURCE_TYPE[kind],
                vfs_name=name,
            ),
        )
        for name in names
    ]


async def _list_entity_files(
    accessor: MongoDBAccessor, match: ScopeMatch
) -> list[tuple[str, IndexEntry]]:
    return [
        (
            name,
            IndexEntry(
                id=name,
                name=name,
                resource_type="mongodb/entity_file",
                vfs_name=name,
            ),
        )
        for name in ENTITY_FILES
    ]


readdir = make_readdir(
    detect_scope,
    listers={
        "root": _list_root,
        "database": _list_database,
        "kind_dir": _list_kind_dir,
        "entity": _list_entity_files,
    },
    guards={
        "database": database_guard,
        "kind_dir": database_guard,
        "entity": entity_guard,
    },
)

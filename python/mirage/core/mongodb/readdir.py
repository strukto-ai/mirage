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
from mirage.core.hierarchy.readdir import make_readdir
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.mongodb.client import (
    database_exists,
    entity_exists,
    list_collections,
    list_databases,
)
from mirage.core.mongodb.scope import detect_scope, entity_kind
from mirage.core.mongodb.types import KIND_TO_DIR
from mirage.errors.fs import enoent
from mirage.types import FileStat, FileType

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


def _database_extra(match: ScopeMatch) -> dict[str, str]:
    return {"database": match.slots["database"]}


def _kind_dir_extra(match: ScopeMatch) -> dict[str, str]:
    return {
        "database": match.slots["database"],
        "kind": entity_kind(match),
    }


def _entity_extra(match: ScopeMatch) -> dict[str, str]:
    return {
        "database": match.slots["database"],
        "kind": entity_kind(match),
        "name": match.slots["name"],
    }


# What each kind's stat carries in ``extra``, listed or not.
EXTRAS = {
    "database": _database_extra,
    "kind_dir": _kind_dir_extra,
    "database_json": _database_extra,
    "schema_json": _entity_extra,
    "entity": _entity_extra,
    "documents": _entity_extra,
}


def _dirs(names: list[str] | tuple[str, ...]) -> list[FileStat]:
    return [FileStat(name=name, type=FileType.DIRECTORY) for name in names]


async def _list_root(
    accessor: MongoDBAccessor, match: ScopeMatch
) -> list[FileStat]:
    return _dirs(await list_databases(accessor.client, accessor.config))


async def _list_database(
    accessor: MongoDBAccessor, match: ScopeMatch
) -> list[FileStat]:
    # database.json, collections/ and views/ exist by construction under
    # every database that exists at all (the guard has already run).
    return [
        FileStat(name="database.json", type=FileType.FILE),
        *_dirs(tuple(KIND_TO_DIR.values())),
    ]


async def _list_kind_dir(
    accessor: MongoDBAccessor, match: ScopeMatch
) -> list[FileStat]:
    return _dirs(
        await list_collections(
            accessor.client, match.slots["database"], kind=entity_kind(match)
        )
    )


async def _list_entity_files(
    accessor: MongoDBAccessor, match: ScopeMatch
) -> list[FileStat]:
    return [FileStat(name=name, type=FileType.FILE) for name in ENTITY_FILES]


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
    extras=EXTRAS,
)

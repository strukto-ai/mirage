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

import asyncio
from collections.abc import AsyncIterator

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.grep import grep as generic_grep
from mirage.commands.builtin.grep_helper import pattern_arg
from mirage.commands.builtin.mongodb._provision import search_provision
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.core.mongodb._client import list_databases
from mirage.core.mongodb.glob import resolve_glob
from mirage.core.mongodb.read import read as mongodb_read
from mirage.core.mongodb.readdir import readdir as _readdir
from mirage.core.mongodb.scope import detect_scope
from mirage.core.mongodb.search import (format_grep_results, search_collection,
                                        search_database)
from mirage.core.mongodb.stat import stat as _stat
from mirage.core.mongodb.stream import read_stream
from mirage.core.mongodb.types import ScopeLevel
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("grep",
         resource="mongodb",
         spec=SPECS["grep"],
         provision=search_provision)
async def grep(
    accessor: MongoDBAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    prefix: str = "",
    index: IndexCacheStore,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=SPECS["grep"])
    pattern = pattern_arg(texts, fl)

    config = accessor.config
    limit = config.default_search_limit

    if paths and pattern is not None and "\n" not in pattern:
        scope = detect_scope(paths[0])

        if scope.level in (ScopeLevel.ENTITY, ScopeLevel.DATABASE,
                           ScopeLevel.ROOT):
            if scope.level != ScopeLevel.ROOT:
                await _stat(accessor, paths[0], index=index)
            entity_match = (scope.level == ScopeLevel.ENTITY and scope.database
                            and scope.name)
            if entity_match:
                docs = await search_collection(
                    accessor.client,
                    scope.database,
                    scope.name,
                    pattern,
                    limit=limit,
                )
                results = [(scope.database, scope.name, docs)] if docs else []
            elif scope.level == ScopeLevel.DATABASE and scope.database:
                results = await search_database(
                    accessor.client,
                    scope.database,
                    pattern,
                    limit=limit,
                )
            else:
                databases = await list_databases(
                    accessor.client,
                    config,
                )
                tasks = [
                    search_database(
                        accessor.client,
                        db_name,
                        pattern,
                        limit=limit,
                    ) for db_name in databases
                ]
                nested = await asyncio.gather(*tasks)
                results = []
                for r in nested:
                    results.extend(r)

            all_lines = format_grep_results(results)
            if not all_lines:
                return b"", IOResult(exit_code=1)
            return format_records(all_lines), IOResult()

    resolved = await resolve_glob(accessor, paths,
                                  index=index) if paths else []
    return await generic_grep(
        resolved,
        texts,
        flags,
        readdir=_readdir,
        stat=_stat,
        read_bytes=mongodb_read,
        read_stream=read_stream,
        accessor=accessor,
        stdin=stdin,
        index=index,
    )

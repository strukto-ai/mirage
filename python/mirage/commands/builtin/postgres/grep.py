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

from mirage.accessor.postgres import PostgresAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.grep import grep as generic_grep
from mirage.commands.builtin.generic_bind.adapter import bound_op
from mirage.commands.builtin.grep_helper import pattern_arg, search_pushdown_ok
from mirage.commands.builtin.postgres.io import resolve_glob
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.builtin.utils.paths import has_unresolved_glob
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.core.postgres.read import read as postgres_read
from mirage.core.postgres.readdir import readdir as _readdir
from mirage.core.postgres.scope import detect_scope
from mirage.core.postgres.search import (format_grep_results, search_database,
                                         search_database_metadata,
                                         search_entity, search_entity_metadata,
                                         search_kind, search_kind_metadata,
                                         search_schema, search_schema_metadata)
from mirage.core.postgres.stat import stat as _stat
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("grep", resource="postgres", spec=SPECS["grep"])
async def grep(
    accessor: PostgresAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    prefix: str = "",
    index: IndexCacheStore,
    **flags: FlagValue,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=SPECS["grep"])
    pattern = pattern_arg(texts, fl)
    ci = fl.as_bool("i")

    limit = accessor.config.default_search_limit

    # The push-down is a literal-substring search (case-sensitive unless -i)
    # that prints each matching row as a whole line; it cannot honor
    # output/match-shaping flags or a real regex, so those defer to the
    # generic scan below.
    if (paths and not has_unresolved_glob(paths) and pattern is not None
            and search_pushdown_ok(flags, pattern)):
        scope = detect_scope(paths[0])

        if scope.level != "root":
            await _stat(accessor, paths[0], index=index)

        # Directory scopes cover every file under them, so the rendered
        # schema.json / semantic.json are searched alongside the row
        # push-down. Deliberate divergence from GNU: rows come first and
        # metadata second, rather than in per-entity readdir order.
        if scope.level == "root":
            results = await search_database(accessor,
                                            pattern,
                                            limit,
                                            case_insensitive=ci)
            all_lines = format_grep_results(results)
            all_lines += await search_database_metadata(accessor,
                                                        pattern,
                                                        case_insensitive=ci)
            if not all_lines:
                return b"", IOResult(exit_code=1)
            return format_records(all_lines), IOResult()

        if scope.level == "schema":
            results = await search_schema(accessor,
                                          scope.schema,
                                          pattern,
                                          limit,
                                          case_insensitive=ci)
            all_lines = format_grep_results(results)
            all_lines += await search_schema_metadata(accessor,
                                                      scope.schema,
                                                      pattern,
                                                      case_insensitive=ci)
            if not all_lines:
                return b"", IOResult(exit_code=1)
            return format_records(all_lines), IOResult()

        if scope.level == "kind":
            results = await search_kind(accessor,
                                        scope.schema,
                                        scope.kind,
                                        pattern,
                                        limit,
                                        case_insensitive=ci)
            all_lines = format_grep_results(results)
            all_lines += await search_kind_metadata(accessor,
                                                    scope.schema,
                                                    scope.kind,
                                                    pattern,
                                                    case_insensitive=ci)
            if not all_lines:
                return b"", IOResult(exit_code=1)
            return format_records(all_lines), IOResult()

        if scope.level in ("entity", "entity_rows"):
            rows = await search_entity(accessor,
                                       scope.schema,
                                       scope.kind,
                                       scope.entity,
                                       pattern,
                                       limit,
                                       case_insensitive=ci)
            results = [(scope.schema, scope.kind, scope.entity, rows)]
            all_lines = format_grep_results(results)
            # entity_rows names rows.jsonl explicitly; only the directory
            # scope pulls in the sibling metadata files.
            if scope.level == "entity":
                all_lines += await search_entity_metadata(accessor,
                                                          scope.schema,
                                                          scope.kind,
                                                          scope.entity,
                                                          pattern,
                                                          case_insensitive=ci)
            if not all_lines:
                return b"", IOResult(exit_code=1)
            return format_records(all_lines), IOResult()

    resolved = await resolve_glob(accessor, paths,
                                  index=index) if paths else []
    return await generic_grep(
        resolved,
        texts,
        flags,
        readdir=bound_op(_readdir, accessor, index),
        stat=bound_op(_stat, accessor, index),
        read_bytes=bound_op(postgres_read, accessor, index),
        read_stream=None,
        stdin=stdin,
    )

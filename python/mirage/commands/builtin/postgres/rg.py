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
from mirage.commands.builtin.generic.rg import rg as generic_rg
from mirage.commands.builtin.generic_bind.adapter import bound_op
from mirage.commands.builtin.grep_helper import pattern_arg, search_pushdown_ok
from mirage.commands.builtin.postgres.io import resolve_glob
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.builtin.utils.paths import has_unresolved_glob
from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
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


@command("rg", resource="postgres", spec=SPECS["rg"])
async def rg(accessor: PostgresAccessor, paths: list[PathSpec],
             texts: list[str],
             opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPECS["rg"])
    pattern_str = pattern_arg(texts, fl)
    if pattern_str is None:
        raise UsageError("rg: usage: rg [flags] pattern [path]")

    config = accessor.config
    limit = config.default_search_limit
    ci = fl.as_bool("i")

    # Native search takes one literal pattern and prints each matching row as
    # a whole line; a multi -e set (#347), a real regex, or any match/output
    # shaping flag must fall through to the generic scan below.
    if (paths and not has_unresolved_glob(paths)
            and search_pushdown_ok(opts.flags, pattern_str)):
        scope = detect_scope(paths[0])

        # Directory scopes cover every file under them, so the rendered
        # schema.json / semantic.json are searched alongside the row
        # push-down. Deliberate divergence from GNU: rows come first and
        # metadata second, rather than in per-entity readdir order.
        if scope.level == "root":
            results = await search_database(accessor,
                                            pattern_str,
                                            limit,
                                            case_insensitive=ci)
            all_lines = format_grep_results(results)
            all_lines += await search_database_metadata(accessor,
                                                        pattern_str,
                                                        case_insensitive=ci)
            if not all_lines:
                return b"", IOResult(exit_code=1)
            return format_records(all_lines), IOResult()

        if scope.level == "schema":
            results = await search_schema(accessor,
                                          scope.schema,
                                          pattern_str,
                                          limit,
                                          case_insensitive=ci)
            all_lines = format_grep_results(results)
            all_lines += await search_schema_metadata(accessor,
                                                      scope.schema,
                                                      pattern_str,
                                                      case_insensitive=ci)
            if not all_lines:
                return b"", IOResult(exit_code=1)
            return format_records(all_lines), IOResult()

        if scope.level == "kind":
            results = await search_kind(accessor,
                                        scope.schema,
                                        scope.kind,
                                        pattern_str,
                                        limit,
                                        case_insensitive=ci)
            all_lines = format_grep_results(results)
            all_lines += await search_kind_metadata(accessor,
                                                    scope.schema,
                                                    scope.kind,
                                                    pattern_str,
                                                    case_insensitive=ci)
            if not all_lines:
                return b"", IOResult(exit_code=1)
            return format_records(all_lines), IOResult()

        if scope.level in ("entity", "entity_rows"):
            rows = await search_entity(accessor,
                                       scope.schema,
                                       scope.kind,
                                       scope.entity,
                                       pattern_str,
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
                                                          pattern_str,
                                                          case_insensitive=ci)
            if not all_lines:
                return b"", IOResult(exit_code=1)
            return format_records(all_lines), IOResult()

    resolved = await resolve_glob(accessor, paths,
                                  index=opts.index) if paths else []
    return await generic_rg(
        resolved,
        texts,
        opts.flags,
        readdir=bound_op(_readdir, accessor, opts.index),
        stat=bound_op(_stat, accessor, opts.index),
        read_bytes=bound_op(postgres_read, accessor, opts.index),
        read_stream=None,
        stdin=opts.stdin,
    )

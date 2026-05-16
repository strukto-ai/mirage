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

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.grep_helper import compile_pattern, grep_lines
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.mongodb._client import list_databases
from mirage.core.mongodb.glob import resolve_glob
from mirage.core.mongodb.read import read as mongodb_read
from mirage.core.mongodb.readdir import readdir as _readdir
from mirage.core.mongodb.scope import detect_scope
from mirage.core.mongodb.search import (format_grep_results, search_collection,
                                        search_database)
from mirage.core.mongodb.types import ScopeLevel
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def _collect_files(
    accessor: MongoDBAccessor,
    path: PathSpec,
    index: IndexCacheStore | None,
) -> list[str]:
    try:
        children = await _readdir(accessor, path, index)
    except FileNotFoundError:
        return []
    files: list[str] = []
    for child in children:
        if child.endswith(".json") or child.endswith(".jsonl"):
            files.append(child)
        else:
            child_spec = PathSpec(original=child,
                                  directory=child,
                                  resolved=False,
                                  prefix=path.prefix)
            files.extend(await _collect_files(accessor, child_spec, index))
    return files


@command("rg", resource="mongodb", spec=SPECS["rg"])
async def rg(
    accessor: MongoDBAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    i: bool = False,
    v: bool = False,
    n: bool = False,
    c: bool = False,
    args_l: bool = False,
    w: bool = False,
    F: bool = False,
    o: bool = False,
    m: str | None = None,
    A: str | None = None,
    B: str | None = None,
    C: str | None = None,
    hidden: bool = False,
    type: str | None = None,
    glob: str | None = None,
    prefix: str = "",
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not texts:
        raise ValueError("rg: usage: rg [flags] pattern [path]")
    pattern_str = texts[0]
    max_count = int(m) if m is not None else None
    pat = compile_pattern(pattern_str, i, F, w)

    config = accessor.config
    limit = config.default_search_limit

    if paths:
        scope = detect_scope(paths[0])

        if scope.level in (ScopeLevel.ENTITY, ScopeLevel.DATABASE,
                           ScopeLevel.ROOT):
            entity_match = (scope.level == ScopeLevel.ENTITY and scope.database
                            and scope.name)
            if entity_match:
                docs = await search_collection(
                    accessor.client,
                    scope.database,
                    scope.name,
                    pattern_str,
                    limit=limit,
                )
                results = [(scope.database, scope.name, docs)] if docs else []
            elif scope.level == ScopeLevel.DATABASE and scope.database:
                results = await search_database(
                    accessor.client,
                    scope.database,
                    pattern_str,
                    limit=limit,
                )
            else:
                databases = await list_databases(accessor.client, config)
                results = []
                for db_name in databases:
                    results.extend(await search_database(
                        accessor.client,
                        db_name,
                        pattern_str,
                        limit=limit,
                    ))

            all_lines = format_grep_results(results)
            if not all_lines:
                return b"", IOResult(exit_code=1)
            return "\n".join(all_lines).encode(), IOResult()

        paths = await resolve_glob(accessor, paths, index=index)
        blob_paths: list[str] = []
        file_prefix = paths[0].prefix if paths else ""
        for path_item in paths:
            blob_paths.extend(await _collect_files(accessor, path_item, index))
        blob_paths = sorted(set(blob_paths))
        all_results: list[str] = []
        any_match = False
        for bp in blob_paths:
            if not hidden and any(
                    part.startswith(".") for part in bp.split("/")):
                continue
            try:
                bp_spec = PathSpec(original=bp,
                                   directory=bp,
                                   resolved=True,
                                   prefix=file_prefix)
                data = await mongodb_read(accessor, bp_spec, index)
            except (FileNotFoundError, IsADirectoryError, RuntimeError):
                continue
            text = data.decode(errors="replace")
            if not text:
                continue
            lines = text.splitlines()
            matched = grep_lines(bp,
                                 lines,
                                 pat,
                                 invert=v,
                                 line_numbers=n,
                                 count_only=c,
                                 files_only=args_l,
                                 only_matching=o,
                                 max_count=max_count)
            if not matched:
                continue
            any_match = True
            if args_l:
                all_results.append(bp)
                continue
            if c:
                all_results.append(f"{bp}:{len(matched)}")
                continue
            for line in matched:
                all_results.append(f"{bp}:{line}")
        if not any_match:
            return b"", IOResult(exit_code=1)
        return "\n".join(all_results).encode(), IOResult()

    raw = await _read_stdin_async(stdin)
    if raw is None:
        raise ValueError("rg: usage: rg [flags] pattern path")
    lines = raw.decode(errors="replace").splitlines()
    matched = grep_lines("<stdin>",
                         lines,
                         pat,
                         invert=v,
                         line_numbers=n,
                         count_only=c,
                         files_only=args_l,
                         only_matching=o,
                         max_count=max_count)
    if not matched:
        return b"", IOResult(exit_code=1)
    if c:
        return str(len(matched)).encode(), IOResult()
    result_lines: list[str] = []
    for line in matched:
        result_lines.append(line)
    return "\n".join(result_lines).encode(), IOResult()

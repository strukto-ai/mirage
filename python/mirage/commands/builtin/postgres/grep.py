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
from functools import partial

from mirage.accessor.postgres import PostgresAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.grep_helper import (compile_pattern,
                                                 grep_files_only, grep_lines,
                                                 grep_stream)
from mirage.commands.builtin.postgres._provision import file_read_provision
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.builtin.utils.wrap import (call_read_bytes, call_readdir,
                                                call_stat)
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.postgres.glob import resolve_glob
from mirage.core.postgres.read import read as postgres_read
from mirage.core.postgres.readdir import readdir as _readdir
from mirage.core.postgres.scope import detect_scope
from mirage.core.postgres.search import (format_grep_results, search_database,
                                         search_entity, search_kind,
                                         search_schema)
from mirage.core.postgres.stat import stat as _stat
from mirage.io.stream import exit_on_empty, quiet_match, yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec


async def grep_provision(
    accessor: PostgresAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> ProvisionResult:
    return await file_read_provision(
        accessor, paths,
        "grep " + " ".join(texts + tuple(str(p) for p in paths)))


@command("grep",
         resource="postgres",
         spec=SPECS["grep"],
         provision=grep_provision)
async def grep(
    accessor: PostgresAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    r: bool = False,
    R: bool = False,
    i: bool = False,
    v: bool = False,
    n: bool = False,
    c: bool = False,
    args_l: bool = False,
    w: bool = False,
    F: bool = False,
    E: bool = False,
    o: bool = False,
    m: str | None = None,
    q: bool = False,
    H: bool = False,
    args_h: bool = False,
    A: str | None = None,
    B: str | None = None,
    C: str | None = None,
    e: str | None = None,
    prefix: str = "",
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if e is not None:
        pattern = e
    elif texts:
        pattern = texts[0]
    else:
        raise ValueError("grep: usage: grep [flags] pattern [path]")
    max_count = int(m) if m is not None else None
    after_ctx = int(A) if A is not None else (int(C) if C is not None else 0)
    before_ctx = int(B) if B is not None else (int(C) if C is not None else 0)

    config = accessor.config
    limit = config.default_search_limit

    if paths:
        scope = detect_scope(paths[0])

        if scope.level == "root":
            results = await search_database(accessor, pattern, limit)
            all_lines = format_grep_results(results)
            if not all_lines:
                return b"", IOResult(exit_code=1)
            return "\n".join(all_lines).encode(), IOResult()

        if scope.level == "schema":
            results = await search_schema(accessor, scope.schema, pattern,
                                          limit)
            all_lines = format_grep_results(results)
            if not all_lines:
                return b"", IOResult(exit_code=1)
            return "\n".join(all_lines).encode(), IOResult()

        if scope.level == "kind":
            results = await search_kind(accessor, scope.schema, scope.kind,
                                        pattern, limit)
            all_lines = format_grep_results(results)
            if not all_lines:
                return b"", IOResult(exit_code=1)
            return "\n".join(all_lines).encode(), IOResult()

        if scope.level in ("entity", "entity_rows"):
            rows = await search_entity(accessor, scope.schema, scope.kind,
                                       scope.entity, pattern, limit)
            if not rows:
                return b"", IOResult(exit_code=1)
            results = [(scope.schema, scope.kind, scope.entity, rows)]
            all_lines = format_grep_results(results)
            return "\n".join(all_lines).encode(), IOResult()

        paths = await resolve_glob(accessor, paths, index=index)
        file_prefix = paths[0].prefix if paths else ""
        rd = partial(call_readdir,
                     _readdir,
                     accessor,
                     index=index,
                     prefix=file_prefix)
        st = partial(call_stat,
                     _stat,
                     accessor,
                     index=index,
                     prefix=file_prefix)
        rb = partial(call_read_bytes,
                     postgres_read,
                     accessor,
                     index=index,
                     prefix=file_prefix)

        if args_l:
            warnings: list[str] = []
            results_l = await grep_files_only(
                rd,
                st,
                rb,
                paths[0].original,
                pattern,
                recursive=r or R,
                ignore_case=i,
                invert=v,
                line_numbers=n,
                count_only=c,
                fixed_string=F,
                only_matching=o,
                max_count=max_count,
                whole_word=w,
                warnings=warnings,
            )
            stderr = ("\n".join(warnings).encode() if warnings else None)
            if not results_l:
                return b"", IOResult(exit_code=1, stderr=stderr)
            return ("\n".join(results_l).encode(), IOResult(stderr=stderr))

        pat = compile_pattern(pattern, i, F, w)

        if len(paths) > 1:
            all_results: list[str] = []
            for p in paths:
                data = (await
                        rb(p.original)).decode(errors="replace").splitlines()
                hits = grep_lines(p.original, data, pat, v, n, c, args_l, o,
                                  max_count)
                if c:
                    if hits:
                        all_results.append(f"{p.original}:{hits[0]}")
                elif args_l:
                    all_results.extend(hits)
                else:
                    all_results.extend(f"{p.original}:{r_}" for r_ in hits)
            if not all_results:
                return b"", IOResult(exit_code=1)
            return "\n".join(all_results).encode(), IOResult()

        data = await rb(paths[0].original)
        source = yield_bytes(data)
        stream = grep_stream(
            source,
            pat,
            invert=v,
            line_numbers=n,
            only_matching=o,
            max_count=max_count,
            count_only=c,
            after_context=after_ctx,
            before_context=before_ctx,
        )
        if q:
            io = IOResult(exit_code=1)
            return quiet_match(stream, io), io
        io = IOResult()
        return exit_on_empty(stream, io), io

    source = _resolve_source(stdin, "grep: usage: grep [flags] pattern [path]")
    pat = compile_pattern(pattern, i, F, w)
    stream = grep_stream(
        source,
        pat,
        invert=v,
        line_numbers=n,
        only_matching=o,
        max_count=max_count,
        count_only=c,
        after_context=after_ctx,
        before_context=before_ctx,
    )
    if q:
        io = IOResult(exit_code=1)
        return quiet_match(stream, io), io
    io = IOResult()
    return exit_on_empty(stream, io), io

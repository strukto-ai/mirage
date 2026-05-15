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

import logging
from collections.abc import AsyncIterator
from functools import partial

from mirage.accessor.slack import SlackAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.grep_helper import (compile_pattern,
                                                 grep_files_only, grep_lines,
                                                 grep_stream)
from mirage.commands.builtin.slack._provision import file_read_provision
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.builtin.utils.wrap import (call_read_bytes, call_readdir,
                                                call_stat)
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.slack.formatters import (build_query,
                                          format_file_grep_results,
                                          format_grep_results)
from mirage.core.slack.glob import resolve_glob
from mirage.core.slack.read import read as slack_read
from mirage.core.slack.readdir import readdir as _readdir
from mirage.core.slack.scope import coalesce_scopes, detect_scope
from mirage.core.slack.search import (search_available, search_files,
                                      search_messages)
from mirage.core.slack.stat import stat as _stat
from mirage.io.stream import exit_on_empty, quiet_match, yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec

logger = logging.getLogger(__name__)


async def grep_provision(
    accessor: SlackAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> ProvisionResult:
    return await file_read_provision(
        accessor, paths,
        "grep " + " ".join(texts + tuple(str(p) for p in paths)))


@command("grep",
         resource="slack",
         spec=SPECS["grep"],
         provision=grep_provision)
async def grep(
    accessor: SlackAccessor,
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

    if paths:
        scope = detect_scope(paths[0])
        if not scope.use_native:
            scope = coalesce_scopes(paths) or scope

        if scope.use_native and search_available(accessor.config):
            file_prefix = paths[0].prefix or ""
            query = build_query(pattern, scope)
            target = getattr(scope, "target", None)
            do_msgs = target in (None, "date", "messages")
            do_files = target in (None, "date", "files")
            native_lines: list[str] = []
            err: Exception | None = None
            try:
                if do_msgs:
                    raw = await search_messages(accessor.config,
                                                query,
                                                count=max_count or 100)
                    native_lines.extend(
                        format_grep_results(raw, scope, file_prefix))
                if do_files:
                    raw_f = await search_files(accessor.config,
                                               query,
                                               count=max_count or 100)
                    native_lines.extend(
                        format_file_grep_results(raw_f, scope, file_prefix))
            except Exception as exc:
                err = exc
            if err is None:
                if not native_lines:
                    return b"", IOResult(exit_code=1)
                return ("\n".join(native_lines) + "\n").encode(), IOResult()
            logger.warning(
                "slack search push-down failed (%s); "
                "falling back to per-file scan", err)

        paths = await resolve_glob(accessor, paths, index)
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
                     slack_read,
                     accessor,
                     index=index,
                     prefix=file_prefix)

        if args_l:
            warnings: list[str] = []
            results = await grep_files_only(
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
            if not results:
                return b"", IOResult(exit_code=1, stderr=stderr)
            return ("\n".join(results).encode(), IOResult(stderr=stderr))

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
                    all_results.extend(f"{p.original}:{r}" for r in hits)
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

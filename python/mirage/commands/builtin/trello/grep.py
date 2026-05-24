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

from mirage.accessor.trello import TrelloAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.grep_helper import (compile_pattern,
                                                 grep_files_only,
                                                 grep_recursive, grep_stream)
from mirage.commands.builtin.trello._provision import file_read_provision
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.builtin.utils.wrap import (call_read_bytes, call_readdir,
                                                call_stat)
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.trello.glob import resolve_glob
from mirage.core.trello.read import read as trello_read
from mirage.core.trello.readdir import readdir as _readdir
from mirage.core.trello.scope import scope_warning
from mirage.core.trello.stat import stat as _stat
from mirage.io.stream import exit_on_empty, quiet_match, yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import FileType, PathSpec


async def grep_provision(
    accessor: TrelloAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> ProvisionResult:
    rendered = "grep " + " ".join(texts + tuple(str(p) for p in paths))
    return await file_read_provision(accessor, paths, rendered)


@command("grep",
         resource="trello",
         spec=SPECS["grep"],
         provision=grep_provision)
async def grep(
    accessor: TrelloAccessor,
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
        paths = await resolve_glob(accessor, paths, index)
        file_prefix = paths[0].prefix if paths else ""
        warnings: list[str] = []
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
                     trello_read,
                     accessor,
                     index=index,
                     prefix=file_prefix)
        recursive = r or R
        if isinstance(paths[0], PathSpec) and not paths[0].resolved:
            warning = await scope_warning(rd, st, paths[0], recursive)
            if warning:
                warnings.append(warning)
        if args_l:
            results = await grep_files_only(
                rd,
                st,
                rb,
                paths[0].original,
                pattern,
                recursive=recursive,
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
            if prefix:
                results = [prefix + "/" + item.lstrip("/") for item in results]
            return "\n".join(results).encode(), IOResult(stderr=stderr)

        pat = compile_pattern(pattern, i, F, w)
        target = paths[0].original
        file_stat = await st(target)
        if file_stat.type == FileType.DIRECTORY:
            if not recursive:
                return (b"",
                        IOResult(
                            exit_code=1,
                            stderr=f"grep: {target}: Is a directory".encode()))
            results = await grep_recursive(
                rd,
                st,
                rb,
                target,
                pat,
                invert=v,
                line_numbers=n,
                count_only=c,
                files_only=False,
                only_matching=o,
                max_count=max_count,
                warnings=warnings,
            )
            stderr = ("\n".join(warnings).encode() if warnings else None)
            if not results:
                return b"", IOResult(exit_code=1, stderr=stderr)
            return "\n".join(results).encode(), IOResult(stderr=stderr)

        data = await rb(target)
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
        io = IOResult(
            stderr="\n".join(warnings).encode() if warnings else None)
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

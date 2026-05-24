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
from mirage.commands.builtin.rg_helper import (compile_pattern, rg_folder,
                                               rg_matches_filter,
                                               rg_search_file)
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
from mirage.io.stream import exit_on_empty
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import FileType, PathSpec


async def rg_provision(
    accessor: TrelloAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> ProvisionResult:
    rendered = "rg " + " ".join(texts + tuple(str(p) for p in paths))
    return await file_read_provision(accessor, paths, rendered)


@command("rg", resource="trello", spec=SPECS["rg"], provision=rg_provision)
async def rg(
    accessor: TrelloAccessor,
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
    pattern = texts[0]
    max_count = int(m) if m is not None else None
    context_after = int(A) if A is not None else 0
    context_before = int(B) if B is not None else 0
    if C is not None:
        context_before = context_after = int(C)
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
        if isinstance(paths[0], PathSpec) and not paths[0].resolved:
            warning = await scope_warning(rd, st, paths[0], True)
            if warning:
                warnings.append(warning)
        target = paths[0].original
        file_stat = await st(target)
        compiled = compile_pattern(pattern, i, F, w)
        if file_stat.type == FileType.DIRECTORY:
            results = await rg_folder(
                rd,
                st,
                rb,
                target,
                pattern,
                i,
                v,
                n,
                c,
                args_l,
                o,
                max_count,
                F,
                w,
                type,
                glob,
                hidden,
                warnings,
            )
            stderr = ("\n".join(warnings).encode() if warnings else None)
            if not results:
                return b"", IOResult(exit_code=1, stderr=stderr)
            if prefix and args_l:
                results = [prefix + "/" + item.lstrip("/") for item in results]
            return "\n".join(results).encode(), IOResult(stderr=stderr)
        if not rg_matches_filter(target, type, glob, hidden):
            return b"", IOResult(exit_code=1)
        raw = await rb(target)
        results = rg_search_file(
            lambda _: raw,
            target,
            compiled,
            v,
            n,
            c,
            args_l,
            o,
            max_count,
            context_before,
            context_after,
            False,
            warnings,
        )
        stderr = ("\n".join(warnings).encode() if warnings else None)
        if not results:
            return b"", IOResult(exit_code=1, stderr=stderr)
        return "\n".join(results).encode(), IOResult(stderr=stderr)

    return await grep_stdin(texts[0],
                            stdin,
                            i=i,
                            v=v,
                            n=n,
                            c=c,
                            w=w,
                            F=F,
                            o=o,
                            m=m)


async def grep_stdin(
    pattern: str,
    stdin: AsyncIterator[bytes] | bytes | None,
    *,
    i: bool,
    v: bool,
    n: bool,
    c: bool,
    w: bool,
    F: bool,
    o: bool,
    m: str | None,
) -> tuple[ByteSource | None, IOResult]:
    from mirage.commands.builtin.general.grep import _grep_stream

    source = _resolve_source(stdin, "rg: usage: rg [flags] pattern path")
    compiled = compile_pattern(pattern, i, F, w)
    max_count = int(m) if m is not None else None
    stream = _grep_stream(
        source,
        compiled,
        invert=v,
        line_numbers=n,
        only_matching=o,
        max_count=max_count,
        count_only=c,
    )
    io = IOResult()
    return exit_on_empty(stream, io), io

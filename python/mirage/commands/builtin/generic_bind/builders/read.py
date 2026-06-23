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

from mirage.commands.builtin.aggregators import (concat_aggregate,
                                                 header_aggregate,
                                                 wc_aggregate)
from mirage.commands.builtin.generic.cat import cat as generic_cat
from mirage.commands.builtin.generic.cut import cut as generic_cut
from mirage.commands.builtin.generic.head import head as generic_head
from mirage.commands.builtin.generic.head import head_multi
from mirage.commands.builtin.generic.nl import nl as generic_nl
from mirage.commands.builtin.generic.rev import rev as generic_rev
from mirage.commands.builtin.generic.sort import sort as generic_sort
from mirage.commands.builtin.generic.tail import tail as generic_tail
from mirage.commands.builtin.generic.tail import tail_multi
from mirage.commands.builtin.generic.uniq import uniq as generic_uniq
from mirage.commands.builtin.generic.wc import format_multi, format_wc
from mirage.commands.builtin.generic.wc import wc as generic_wc
from mirage.commands.builtin.generic.wc import wc_lines as generic_wc_lines
from mirage.commands.builtin.generic_bind.adapter import CommandIO
from mirage.commands.builtin.generic_bind.provision import (
    make_file_read_provision, make_head_tail_provision)
from mirage.commands.builtin.tail_helper import _parse_n
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.io.cachable_iterator import CachableAsyncIterator
from mirage.io.stream import async_chain, chain_cachables
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def _cat(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    n: bool = False,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if paths and ops.ready(accessor):
        paths = await ops.resolve_glob(accessor, paths, index)
        if ops.local:
            for p in paths:
                await ops.stat(accessor, p, index)
        if len(paths) == 1:
            p = paths[0]
            if not ops.local:
                await ops.stat(accessor, p, index)
            cachable = CachableAsyncIterator(ops.read_stream(accessor, p))
            io = IOResult(reads={p.strip_prefix: cachable},
                          cache=[p.strip_prefix])
            source: ByteSource = cachable
        elif ops.local:
            cachables = [
                CachableAsyncIterator(ops.read_stream(accessor, p))
                for p in paths
            ]
            io = IOResult(reads={
                p.strip_prefix: c
                for p, c in zip(paths, cachables)
            },
                          cache=[p.strip_prefix for p in paths])
            source = chain_cachables(*cachables)
        else:
            reads: dict[str, ByteSource] = {}
            parts: list[bytes] = []
            for p in paths:
                data = await ops.read_bytes(accessor, p, index)
                reads[p.strip_prefix] = data
                parts.append(data)
            io = IOResult(reads=reads, cache=list(reads))
            source = async_chain(*parts)
        if n:
            return generic_cat(source, number_lines=True), io
        return source, io
    source = _resolve_source(stdin, "cat: missing operand")
    if n:
        return generic_cat(source, number_lines=True), IOResult()
    return source, IOResult()


async def _head(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    n: str | None = None,
    c: str | None = None,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    n_int = int(n) if n is not None else None
    c_int = int(c) if c is not None else None
    if paths and ops.ready(accessor):
        paths = await ops.resolve_glob(accessor, paths, index)
        return head_multi(paths,
                          read=ops.read_stream,
                          accessor=accessor,
                          index=index,
                          n=n_int,
                          c=c_int,
                          show_headers=len(paths) > 1), IOResult()
    source = _resolve_source(stdin, "head: missing operand")
    return generic_head(source, n=n_int, c=c_int), IOResult()


async def _tail(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    n: str | None = None,
    c: str | None = None,
    q: bool = False,
    v: bool = False,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    n_int: int | None = None
    from_line: int | None = None
    if n is not None:
        lines, plus_mode = _parse_n(n)
        if plus_mode:
            from_line = lines
        else:
            n_int = lines
    c_int = int(c) if c is not None else None
    if paths and ops.ready(accessor):
        paths = await ops.resolve_glob(accessor, paths, index)
        show_headers = (v or len(paths) > 1) and not q
        return tail_multi(paths,
                          read=ops.read_stream,
                          accessor=accessor,
                          index=index,
                          n=n_int,
                          c=c_int,
                          from_line=from_line,
                          show_headers=show_headers), IOResult()
    source = _resolve_source(stdin, "tail: missing operand")
    return generic_tail(source, n=n_int, c=c_int,
                        from_line=from_line), IOResult()


async def _wc(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    args_l: bool = False,
    w: bool = False,
    c: bool = False,
    m: bool = False,
    L: bool = False,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if paths and ops.ready(accessor):
        paths = await ops.resolve_glob(accessor, paths, index)
        body = await format_multi(paths,
                                  read=ops.read_stream,
                                  accessor=accessor,
                                  args_l=args_l,
                                  w=w,
                                  c=c,
                                  m=m,
                                  L=L)
        return body, IOResult()
    source: AsyncIterator[bytes] = _resolve_source(stdin,
                                                   "wc: missing operand")
    if args_l and not (L or w or c or m):
        line_count = await generic_wc_lines(source)
        return str(line_count).encode() + b"\n", IOResult()
    counts = await generic_wc(source)
    return (format_wc(counts, args_l=args_l, w=w, c=c, m=m, L=L).encode() +
            b"\n", IOResult())


async def _resolve_or_empty(ops: CommandIO, accessor: object,
                            paths: list[PathSpec],
                            index: object) -> list[PathSpec]:
    if paths and ops.ready(accessor):
        return await ops.resolve_glob(accessor, paths, index)
    return []


async def _nl(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    b: str | None = None,
    v: str | None = None,
    i: str | None = None,
    w: str | None = None,
    s: str | None = None,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = await _resolve_or_empty(ops, accessor, paths, index)
    return await generic_nl(
        paths,
        read_stream=ops.read_stream,
        accessor=accessor,
        stdin=stdin,
        body_numbering_raw=b,
        start_raw=v,
        increment_raw=i,
        width_raw=w,
        separator=s,
    )


async def _sort(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    r: bool = False,
    n: bool = False,
    u: bool = False,
    f: bool = False,
    k: str | None = None,
    t: str | None = None,
    h: bool = False,
    V: bool = False,
    s: bool = False,
    M: bool = False,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = await _resolve_or_empty(ops, accessor, paths, index)
    return await generic_sort(
        paths,
        read_bytes=ops.read_bytes,
        accessor=accessor,
        stdin=stdin,
        reverse=r,
        numeric=n,
        unique=u,
        fold_case=f,
        key_field=int(k) if k is not None else None,
        field_separator=t,
        human_numeric=h,
        version_sort=V,
        month_sort=M,
    )


async def _cut(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    f: str | None = None,
    d: str | None = None,
    c: str | None = None,
    complement: bool = False,
    z: bool = False,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = await _resolve_or_empty(ops, accessor, paths, index)
    return await generic_cut(paths,
                             read_stream=ops.read_stream,
                             accessor=accessor,
                             stdin=stdin,
                             f=f,
                             d=d,
                             c=c,
                             complement=complement,
                             z=z)


async def _uniq(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    c: bool = False,
    d: bool = False,
    u: bool = False,
    f: str | None = None,
    s: str | None = None,
    i: bool = False,
    w: str | None = None,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = await _resolve_or_empty(ops, accessor, paths, index)
    return await generic_uniq(
        paths,
        read_stream=ops.read_stream,
        accessor=accessor,
        stdin=stdin,
        count=c,
        duplicates_only=d,
        unique_only=u,
        skip_fields=f,
        skip_chars=s,
        ignore_case=i,
        check_chars=w,
    )


async def _rev(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = await _resolve_or_empty(ops, accessor, paths, index)
    return await generic_rev(paths,
                             read_bytes=ops.read_bytes,
                             accessor=accessor,
                             stdin=stdin)


# (name, builder, provision_builder, write, aggregate)
READ_BUILDERS = (
    ("cat", _cat, make_file_read_provision, False, concat_aggregate),
    ("head", _head, make_head_tail_provision, False, header_aggregate),
    ("tail", _tail, make_head_tail_provision, False, header_aggregate),
    ("wc", _wc, make_file_read_provision, False, wc_aggregate),
    ("nl", _nl, None, False, None),
    ("sort", _sort, None, False, None),
    ("cut", _cut, None, False, None),
    ("uniq", _uniq, None, False, None),
    ("rev", _rev, None, False, None),
)

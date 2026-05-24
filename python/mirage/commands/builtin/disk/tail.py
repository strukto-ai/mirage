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

from mirage.accessor.disk import DiskAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.aggregators import header_aggregate
from mirage.commands.builtin.generic.tail import tail as generic_tail
from mirage.commands.builtin.tail_helper import _parse_n
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.disk.glob import resolve_glob
from mirage.core.disk.stream import read_stream
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def _tail_multi(
    accessor: DiskAccessor,
    paths: list[PathSpec],
    n: int | None,
    c: int | None,
    from_line: int | None,
    show_headers: bool,
) -> AsyncIterator[bytes]:
    for i, p in enumerate(paths):
        if show_headers:
            header = f"==> {p.original} <==\n"
            if i > 0:
                header = "\n" + header
            yield header.encode()
        source = read_stream(accessor, p)
        async for chunk in generic_tail(source, n=n, c=c, from_line=from_line):
            yield chunk


@command("tail",
         resource="disk",
         spec=SPECS["tail"],
         aggregate=header_aggregate)
async def tail(
    accessor: DiskAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    n: str | None = None,
    c: str | None = None,
    q: bool = False,
    v: bool = False,
    index: IndexCacheStore = None,
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
    if paths and accessor.root is not None:
        paths = await resolve_glob(accessor, paths, index)
        show_headers = (v or len(paths) > 1) and not q
        return _tail_multi(accessor, paths, n_int, c_int, from_line,
                           show_headers), IOResult()
    source = _resolve_source(stdin, "tail: missing operand")
    return generic_tail(source, n=n_int, c=c_int,
                        from_line=from_line), IOResult()

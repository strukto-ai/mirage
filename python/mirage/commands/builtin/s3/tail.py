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

from mirage.accessor.s3 import S3Accessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.tail import tail as generic_tail
from mirage.commands.builtin.generic.tail import tail_multi
from mirage.commands.builtin.s3._provision import head_tail_provision
from mirage.commands.builtin.tail_helper import _parse_n
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.s3.glob import resolve_glob
from mirage.core.s3.stream import read_stream
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("tail",
         resource="s3",
         spec=SPECS["tail"],
         provision=head_tail_provision)
async def tail(
    accessor: S3Accessor,
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
    if paths:
        paths = await resolve_glob(accessor, paths, index)
        show_headers = (v or len(paths) > 1) and not q
        return tail_multi(paths,
                          read=read_stream,
                          accessor=accessor,
                          index=index,
                          n=n_int,
                          c=c_int,
                          from_line=from_line,
                          show_headers=show_headers), IOResult()
    source = _resolve_source(stdin, "tail: missing operand")
    return generic_tail(source, n=n_int, c=c_int,
                        from_line=from_line), IOResult()

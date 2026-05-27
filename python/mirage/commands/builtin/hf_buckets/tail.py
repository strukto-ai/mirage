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

from mirage.accessor.hf_buckets import HfBucketsAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.tail import tail as generic_tail
from mirage.commands.builtin.hf_buckets._provision import head_tail_provision
from mirage.commands.builtin.tail_helper import _parse_n
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.hf_buckets.glob import resolve_glob
from mirage.core.hf_buckets.read import read_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("tail",
         resource="hf_buckets",
         spec=SPECS["tail"],
         provision=head_tail_provision)
async def tail(
    accessor: HfBucketsAccessor,
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
        raw = await read_bytes(accessor, paths[0])
        if c_int is not None:
            should_cache = c_int >= len(raw)
        else:
            should_cache = (from_line is None and n_int is not None
                            and n_int >= raw.count(b"\n"))
        cache = [paths[0].original] if should_cache else []
        return generic_tail(raw, n=n_int, c=c_int,
                            from_line=from_line), IOResult(cache=cache)
    source = _resolve_source(stdin, "tail: missing operand")
    return generic_tail(source, n=n_int, c=c_int,
                        from_line=from_line), IOResult()

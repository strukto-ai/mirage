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
from mirage.commands.builtin.generic.wc import WCCounts, format_wc
from mirage.commands.builtin.generic.wc import wc as generic_wc
from mirage.commands.builtin.hf_buckets._provision import file_read_provision
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.hf_buckets.glob import resolve_glob
from mirage.core.hf_buckets.read import read_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("wc",
         resource="hf_buckets",
         spec=SPECS["wc"],
         provision=file_read_provision)
async def wc(
    accessor: HfBucketsAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    args_l: bool = False,
    w: bool = False,
    c: bool = False,
    m: bool = False,
    L: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        paths = await resolve_glob(accessor, paths, index)
        outputs: list[str] = []
        totals = WCCounts()
        for p in paths:
            data = await read_bytes(accessor, p)
            counts = await generic_wc(data)
            outputs.append(
                format_wc(counts,
                          args_l=args_l,
                          w=w,
                          c=c,
                          m=m,
                          L=L,
                          label=p.original))
            totals.merge(counts)
        if len(paths) > 1:
            outputs.append(
                format_wc(totals,
                          args_l=args_l,
                          w=w,
                          c=c,
                          m=m,
                          L=L,
                          label="total"))
        return "\n".join(outputs).encode(), IOResult()
    source = _resolve_source(stdin, "wc: missing operand")
    counts = await generic_wc(source)
    return format_wc(counts, args_l=args_l, w=w, c=c, m=m,
                     L=L).encode(), IOResult()

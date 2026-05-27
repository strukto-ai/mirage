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

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.databricks_volume._helpers import (
    path_prefix, read_bytes_with_index)
from mirage.commands.builtin.generic.wc import WCCounts, format_wc
from mirage.commands.builtin.generic.wc import wc as generic_wc
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.databricks_volume.glob import resolve_glob
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("wc", resource="databricks_volume", spec=SPECS["wc"])
async def wc(
    accessor: DatabricksVolumeAccessor,
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
        read_bytes = read_bytes_with_index(index, path_prefix(paths))
        outputs: list[str] = []
        totals = WCCounts()
        for path in paths:
            counts = await generic_wc(await read_bytes(accessor, path))
            outputs.append(
                format_wc(counts,
                          args_l=args_l,
                          w=w,
                          c=c,
                          m=m,
                          L=L,
                          label=path.original))
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

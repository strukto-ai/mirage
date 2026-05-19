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
from mirage.commands.builtin.generic.jq import jq as generic_jq
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.disk.glob import resolve_glob
from mirage.core.disk.read import read_bytes
from mirage.core.disk.stat import stat as _stat_async
from mirage.core.disk.stream import read_stream as _stream
from mirage.core.jq import is_jsonl_path, is_streamable_jsonl_expr
from mirage.io.types import ByteSource, IOResult
from mirage.provision import Precision, ProvisionResult
from mirage.types import PathSpec


async def jq_provision(
    accessor: DiskAccessor,
    paths: list[PathSpec] | None = None,
    *texts: str,
    index: IndexCacheStore = None,
    **_extra: object,
) -> ProvisionResult:
    if not paths or accessor.root is None or not texts:
        return ProvisionResult(command="jq")
    p = paths[0]
    s = await _stat_async(accessor, p)
    file_size = s.size or 0
    expr = texts[0]
    if is_jsonl_path(p.original) and is_streamable_jsonl_expr(expr):
        return ProvisionResult(
            command=f"jq {expr!r} {p.original}",
            network_read_low=0,
            network_read_high=file_size,
            read_ops=1,
            precision=Precision.RANGE,
        )
    return ProvisionResult(
        command=f"jq {expr!r} {p.original}",
        network_read_low=file_size,
        network_read_high=file_size,
        read_ops=1,
        precision=Precision.EXACT,
    )


@command("jq", resource="disk", spec=SPECS["jq"], provision=jq_provision)
async def jq(
    accessor: DiskAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    r: bool = False,
    c: bool = False,
    s: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if paths and accessor.root is not None:
        paths = await resolve_glob(accessor, paths, index)
    else:
        paths = []
    return await generic_jq(paths,
                            *texts,
                            read_bytes=read_bytes,
                            read_stream=_stream,
                            accessor=accessor,
                            stdin=stdin,
                            r=r,
                            c=c,
                            s=s)

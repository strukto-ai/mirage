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

from mirage.accessor.ram import RAMAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.filetype.feather import tail as feather_tail
from mirage.core.ram.glob import resolve_glob
from mirage.core.ram.read import read_bytes as _read_bytes
from mirage.core.ram.stat import stat as _stat_async
from mirage.io.types import ByteSource, IOResult
from mirage.provision import ProvisionResult
from mirage.types import PathSpec


async def tail_feather_provision(
    accessor: RAMAccessor = None,
    paths: list[PathSpec] | None = None,
    *texts: str,
    **_extra: object,
) -> ProvisionResult:
    if not paths or accessor.store is None:
        return ProvisionResult(command="tail")
    s = await _stat_async(accessor, paths[0])
    return ProvisionResult(
        command=f"tail {paths[0].original}",
        network_read_low=s.size,
        network_read_high=s.size,
        read_ops=1,
    )


@command("tail",
         resource="ram",
         spec=SPECS["tail"],
         filetype=".arrow",
         provision=tail_feather_provision)
@command("tail",
         resource="ram",
         spec=SPECS["tail"],
         filetype=".ipc",
         provision=tail_feather_provision)
@command("tail",
         resource="ram",
         spec=SPECS["tail"],
         filetype=".feather",
         provision=tail_feather_provision)
async def tail_feather(
    accessor: RAMAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    n: str | None = None,
    c: str | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if accessor.accessor.store is None or not paths:
        raise ValueError("tail: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    if c is not None:
        return None, IOResult(
            exit_code=1,
            stderr=b"tail: -c not supported for feather files",
        )
    try:
        lines = int(n) if n is not None else 10
        raw = await _read_bytes(accessor, paths[0])
        result = feather_tail(raw, n=lines)
        return result, IOResult(reads={paths[0].strip_prefix: raw},
                                cache=[paths[0].strip_prefix])
    except Exception as e:
        return None, IOResult(
            exit_code=1,
            stderr=f"tail: {paths[0].original}: failed to read as feather: {e}"
            .encode(),
        )

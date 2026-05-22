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
from mirage.core.filetype.hdf5 import wc as hdf5_wc
from mirage.core.ram.glob import resolve_glob
from mirage.core.ram.read import read_bytes as _read_bytes
from mirage.core.ram.stat import stat as _stat_async
from mirage.io.types import ByteSource, IOResult
from mirage.provision import ProvisionResult
from mirage.types import PathSpec


async def wc_hdf5_provision(
    accessor: RAMAccessor = None,
    paths: list[PathSpec] | None = None,
    *texts: str,
    **_extra: object,
) -> ProvisionResult:
    if not paths or accessor.store is None:
        return ProvisionResult(command="wc")
    s = await _stat_async(accessor, paths[0])
    return ProvisionResult(
        command=f"wc {paths[0].original}",
        network_read_low=s.size,
        network_read_high=s.size,
        read_ops=1,
    )


@command("wc",
         resource="ram",
         spec=SPECS["wc"],
         filetype=".hdf5",
         provision=wc_hdf5_provision)
@command("wc",
         resource="ram",
         spec=SPECS["wc"],
         filetype=".h5",
         provision=wc_hdf5_provision)
async def wc_hdf5(
    accessor: RAMAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    args_l: bool = False,
    w: bool = False,
    c: bool = False,
    m: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if accessor.accessor.store is None or not paths:
        raise ValueError("wc: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    if w or c or m:
        return None, IOResult(
            exit_code=1,
            stderr=b"wc: -w/-c/-m not supported for hdf5 files",
        )
    try:
        raw = await _read_bytes(accessor, paths[0])
        row_count = hdf5_wc(raw)
        return str(row_count).encode(), IOResult(
            reads={paths[0].strip_prefix: raw}, cache=[paths[0].strip_prefix])
    except Exception as e:
        return None, IOResult(
            exit_code=1,
            stderr=f"wc: {paths[0].original}: failed to read as hdf5: {e}".
            encode(),
        )

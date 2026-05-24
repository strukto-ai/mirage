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
from mirage.core.filetype.hdf5 import cut as hdf5_cut
from mirage.core.ram.glob import resolve_glob
from mirage.core.ram.read import read_bytes as _read_bytes
from mirage.core.ram.stat import stat as _stat_async
from mirage.io.types import ByteSource, IOResult
from mirage.provision import ProvisionResult
from mirage.types import PathSpec


async def cut_hdf5_provision(
    accessor: RAMAccessor = None,
    paths: list[PathSpec] | None = None,
    *texts: str,
    **_extra: object,
) -> ProvisionResult:
    if not paths or accessor.store is None:
        return ProvisionResult(command="cut")
    s = await _stat_async(accessor, paths[0])
    return ProvisionResult(
        command=f"cut {paths[0].original}",
        network_read_low=s.size,
        network_read_high=s.size,
        read_ops=1,
    )


@command("cut",
         resource="ram",
         spec=SPECS["cut"],
         filetype=".hdf5",
         provision=cut_hdf5_provision)
@command("cut",
         resource="ram",
         spec=SPECS["cut"],
         filetype=".h5",
         provision=cut_hdf5_provision)
async def cut_hdf5(
    accessor: RAMAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    f: str | None = None,
    d: str | None = None,
    c: str | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if accessor.accessor.store is None or not paths:
        raise ValueError("cut: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    if f is None:
        return None, IOResult(
            exit_code=1,
            stderr=b"cut: -f required for hdf5 files (column names)",
        )
    if c is not None:
        return None, IOResult(
            exit_code=1,
            stderr=b"cut: -c not supported for hdf5; use -f",
        )
    try:
        columns = [col.strip() for col in f.split(",")]
        raw = await _read_bytes(accessor, paths[0])
        result = hdf5_cut(raw, columns=columns)
        return result, IOResult(reads={paths[0].strip_prefix: raw},
                                cache=[paths[0].strip_prefix])
    except Exception as e:
        return None, IOResult(
            exit_code=1,
            stderr=f"cut: {paths[0].original}: {e}".encode(),
        )

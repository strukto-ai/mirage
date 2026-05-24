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

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.gdrive._provision import file_read_provision
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.filetype.hdf5 import cut as hdf5_cut
from mirage.core.gdrive.glob import resolve_glob
from mirage.core.gdrive.read import read as gdrive_read
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec


async def cut_hdf5_provision(
    accessor: GDriveAccessor,
    paths: list[PathSpec],
    *texts: str,
    index: IndexCacheStore = None,
    **_extra: object,
) -> ProvisionResult:
    return await file_read_provision(accessor,
                                     paths,
                                     f"cut {paths[0]}" if paths else "cut",
                                     index=index)


@command("cut",
         resource="gdrive",
         spec=SPECS["cut"],
         filetype=".hdf5",
         provision=cut_hdf5_provision)
@command("cut",
         resource="gdrive",
         spec=SPECS["cut"],
         filetype=".h5",
         provision=cut_hdf5_provision)
async def cut_hdf5(
    accessor: GDriveAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    f: str | None = None,
    d: str | None = None,
    c: str | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("cut: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    p = paths[0]
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
        raw = await gdrive_read(accessor, p, index)
        result = hdf5_cut(raw, columns=columns)
        return result, IOResult(reads={p.strip_prefix: raw},
                                cache=[p.strip_prefix])
    except Exception as e:
        return None, IOResult(
            exit_code=1,
            stderr=f"cut: {p.original}: {e}".encode(),
        )

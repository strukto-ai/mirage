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
from mirage.core.filetype.hdf5 import grep as hdf5_grep
from mirage.core.gdrive.glob import resolve_glob
from mirage.core.gdrive.read import read as gdrive_read
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec


async def grep_hdf5_provision(
    accessor: GDriveAccessor,
    paths: list[PathSpec],
    *texts: str,
    index: IndexCacheStore = None,
    **_extra: object,
) -> ProvisionResult:
    return await file_read_provision(accessor,
                                     paths,
                                     f"grep {paths[0]}" if paths else "grep",
                                     index=index)


@command("grep",
         resource="gdrive",
         spec=SPECS["grep"],
         filetype=".hdf5",
         provision=grep_hdf5_provision)
@command("grep",
         resource="gdrive",
         spec=SPECS["grep"],
         filetype=".h5",
         provision=grep_hdf5_provision)
async def grep_hdf5(
    accessor: GDriveAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    r: bool = False,
    R: bool = False,
    i: bool = False,
    v: bool = False,
    n: bool = False,
    c: bool = False,
    args_l: bool = False,
    w: bool = False,
    F: bool = False,
    E: bool = False,
    o: bool = False,
    m: str | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not paths or not texts:
        raise ValueError("grep: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    p = paths[0]
    try:
        pattern = texts[0]
        raw = await gdrive_read(accessor, p, index)
        result = hdf5_grep(raw, pattern, ignore_case=i)
        if c:
            count = len(result.decode().strip().splitlines()) - 1
            return str(max(0, count)).encode(), IOResult(
                reads={p.strip_prefix: raw}, cache=[p.strip_prefix])
        return result, IOResult(reads={p.strip_prefix: raw},
                                cache=[p.strip_prefix])
    except Exception as e:
        return None, IOResult(
            exit_code=1,
            stderr=f"grep: {p.original}: failed to read as hdf5: {e}".encode(),
        )

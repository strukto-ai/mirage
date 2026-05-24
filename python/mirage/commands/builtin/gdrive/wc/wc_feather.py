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
from mirage.core.filetype.feather import wc as feather_wc
from mirage.core.gdrive.glob import resolve_glob
from mirage.core.gdrive.read import read as gdrive_read
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec


async def wc_feather_provision(
    accessor: GDriveAccessor,
    paths: list[PathSpec],
    *texts: str,
    index: IndexCacheStore = None,
    **_extra: object,
) -> ProvisionResult:
    return await file_read_provision(accessor,
                                     paths,
                                     f"wc {paths[0]}" if paths else "wc",
                                     index=index)


@command("wc",
         resource="gdrive",
         spec=SPECS["wc"],
         filetype=".arrow",
         provision=wc_feather_provision)
@command("wc",
         resource="gdrive",
         spec=SPECS["wc"],
         filetype=".ipc",
         provision=wc_feather_provision)
@command("wc",
         resource="gdrive",
         spec=SPECS["wc"],
         filetype=".feather",
         provision=wc_feather_provision)
async def wc_feather(
    accessor: GDriveAccessor,
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
    if not paths:
        raise ValueError("wc: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    p = paths[0]
    if w or c or m:
        return None, IOResult(
            exit_code=1,
            stderr=b"wc: -w/-c/-m not supported for feather files",
        )
    try:
        raw = await gdrive_read(accessor, p, index)
        row_count = feather_wc(raw)
        return str(row_count).encode(), IOResult(reads={p.strip_prefix: raw},
                                                 cache=[p.strip_prefix])
    except Exception as e:
        return None, IOResult(
            exit_code=1,
            stderr=f"wc: {p.original}: failed to read as feather: {e}".encode(
            ),
        )

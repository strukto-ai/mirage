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

from mirage.accessor.gdocs import GDocsAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.gdocs._provision import metadata_provision
from mirage.commands.builtin.generic.stat import stat as generic_stat
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.gdocs.glob import resolve_glob
from mirage.core.gdocs.stat import stat as stat_core
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec


async def stat_provision(
    accessor: GDocsAccessor,
    paths: list[PathSpec],
    *texts: str,
    index: IndexCacheStore = None,
    **_extra: object,
) -> ProvisionResult:
    return await metadata_provision(
        "stat " + " ".join(p.original if isinstance(p, PathSpec) else p
                           for p in paths),
        index=index)


@command("stat",
         resource="gdocs",
         spec=SPECS["stat"],
         provision=stat_provision)
async def stat(
    accessor: GDocsAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    c: str | None = None,
    f: str | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("stat: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    return await generic_stat(paths,
                              stat_fn=stat_core,
                              accessor=accessor,
                              c=c,
                              f=f,
                              index=index)

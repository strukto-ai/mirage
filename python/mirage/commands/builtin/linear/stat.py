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

import json

from mirage.accessor.linear import LinearAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.linear._provision import metadata_provision
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.linear.glob import resolve_glob
from mirage.core.linear.stat import stat as linear_stat
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec


async def stat_provision(
    accessor: LinearAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> ProvisionResult:
    return await metadata_provision("stat " + " ".join(
        p.original if isinstance(p, PathSpec) else p for p in paths))


@command("stat",
         resource="linear",
         spec=SPECS["stat"],
         provision=stat_provision)
async def stat(
    accessor: LinearAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    index = index
    paths = await resolve_glob(accessor, paths, index)
    payload = []
    for p in paths:
        payload.append(await linear_stat(accessor, p, index))
    data = [item.model_dump(mode="json") for item in payload]
    return json.dumps(data[0] if len(data) == 1 else data,
                      ensure_ascii=False).encode(), IOResult()

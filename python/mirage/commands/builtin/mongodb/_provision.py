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

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.cache.index import IndexCacheStore
from mirage.provision.types import Precision, ProvisionResult
from mirage.types import PathSpec


async def file_read_provision(
    accessor: MongoDBAccessor,
    paths: list[PathSpec],
    command: str,
    index: IndexCacheStore = None,
) -> ProvisionResult:
    if not paths:
        return ProvisionResult(command=command, precision=Precision.UNKNOWN)
    ops = 0
    if index is not None:
        for p in paths:
            path_str = p.virtual if isinstance(p, PathSpec) else p
            lookup = await index.get(path_str)
            if lookup.entry is not None:
                ops += 1
    return ProvisionResult(
        command=command,
        network_read_low=0,
        network_read_high=0,
        read_ops=ops,
        precision=Precision.EXACT,
    )


async def metadata_provision(command: str) -> ProvisionResult:
    return ProvisionResult(
        command=command,
        network_read_low=0,
        network_read_high=0,
        read_ops=0,
        precision=Precision.EXACT,
    )

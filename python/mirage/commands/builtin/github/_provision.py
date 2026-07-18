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

from mirage.accessor.github import GitHubAccessor
from mirage.cache.index import IndexCacheStore
from mirage.provision.types import Precision, ProvisionResult
from mirage.types import PathSpec


async def file_read_provision(
    accessor: GitHubAccessor,
    index: IndexCacheStore,
    paths: list[PathSpec],
    command: str,
) -> ProvisionResult:
    if not paths:
        return ProvisionResult(command=command, precision=Precision.UNKNOWN)
    total = 0
    ops = 0
    for p in paths:
        result = await index.get(p if isinstance(p, str) else p.virtual)
        if result.entry and result.entry.size:
            total += result.entry.size
            ops += 1
    return ProvisionResult(
        command=command,
        network_read_low=total,
        network_read_high=total,
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

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

from mirage.accessor.ssh import SSHAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.ssh.stat import stat as ssh_stat
from mirage.provision.types import Precision, ProvisionResult
from mirage.types import PathSpec


async def _resolve_sizes(
    accessor: SSHAccessor,
    paths: list[PathSpec],
    index: IndexCacheStore = NULL_INDEX,
) -> tuple[list[tuple[str, int]], int]:
    """Walk paths, return (path, size) pairs. Self-heals via stat fallback."""
    resolved: list[tuple[str, int]] = []
    missing = 0
    for p in paths:
        path_str = p.virtual if isinstance(p, PathSpec) else p
        size = None
        lookup = await index.get(path_str)
        if lookup.entry is not None:
            size = lookup.entry.size
        if size is None:
            try:
                file_stat = await ssh_stat(accessor, p, index)
                size = file_stat.size
            except (FileNotFoundError, ValueError):
                # provision estimates degrade, never fail: unresolved
                # sizes stay UNKNOWN
                pass
        if size is not None:
            resolved.append((path_str, size))
        else:
            missing += 1
    return resolved, missing


async def file_read_provision(
    accessor: SSHAccessor,
    paths: list[PathSpec],
    *_args: object,
    command: str = "",
    index: IndexCacheStore = NULL_INDEX,
    **_extra: object,
) -> ProvisionResult:
    """Cost estimate for full file reads (cat, wc, grep) over SSH/SFTP."""
    if not paths:
        return ProvisionResult(command=command, precision=Precision.UNKNOWN)
    resolved, missing = await _resolve_sizes(accessor, paths, index)
    if missing > 0 or not resolved:
        return ProvisionResult(command=command, precision=Precision.UNKNOWN)
    total = sum(size for _, size in resolved)
    return ProvisionResult(
        command=command,
        network_read_low=total,
        network_read_high=total,
        read_ops=len(resolved),
        precision=Precision.EXACT,
    )

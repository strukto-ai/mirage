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
from mirage.core.gdocs.stat import stat as gdocs_stat
from mirage.provision.types import Precision, ProvisionResult
from mirage.types import PathSpec


async def _resolve_sizes(
    accessor: GDocsAccessor,
    paths: list[PathSpec],
    index: IndexCacheStore | None,
) -> tuple[list[tuple[str, int]], int]:
    """Walk paths, return (path, size) pairs. Self-heals via stat fallback."""
    resolved: list[tuple[str, int]] = []
    missing = 0
    for p in paths:
        path_str = p.original if isinstance(p, PathSpec) else p
        size = None
        if index is not None:
            lookup = await index.get(path_str)
            if lookup.entry is not None:
                size = lookup.entry.size
        if size is None:
            try:
                file_stat = await gdocs_stat(accessor, p, index)
                size = file_stat.size
            except (FileNotFoundError, ValueError):
                pass
        if size is not None:
            resolved.append((path_str, size))
        else:
            missing += 1
    return resolved, missing


async def file_read_provision(
    accessor: GDocsAccessor,
    paths: list[PathSpec],
    command: str = "",
    index: IndexCacheStore | None = None,
    **_extra: object,
) -> ProvisionResult:
    """Cost estimate for full file reads (cat, wc) over Google Docs."""
    if not paths:
        return ProvisionResult(command=command, precision=Precision.UNKNOWN)
    if index is None:
        index = index
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


async def metadata_provision(command: str = "",
                             **_extra: object) -> ProvisionResult:
    """Cost estimate for metadata-only ops over Google Docs."""
    return ProvisionResult(
        command=command,
        network_read_low=0,
        network_read_high=0,
        read_ops=0,
        precision=Precision.EXACT,
    )

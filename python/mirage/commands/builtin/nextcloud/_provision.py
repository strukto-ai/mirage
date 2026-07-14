from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.nextcloud.stat import stat as nextcloud_stat
from mirage.provision.types import Precision, ProvisionResult
from mirage.types import PathSpec


async def _resolve_sizes(
    accessor: NextcloudAccessor,
    paths: list[PathSpec],
    index: IndexCacheStore,
) -> tuple[list[tuple[str, int]], int]:
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
                file_stat = await nextcloud_stat(accessor, p, index)
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
    accessor: NextcloudAccessor,
    paths: list[PathSpec],
    *_args: object,
    command: str = "",
    index: IndexCacheStore,
    **_extra: object,
) -> ProvisionResult:
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

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.nextcloud.stat import stat as nextcloud_stat
from mirage.provision.types import Precision, ProvisionResult
from mirage.types import PathSpec


async def _resolve_sizes(
    accessor: NextcloudAccessor,
    paths: list[PathSpec],
    index: IndexCacheStore | None,
) -> tuple[list[tuple[str, int]], int]:
    resolved: list[tuple[str, int]] = []
    missing = 0
    for p in paths:
        path_str = p.virtual if isinstance(p, PathSpec) else p
        size = None
        if index is not None:
            lookup = await index.get(path_str)
            if lookup.entry is not None:
                size = lookup.entry.size
        if size is None:
            try:
                file_stat = await nextcloud_stat(accessor, p, index)
                size = file_stat.size
            except (FileNotFoundError, ValueError):
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
    index: IndexCacheStore | None = None,
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


async def head_tail_provision(
    accessor: NextcloudAccessor,
    paths: list[PathSpec],
    *_args: object,
    command: str = "",
    n: str | int | None = None,
    c: str | int | None = None,
    index: IndexCacheStore | None = None,
    **_extra: object,
) -> ProvisionResult:
    if not paths:
        return ProvisionResult(command=command, precision=Precision.UNKNOWN)
    resolved, missing = await _resolve_sizes(accessor, paths, index)
    if missing > 0 or not resolved:
        return ProvisionResult(command=command, precision=Precision.UNKNOWN)
    if c is not None:
        c_bytes = int(c)
        total = sum(min(c_bytes, size) for _, size in resolved)
        return ProvisionResult(
            command=command,
            network_read_low=total,
            network_read_high=total,
            read_ops=len(resolved),
            precision=Precision.EXACT,
        )
    full = sum(size for _, size in resolved)
    return ProvisionResult(
        command=command,
        network_read_low=0,
        network_read_high=full,
        read_ops=len(resolved),
        precision=Precision.RANGE,
    )


async def metadata_provision(
    accessor: NextcloudAccessor,
    paths: list[PathSpec],
    *_args: object,
    command: str = "",
    index: IndexCacheStore | None = None,
    **_extra: object,
) -> ProvisionResult:
    n = max(1, len(paths) if paths else 1)
    return ProvisionResult(
        command=command,
        network_read_low=0,
        network_read_high=0,
        read_ops=n,
        precision=Precision.EXACT,
    )

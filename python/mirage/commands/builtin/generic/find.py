from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timezone

from mirage.commands.builtin.find_helper import (_extract_not_name,
                                                 _extract_or_names,
                                                 _parse_mtime, _parse_size)
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileStat, FindType, PathSpec


@dataclass
class FindArgs:
    name: str | None = None
    iname: str | None = None
    path_pattern: str | None = None
    type: FindType | str | None = None
    min_size: int | None = None
    max_size: int | None = None
    mtime_min: float | None = None
    mtime_max: float | None = None
    maxdepth: int | None = None
    mindepth: int | None = None
    name_exclude: str | None = None
    or_names: list[str] | None = None


def parse_find_args(
    texts: tuple[str, ...],
    *,
    name: str | None = None,
    type: str | None = None,
    size: str | None = None,
    mtime: str | None = None,
    maxdepth: str | None = None,
    iname: str | None = None,
    path: str | None = None,
    mindepth: str | None = None,
) -> FindArgs:
    ftype: FindType | str | None = type
    if type in (FindType.DIRECTORY.value, FindType.FILE.value):
        ftype = FindType(type)
    md = int(maxdepth) if maxdepth is not None else None
    md_min = int(mindepth) if mindepth is not None else None
    min_size, max_size = (None, None)
    if size is not None:
        min_size, max_size = _parse_size(size)
    mtime_min, mtime_max = (None, None)
    if mtime is not None:
        mtime_min, mtime_max = _parse_mtime(mtime)
    name_exclude = _extract_not_name(texts)
    or_names_all = _extract_or_names(name, texts)
    or_names = or_names_all if len(or_names_all) > 1 else None
    return FindArgs(
        name=name,
        iname=iname,
        path_pattern=path,
        type=ftype,
        min_size=min_size,
        max_size=max_size,
        mtime_min=mtime_min,
        mtime_max=mtime_max,
        maxdepth=md,
        mindepth=md_min,
        name_exclude=name_exclude,
        or_names=or_names,
    )


async def apply_mtime_filter(
    results: list[str],
    *,
    mtime_min: float | None,
    mtime_max: float | None,
    stat: Callable[[PathSpec], Awaitable[FileStat]],
    mount_prefix: str = "",
) -> list[str]:
    if mtime_min is None and mtime_max is None:
        return results
    filtered: list[str] = []
    for r in results:
        try:
            spec = PathSpec(original=r,
                            directory=r,
                            resolved=False,
                            prefix=mount_prefix)
            s = await stat(spec)
        except (FileNotFoundError, ValueError):
            continue
        if s.modified is None:
            continue
        mod_ts = datetime.fromisoformat(
            s.modified).replace(tzinfo=timezone.utc).timestamp()
        if mtime_min is not None and mod_ts < mtime_min:
            continue
        if mtime_max is not None and mod_ts > mtime_max:
            continue
        filtered.append(r)
    return filtered


def apply_mount_prefix(results: list[str], mount_prefix: str) -> list[str]:
    if not mount_prefix:
        return results
    return [mount_prefix + "/" + r.lstrip("/") for r in results]


async def find(
    paths: list[PathSpec],
    texts: tuple[str, ...],
    *,
    find_core: Callable[..., Awaitable[list[str]]],
    stat: Callable[[PathSpec], Awaitable[FileStat]] | None = None,
    name: str | None = None,
    type: str | None = None,
    size: str | None = None,
    mtime: str | None = None,
    maxdepth: str | None = None,
    iname: str | None = None,
    path: str | None = None,
    mindepth: str | None = None,
) -> tuple[ByteSource | None, IOResult]:
    search_path = paths[0]
    args = parse_find_args(texts,
                           name=name,
                           type=type,
                           size=size,
                           mtime=mtime,
                           maxdepth=maxdepth,
                           iname=iname,
                           path=path,
                           mindepth=mindepth)
    if stat is not None:
        try:
            await stat(search_path)
        except (FileNotFoundError, ValueError) as exc:
            stderr = f"find: '{search_path.original}': {exc}".encode()
            return b"", IOResult(stderr=stderr, exit_code=1)
    results = await find_core(
        search_path,
        name=args.name,
        type=args.type,
        min_size=args.min_size,
        max_size=args.max_size,
        maxdepth=args.maxdepth,
        mindepth=args.mindepth,
        name_exclude=args.name_exclude,
        or_names=args.or_names,
        iname=args.iname,
        path_pattern=args.path_pattern,
    )
    if stat is not None:
        results = await apply_mtime_filter(results,
                                           mtime_min=args.mtime_min,
                                           mtime_max=args.mtime_max,
                                           stat=stat,
                                           mount_prefix=search_path.prefix)
    results = apply_mount_prefix(results, search_path.prefix)
    return "\n".join(results).encode(), IOResult()

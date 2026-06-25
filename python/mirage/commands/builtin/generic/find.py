from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timezone

from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.find_eval import (FindEntry, PredNode,
                                               args_to_tree, keep,
                                               tree_has_empty)
from mirage.commands.builtin.find_helper import (_parse_depth, _parse_mtime,
                                                 _parse_size)
from mirage.commands.builtin.find_parse import parse_find_expression
from mirage.commands.builtin.utils.output import format_records
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileStat, FileType, FindType, PathSpec
from mirage.utils.path import rebase_display


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
    empty: bool = False
    tree: PredNode | None = None


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
    empty: bool = False,
) -> FindArgs:
    if texts:
        expr = parse_find_expression(list(texts))
        return FindArgs(
            min_size=expr.min_size,
            max_size=expr.max_size,
            mtime_min=expr.mtime_min,
            mtime_max=expr.mtime_max,
            maxdepth=expr.maxdepth,
            mindepth=expr.mindepth,
            empty=expr.uses_empty,
            tree=expr.tree,
        )
    ftype: FindType | str | None = type
    if type in (FindType.DIRECTORY.value, FindType.FILE.value):
        ftype = FindType(type)
    md = _parse_depth(maxdepth, "-maxdepth") if maxdepth is not None else None
    md_min = (_parse_depth(mindepth, "-mindepth")
              if mindepth is not None else None)
    min_size, max_size = (None, None)
    if size is not None:
        min_size, max_size = _parse_size(size)
    mtime_min, mtime_max = (None, None)
    if mtime is not None:
        mtime_min, mtime_max = _parse_mtime(mtime)
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
        empty=empty,
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
    out: list[str] = []
    for r in results:
        rel = r.lstrip("/")
        # An empty relative path is the mount root itself (e.g. a
        # single-file view mount); joining would add a bogus slash.
        out.append(mount_prefix if not rel else mount_prefix + "/" + rel)
    return out


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
    empty: bool = False,
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
                           mindepth=mindepth,
                           empty=empty)
    if stat is not None:
        try:
            await stat(search_path)
        except (FileNotFoundError, ValueError) as exc:
            stderr = f"find: '{search_path.display}': {exc}".encode()
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
        empty=args.empty,
        tree=args.tree,
    )
    if stat is not None:
        results = await apply_mtime_filter(results,
                                           mtime_min=args.mtime_min,
                                           mtime_max=args.mtime_max,
                                           stat=stat,
                                           mount_prefix=search_path.prefix)
    results = apply_mount_prefix(results, search_path.prefix)
    results = rebase_display(results, search_path.original,
                             search_path.display)
    return format_records(results), IOResult()


def _modified_ts(modified: str | None) -> float | None:
    # Missing or unparseable timestamps exclude the entry from -mtime
    # matching, mirroring the TS implementation's NaN handling.
    if not modified:
        return None
    try:
        dt = datetime.fromisoformat(modified)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


async def _stat_entry(
    stat: Callable[[PathSpec, IndexCacheStore | None], Awaitable[FileStat]],
    path: str,
    prefix: str,
    index: IndexCacheStore | None,
) -> FileStat | None:
    spec = PathSpec(original=path,
                    directory=path,
                    resolved=False,
                    prefix=prefix)
    try:
        return await stat(spec, index)
    except FileNotFoundError:
        # Only missing entries resolve to None; API errors (rate limit, auth)
        # propagate.
        return None


async def _is_empty_entry(
    readdir: Callable[[PathSpec, IndexCacheStore | None],
                      Awaitable[list[str]]],
    stat: Callable[[PathSpec, IndexCacheStore | None], Awaitable[FileStat]],
    path: str,
    is_dir: bool,
    prefix: str,
    index: IndexCacheStore | None,
) -> bool:
    if is_dir:
        spec = PathSpec(original=path,
                        directory=path,
                        resolved=False,
                        prefix=prefix)
        try:
            return len(await readdir(spec, index)) == 0
        except FileNotFoundError:
            return False
    st = await _stat_entry(stat, path, prefix, index)
    return st is not None and (st.size or 0) == 0


async def _walk_collect(
    readdir: Callable[[PathSpec, IndexCacheStore | None],
                      Awaitable[list[str]]],
    stat: Callable[[PathSpec, IndexCacheStore | None], Awaitable[FileStat]],
    is_dir_name: Callable[[str], bool | None],
    spec: PathSpec,
    index: IndexCacheStore | None,
    maxdepth: int | None,
    depth: int,
    acc: list[tuple[str, bool]],
) -> None:
    if maxdepth is not None and depth > maxdepth:
        return
    try:
        children = await readdir(spec, index)
    except FileNotFoundError:
        # Only vanished dirs are skipped; API errors (rate limit, auth)
        # propagate.
        return
    for child in children:
        hint = is_dir_name(child)
        trimmed = child.rstrip("/") if child.endswith("/") else child
        if hint is None:
            st = await _stat_entry(stat, trimmed, spec.prefix, index)
            is_dir = st is not None and st.type == FileType.DIRECTORY
        else:
            is_dir = hint
        acc.append((trimmed, is_dir))
        if is_dir:
            child_spec = PathSpec(original=trimmed,
                                  directory=trimmed,
                                  resolved=False,
                                  prefix=spec.prefix)
            await _walk_collect(readdir, stat, is_dir_name, child_spec, index,
                                maxdepth, depth + 1, acc)


async def walk_find(
    search_path: PathSpec,
    *,
    readdir: Callable[[PathSpec, IndexCacheStore | None],
                      Awaitable[list[str]]],
    stat: Callable[[PathSpec, IndexCacheStore | None], Awaitable[FileStat]],
    is_dir_name: Callable[[str], bool | None],
    index: IndexCacheStore | None,
    args: FindArgs,
) -> list[str]:
    collected: list[tuple[str, bool]] = []
    prefix = search_path.prefix
    search_key = search_path.strip_prefix.strip("/")
    root_path = (search_path.original.rstrip("/")
                 if search_path.original != "/" else "/")
    root_stat = await _stat_entry(stat, root_path, prefix, index)
    if root_stat is not None:
        collected.append((root_path, root_stat.type == FileType.DIRECTORY))
    # GNU depth convention: the search root is depth 0, its children are
    # depth 1.
    await _walk_collect(readdir, stat, is_dir_name, search_path, index,
                        args.maxdepth, 1, collected)
    tree = args_to_tree(args)
    need_empty = tree_has_empty(tree)
    results: list[str] = []
    for p, is_dir in sorted(collected):
        entry_name = p.rsplit("/", 1)[-1]
        key = p[len(prefix):] if prefix and p.startswith(prefix) else p
        rel = key.strip("/")
        if search_key:
            depth = 0 if rel == search_key else rel.count(
                "/") - search_key.count("/")
        else:
            depth = 0 if rel == "" else rel.count("/") + 1
        is_empty = None
        if need_empty:
            is_empty = await _is_empty_entry(readdir, stat, p, is_dir, prefix,
                                             index)
        entry = FindEntry(key=key,
                          name=entry_name,
                          kind="d" if is_dir else "f",
                          depth=depth,
                          is_empty=is_empty)
        if not keep(entry, tree, args.mindepth):
            continue
        need_size = not is_dir and (args.min_size is not None
                                    or args.max_size is not None)
        need_mtime = args.mtime_min is not None or args.mtime_max is not None
        if need_size or need_mtime:
            st = await _stat_entry(stat, p, prefix, index)
            if st is None:
                continue
            if need_size:
                size = st.size or 0
                if args.min_size is not None and size < args.min_size:
                    continue
                if args.max_size is not None and size > args.max_size:
                    continue
            if need_mtime:
                ts = _modified_ts(st.modified)
                if ts is None:
                    continue
                if args.mtime_min is not None and ts < args.mtime_min:
                    continue
                if args.mtime_max is not None and ts > args.mtime_max:
                    continue
        results.append(p)
    return results

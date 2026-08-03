from collections.abc import Awaitable, Callable
from datetime import datetime, timezone

from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.find_eval import (FindArgs, FindEntry, PredNode,
                                               args_to_tree, keep,
                                               prefix_path_nodes,
                                               tree_has_empty)
from mirage.commands.builtin.find_helper import (_parse_depth, _parse_mtime,
                                                 _parse_size)
from mirage.commands.builtin.find_parse import parse_find_expression
from mirage.commands.builtin.utils.output import format_records
from mirage.io.types import ByteSource, IOResult
from mirage.ops.types import LinkView
from mirage.types import FileStat, FileType, FindType, PathSpec
from mirage.utils.dates import iso_timestamp
from mirage.utils.key_prefix import mount_key, mount_prefix_of
from mirage.utils.path import respell_raw


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
            virtual = apply_mount_prefix([r], mount_prefix)[0]
            spec = PathSpec(virtual=virtual,
                            directory=virtual,
                            resolved=False,
                            resource_path=mount_key(virtual, mount_prefix))
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
    links: LinkView | None = None,
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
    # A start point that is itself a symlink has no backend inode, so
    # neither the existence guard nor the backend walk can see it. GNU's
    # default -P reports the link and stops there, which is exactly what
    # link_results emits below.
    root_is_link = (links is not None
                    and links.stat_at(search_path.virtual) is not None)
    if stat is not None and not root_is_link:
        try:
            await stat(search_path)
        except (FileNotFoundError, ValueError) as exc:
            stderr = f"find: '{search_path.raw_path}': {exc}".encode()
            return b"", IOResult(stderr=stderr, exit_code=1)
    root_prefix = mount_prefix_of(search_path.virtual,
                                  search_path.resource_path)
    # `-path` matches the display path as printed; stamp the mount
    # prefix onto Path nodes before the backend walks mount-relative
    # keys (#396).
    args.tree = prefix_path_nodes(args_to_tree(args), root_prefix)
    # With a stat wired, the mtime window is applied by the overlay-
    # aware post-filter below, not pushed into the core: backend cores
    # only see native times and would drop files whose mtime lives in
    # the namespace (touch results, observed writes).
    push_mtime = stat is None
    results: list[str] = [] if root_is_link else await find_core(
        search_path,
        name=args.name,
        type=args.type,
        min_size=args.min_size,
        max_size=args.max_size,
        maxdepth=args.maxdepth,
        mindepth=args.mindepth,
        name_exclude=args.name_exclude,
        or_names=args.or_names,
        mtime_min=args.mtime_min if push_mtime else None,
        mtime_max=args.mtime_max if push_mtime else None,
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
                                           mount_prefix=root_prefix)
    results = apply_mount_prefix(results, root_prefix)
    root_path = (search_path.virtual.rstrip("/")
                 if search_path.virtual != "/" else "/")
    results = sorted(
        results +
        link_results(links, root_path, root_prefix,
                     search_path.mount_path.strip("/"), args, args.tree))
    results = respell_raw(results, search_path.virtual, search_path.raw_path)
    return format_records(results), IOResult()


def _modified_ts(modified: str | None) -> float | None:
    # Missing or unparseable timestamps exclude the entry from -mtime
    # matching, mirroring the TS implementation's NaN handling.
    return iso_timestamp(modified)


async def _stat_entry(
    stat: Callable[[PathSpec, IndexCacheStore | None], Awaitable[FileStat]],
    path: str,
    prefix: str,
    index: IndexCacheStore,
) -> FileStat | None:
    spec = PathSpec(virtual=path,
                    directory=path,
                    resolved=False,
                    resource_path=mount_key(path, prefix))
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
    index: IndexCacheStore,
) -> bool:
    if is_dir:
        spec = PathSpec(virtual=path,
                        directory=path,
                        resolved=False,
                        resource_path=mount_key(path, prefix))
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
    index: IndexCacheStore,
    maxdepth: int | None,
    depth: int,
    acc: list[tuple[str, str]],
) -> None:
    if maxdepth is not None and depth > maxdepth:
        return
    try:
        children = await readdir(spec, index)
    except FileNotFoundError:
        # Only vanished dirs are skipped; API errors (rate limit, auth)
        # propagate.
        return
    prefix = mount_prefix_of(spec.virtual, spec.resource_path)
    for child in children:
        hint = is_dir_name(child)
        trimmed = child.rstrip("/") if child.endswith("/") else child
        if hint is None:
            st = await _stat_entry(stat, trimmed, prefix, index)
            is_dir = st is not None and st.type == FileType.DIRECTORY
        else:
            is_dir = hint
        acc.append((trimmed, "d" if is_dir else "f"))
        if is_dir:
            child_spec = PathSpec(virtual=trimmed,
                                  directory=trimmed,
                                  resolved=False,
                                  resource_path=mount_key(trimmed, prefix))
            await _walk_collect(readdir, stat, is_dir_name, child_spec, index,
                                maxdepth, depth + 1, acc)


def link_results(
    links: LinkView | None,
    search_root: str,
    prefix: str,
    search_key: str,
    args: FindArgs,
    tree: PredNode,
) -> list[str]:
    """Namespace symlinks under the search root that match the expression.

    Symlinks live in the namespace, not in any backend, so neither a
    readdir walk nor a backend`s native find op can see them. Both find
    paths merge them through here so one implementation decides what a
    link matches.

    GNU find without -L reports the link itself and never walks through
    it, so a link is always kind ``l`` (never ``f``/``d``) and is never
    descended into. Its size is the target string`s length, which is
    what ``-size`` compares, and it carries the link`s own mtime.

    Args:
        links (LinkView | None): the namespace's symlink facts.
        search_root (str): absolute virtual path of the search root.
        prefix (str): mount prefix the backend keys are relative to.
        search_key (str): mount-relative key of the search root.
        args (FindArgs): parsed find expression.
        tree (PredNode): the prefix-stamped predicate tree.
    """
    if links is None:
        return []
    out: list[str] = []
    # GNU find's default is -P: a start point that is itself a symlink is
    # reported as the link and never walked through. The backend cannot
    # see it at all, so the subtree scan below (which only covers
    # entries *under* the root) would miss it.
    entries = list(links.subtree(search_root))
    own = links.stat_at(search_root)
    if own is not None:
        entries.append((search_root, own))
    for path, st in entries:
        key = path[len(prefix
                       ):] if prefix and path.startswith(prefix) else path
        rel = key.strip("/")
        if search_key:
            depth = 0 if rel == search_key else rel.count(
                "/") - search_key.count("/")
        else:
            depth = 0 if rel == "" else rel.count("/") + 1
        if args.maxdepth is not None and depth > args.maxdepth:
            continue
        entry = FindEntry(key=key,
                          name=path.rsplit("/", 1)[-1],
                          kind="l",
                          depth=depth,
                          is_empty=None)
        if not keep(entry, tree, args.mindepth):
            continue
        size = st.size or 0
        if args.min_size is not None and size < args.min_size:
            continue
        if args.max_size is not None and size > args.max_size:
            continue
        if args.mtime_min is not None or args.mtime_max is not None:
            ts = _modified_ts(st.modified)
            if ts is None:
                continue
            if args.mtime_min is not None and ts < args.mtime_min:
                continue
            if args.mtime_max is not None and ts > args.mtime_max:
                continue
        out.append(path)
    return out


async def walk_find(
    search_path: PathSpec,
    *,
    readdir: Callable[[PathSpec, IndexCacheStore | None],
                      Awaitable[list[str]]],
    stat: Callable[[PathSpec, IndexCacheStore | None], Awaitable[FileStat]],
    is_dir_name: Callable[[str], bool | None],
    index: IndexCacheStore,
    args: FindArgs,
    links: LinkView | None = None,
) -> list[str]:
    collected: list[tuple[str, str]] = []
    prefix = mount_prefix_of(search_path.virtual, search_path.resource_path)
    search_key = search_path.mount_path.strip("/")
    root_path = (search_path.virtual.rstrip("/")
                 if search_path.virtual != "/" else "/")
    root_stat = await _stat_entry(stat, root_path, prefix, index)
    if root_stat is not None:
        collected.append(
            (root_path, "d" if root_stat.type == FileType.DIRECTORY else "f"))
    # GNU depth convention: the search root is depth 0, its children are
    # depth 1.
    await _walk_collect(readdir, stat, is_dir_name, search_path, index,
                        args.maxdepth, 1, collected)
    tree = prefix_path_nodes(args_to_tree(args), prefix)
    need_empty = tree_has_empty(tree)
    results: list[str] = []
    for p, kind in sorted(collected):
        is_dir = kind == "d"
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
                          kind=kind,
                          depth=depth,
                          is_empty=is_empty)
        if not keep(entry, tree, args.mindepth):
            continue
        need_size = (args.min_size is not None or args.max_size is not None)
        need_mtime = args.mtime_min is not None or args.mtime_max is not None
        st = None
        if (need_size and not is_dir) or need_mtime:
            st = await _stat_entry(stat, p, prefix, index)
            if st is None:
                continue
        if need_size:
            # Directories count as size 0 for -size: GNU compares the inode
            # size (e.g. 4096 on ext4); see CLAUDE.md Rules.
            size = 0 if is_dir else ((st.size if st is not None else 0) or 0)
            if args.min_size is not None and size < args.min_size:
                continue
            if args.max_size is not None and size > args.max_size:
                continue
        if need_mtime and st is not None:
            ts = _modified_ts(st.modified)
            if ts is None:
                continue
            if args.mtime_min is not None and ts < args.mtime_min:
                continue
            if args.mtime_max is not None and ts > args.mtime_max:
                continue
        results.append(p)
    results.extend(
        link_results(links, root_path, prefix, search_key, args, tree))
    return sorted(results)

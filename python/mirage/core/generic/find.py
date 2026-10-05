from collections.abc import Awaitable, Callable
from typing import Protocol, TypeVar

from mirage.cache.context import active_cache_manager
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin import find_eval
from mirage.commands.builtin.find_eval import (
    FindEntry,
    PredNode,
    build_tree,
    keep,
    start_basename,
    tree_has_empty,
    tree_has_type,
)
from mirage.commands.builtin.find_printf import printf_kind
from mirage.commands.errors import is_entry_error
from mirage.context import path_allowed
from mirage.ops.types import LinkView
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.dates import iso_timestamp, matches_mtime
from mirage.utils.key_prefix import mount_key, mount_prefix_of
from mirage.utils.stat_view import DIR_SIZE, content_size


class ResolvedPath(Protocol):
    @property
    def is_dir(self) -> bool: ...


# The accessor stays a type variable rather than the `Accessor` base:
# callable parameters are contravariant, so a `ChromaAccessor` op does
# not fit an `Accessor` slot. Mirrors the TS factory's `<A>`.
A = TypeVar("A")

ResolvePathFn = Callable[
    [A, PathSpec, IndexCacheStore], Awaitable[ResolvedPath]
]

StatFn = Callable[[A, PathSpec, IndexCacheStore], Awaitable[FileStat]]

WalkFn = Callable[..., Awaitable[list[str]]]

FindFn = Callable[..., Awaitable[list[str]]]


def relative_depth(item: str, root: str) -> int:
    """Depth of ``item`` below ``root``, counting the root itself as 0.

    Args:
        item (str): the walked key.
        root (str): the search root's mount path.
    """
    root_norm = root.rstrip("/") or "/"
    item_norm = item.rstrip("/") or "/"
    if item_norm == root_norm:
        return 0
    if root_norm == "/":
        relative = item_norm.strip("/")
    else:
        relative = item_norm.removeprefix(root_norm).lstrip("/")
    if not relative:
        return 0
    return relative.count("/") + 1


async def _matches(
    resolve_path: ResolvePathFn[A],
    stat: StatFn[A],
    accessor: A,
    item: str,
    prefix: str,
    index: IndexCacheStore,
    root: str,
    tree: PredNode,
    needs_kind: bool,
    min_size: int | None,
    max_size: int | None,
    mtime_min: float | None,
    mtime_max: float | None,
    mindepth: int | None,
    start_name: str,
    all_items: list[str],
) -> bool:
    """Whether one walked key survives the predicate tree and filters.

    Args:
        resolve_path (ResolvePathFn[A]): the backend's directory test.
        stat (StatFn[A]): the backend's stat.
        accessor (A): the backend handle.
        item (str): the walked key.
        prefix (str): the mount prefix the key belongs to.
        index (IndexCacheStore): the index the walk ran against.
        root (str): the search root's mount path.
        tree (PredNode): the parsed predicate tree.
        needs_kind (bool): whether any predicate needs the entry kind.
        min_size (int | None): inclusive lower size bound.
        max_size (int | None): inclusive upper size bound.
        mtime_min (float | None): inclusive lower mtime bound.
        mtime_max (float | None): inclusive upper mtime bound.
        mindepth (int | None): least depth to report.
        start_name (str): the name the root reports as.
        all_items (list[str]): every walked key, for the ``-empty`` test.
    """
    root_norm = root.rstrip("/") or "/"
    item_norm = item.rstrip("/") or "/"
    item_name = (
        start_name
        if item_norm == root_norm
        else item.rstrip("/").rsplit("/", 1)[-1]
    )
    # The walk strips its mount prefix; backend probes still need both paths.
    virtual = (prefix.rstrip("/") + "/" + item.lstrip("/")).rstrip("/") or "/"
    spec = PathSpec.from_str_path(virtual, item.lstrip("/"))
    kind = "f"
    if needs_kind:
        resolved = await resolve_path(accessor, spec, index)
        kind = "d" if resolved.is_dir else "f"
    item_stat = None
    need_stat = (
        ((min_size is not None or max_size is not None) and kind != "d")
        or mtime_min is not None
        or mtime_max is not None
    )
    if need_stat:
        item_stat = await stat(accessor, spec, index)
    is_empty = None
    if tree_has_empty(tree):
        if kind == "d":
            child_prefix = item.rstrip("/") + "/"
            is_empty = not any(
                other != item and other.startswith(child_prefix)
                for other in all_items
            )
        else:
            if item_stat is None:
                item_stat = await stat(accessor, spec, index)
            is_empty = item_stat.type is FileType.FILE and item_stat.size == 0
    entry = FindEntry(
        key=item,
        name=item_name,
        kind=kind,
        depth=relative_depth(item, root),
        is_empty=is_empty,
    )
    if not keep(entry, tree, mindepth):
        return False
    if min_size is not None or max_size is not None:
        if kind == "d":
            size = DIR_SIZE
        else:
            if item_stat is None:
                item_stat = await stat(accessor, spec, index)
            # Sizeless rendered files count as size 0, as the FUSE view
            # reports them before a first open; never drop them.
            size = item_stat.size if item_stat.size is not None else 0
        if min_size is not None and size < min_size:
            return False
        if max_size is not None and size > max_size:
            return False
    if not matches_mtime(
        item_stat.modified if item_stat is not None else None,
        mtime_min,
        mtime_max,
    ):
        return False
    return True


def make_search_backed_find(
    resolve_path: ResolvePathFn[A], stat: StatFn[A], walk: WalkFn
) -> FindFn:
    """Build ``find`` for a backend whose walk comes from a search index.

    The search-backed backends (chroma, dify) get the whole subtree from
    one ``walk`` call and then filter it, where the API backends drive
    the traversal themselves through ``walk_find``'s ``readdir``. That is
    the only difference between them, so everything after the walk lives
    here once rather than once per backend.

    Args:
        resolve_path (ResolvePathFn[A]): the backend's directory test.
        stat (StatFn[A]): the backend's stat.
        walk (WalkFn): the backend's subtree walk.
    """

    async def find(
        accessor: A,
        path: PathSpec,
        name: str | None = None,
        type: str | None = None,
        min_size: int | None = None,
        max_size: int | None = None,
        maxdepth: int | None = None,
        name_exclude: str | None = None,
        or_names: list[str] | None = None,
        mtime_min: float | None = None,
        mtime_max: float | None = None,
        iname: str | None = None,
        path_pattern: str | None = None,
        mindepth: int | None = None,
        empty: bool = False,
        tree: PredNode | None = None,
        *,
        index: IndexCacheStore = NULL_INDEX,
    ) -> list[str]:
        results = await walk(
            accessor,
            path,
            index,
            include_root=True,
            maxdepth=maxdepth,
            strip_prefix=True,
        )
        node = (
            tree
            if tree is not None
            else build_tree(
                name=name,
                iname=iname,
                path_pattern=path_pattern,
                type=type,
                name_exclude=name_exclude,
                or_names=or_names,
                empty=empty,
            )
        )
        needs_kind = (
            tree_has_type(node)
            or min_size is not None
            or max_size is not None
            or tree_has_empty(node)
        )
        start_name = start_basename(path)
        prefix = mount_prefix_of(path.virtual, path.vfs_path)
        filtered: list[str] = []
        for item in results:
            if await _matches(
                resolve_path,
                stat,
                accessor,
                item,
                prefix,
                index,
                path.mount_path,
                node,
                needs_kind,
                min_size,
                max_size,
                mtime_min,
                mtime_max,
                mindepth,
                start_name,
                results,
            ):
                filtered.append(item)
        return sorted(filtered)

    return find


def modified_ts(modified: str | None) -> float | None:
    # Missing or unparseable timestamps exclude the entry from -mtime
    # matching, mirroring the TS implementation's NaN handling.
    return iso_timestamp(modified)


async def _stat_entry(
    stat: Callable[[PathSpec, IndexCacheStore | None], Awaitable[FileStat]],
    path: str,
    prefix: str,
    index: IndexCacheStore | None,
    unstatted: dict[str, Exception] | None = None,
) -> FileStat | None:
    if unstatted is not None and path in unstatted:
        return None
    spec = PathSpec(
        virtual=path,
        directory=path,
        resolved=False,
        vfs_path=mount_key(path, prefix),
    )
    try:
        row = await stat(spec, index)
        manager = active_cache_manager()
        if row.size is None and manager is not None:
            size = await manager.cached_size(spec)
            if size is not None:
                row = row.model_copy(update={"size": size})
        return row
    except (FileNotFoundError, NotADirectoryError):
        return None
    except Exception as exc:
        # Any other failure resolves to None too when the caller collects
        # it; otherwise it (a rate limit, an auth failure) propagates.
        if unstatted is None or not is_entry_error(exc):
            raise
        unstatted[path] = exc
        return None


async def _is_empty_entry(
    readdir: Callable[
        [PathSpec, IndexCacheStore | None], Awaitable[list[str]]
    ],
    stat: Callable[[PathSpec, IndexCacheStore | None], Awaitable[FileStat]],
    path: str,
    is_dir: bool,
    prefix: str,
    index: IndexCacheStore | None,
    links: LinkView | None = None,
    unstatted: dict[str, Exception] | None = None,
    unreadable: list[str] | None = None,
) -> bool:
    if is_dir:
        if find_eval.has_link_children(links, path):
            return False
        spec = PathSpec(
            virtual=path,
            directory=path,
            resolved=False,
            vfs_path=mount_key(path, prefix),
        )
        try:
            return len(await readdir(spec, index)) == 0
        except (FileNotFoundError, NotADirectoryError):
            return False
        except PermissionError:
            if unreadable is None:
                raise
            if path not in unreadable:
                unreadable.append(path)
            return False
    st = await _stat_entry(stat, path, prefix, index, unstatted)
    return st is not None and st.type is FileType.FILE and st.size == 0


async def _walk_collect(
    readdir: Callable[
        [PathSpec, IndexCacheStore | None], Awaitable[list[str]]
    ],
    stat: Callable[[PathSpec, IndexCacheStore | None], Awaitable[FileStat]],
    spec: PathSpec,
    index: IndexCacheStore | None,
    maxdepth: int | None,
    depth: int,
    acc: list[tuple[str, str]],
    unreadable: list[str] | None = None,
    unstatted: dict[str, Exception] | None = None,
) -> None:
    if maxdepth is not None and depth > maxdepth:
        return
    try:
        children = await readdir(spec, index)
    except (FileNotFoundError, NotADirectoryError):
        # Only vanished dirs are skipped; API errors (rate limit, auth)
        # propagate.
        return
    except PermissionError:
        # A directory the session may not open (a rule refused it at
        # the guarded readdir): GNU names it and walks on, so a caller
        # that collects those gets the path and the walk continues; one
        # that does not is not left with a silent gap in its listing.
        if unreadable is None:
            raise
        unreadable.append(spec.virtual)
        return
    prefix = mount_prefix_of(spec.virtual, spec.vfs_path)
    for child in children:
        # Classification is stat's job (an index lookup right after the
        # readdir that populated it). The one in-band proof is a trailing
        # slash on a cold listing: no backend renders a file with one.
        # Name heuristics beyond that guessed wrong (attachments and
        # uploads carry whatever name the sender gave them) and are gone.
        if child.endswith("/"):
            trimmed = child.rstrip("/")
            is_dir = True
            kind = "d"
        else:
            trimmed = child
            st = await _stat_entry(stat, trimmed, prefix, index, unstatted)
            is_dir = st is not None and st.type == FileType.DIRECTORY
            kind = printf_kind(st)
        acc.append((trimmed, kind))
        if is_dir:
            child_spec = PathSpec(
                virtual=trimmed,
                directory=trimmed,
                resolved=False,
                vfs_path=mount_key(trimmed, prefix),
            )
            await _walk_collect(
                readdir,
                stat,
                child_spec,
                index,
                maxdepth,
                depth + 1,
                acc,
                unreadable,
                unstatted,
            )


async def link_results(
    links: LinkView | None,
    search_root: str,
    prefix: str,
    search_key: str,
    args: find_eval.FindArgs,
    tree: find_eval.PredNode,
    follow: bool = False,
) -> list[str]:
    """Namespace symlinks under the search root that match the expression.

    Symlinks live in the namespace, not in any backend, so neither a
    readdir walk nor a backend`s native find op can see them. Both find
    paths merge them through here so one implementation decides what a
    link matches.

    GNU find without -L reports the link itself and never walks through
    it, so a link is kind ``l`` (never ``f``/``d``). Its size is the
    target string`s length, which is what ``-size`` compares, and it
    carries the link`s own mtime.

    Under ``-L`` a link is classified by what it points at instead: a
    link to a file tests as ``f``, a link to a directory as ``d``, and
    only a dangling link stays ``l`` (GNU reports the link itself when
    the target cannot be stat'd). ``-size`` and ``-mtime`` then compare
    the target's stat, since that is the file being reported.

    Args:
        links (LinkView | None): the namespace's symlink facts.
        search_root (str): absolute virtual path of the search root.
        prefix (str): mount prefix the backend keys are relative to.
        search_key (str): mount-relative key of the search root.
        args (FindArgs): parsed find expression.
        tree (PredNode): the prefix-stamped predicate tree.
        follow (bool): whether -L asked for the target's identity.
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
        kind = "l"
        if follow:
            target = await links.target_stat(path)
            if target is not None:
                kind = printf_kind(target)
                st = target
        key = (
            path[len(prefix) :] if prefix and path.startswith(prefix) else path
        )
        rel = key.strip("/")
        if search_key:
            depth = (
                0
                if rel == search_key
                else rel.count("/") - search_key.count("/")
            )
        else:
            depth = 0 if rel == "" else rel.count("/") + 1
        if args.maxdepth is not None and depth > args.maxdepth:
            continue
        entry = find_eval.FindEntry(
            key=key,
            name=path.rsplit("/", 1)[-1],
            kind=kind,
            depth=depth,
            is_empty=None,
            mtime=modified_ts(st.modified),
        )
        if not find_eval.keep(entry, tree, args.mindepth):
            continue
        size = content_size(st)
        if args.min_size is not None and size < args.min_size:
            continue
        if args.max_size is not None and size > args.max_size:
            continue
        if args.mtime_min is not None or args.mtime_max is not None:
            ts = modified_ts(st.modified)
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
    readdir: Callable[
        [PathSpec, IndexCacheStore | None], Awaitable[list[str]]
    ],
    stat: Callable[[PathSpec, IndexCacheStore | None], Awaitable[FileStat]],
    index: IndexCacheStore | None,
    args: find_eval.FindArgs,
    links: LinkView | None = None,
    follow: bool = False,
    unreadable: list[str] | None = None,
    unstatted: dict[str, Exception] | None = None,
) -> list[str]:
    """Walk readdir/stat under one start point and match every entry.

    A directory the guarded readdir refuses lands in ``unreadable``. An
    entry whose stat fails lands in ``unstatted`` with its error, in
    walk order: GNU's find names it and carries on, and the entry stays
    in the walk unclassified, a leaf, as a missing one already does,
    that fails every test only its stat could answer. It is never
    statted again. A caller that passes neither gets the failure
    propagated instead.

    Args:
        search_path (PathSpec): the start point.
        readdir (Callable): bound readdir, ``readdir(p, index)``.
        stat (Callable): bound stat, ``stat(p, index)``.
        index (IndexCacheStore | None): listing cache.
        args (find_eval.FindArgs): parsed find expression.
        links (LinkView | None): the namespace's symlink facts.
        follow (bool): ``-L``.
        unreadable (list[str] | None): collects refused directories.
        unstatted (dict[str, Exception] | None): collects entries whose
            stat failed.
    """
    collected: list[tuple[str, str]] = []
    prefix = mount_prefix_of(search_path.virtual, search_path.vfs_path)
    search_key = search_path.mount_path.strip("/")
    root_path = (
        search_path.virtual.rstrip("/") if search_path.virtual != "/" else "/"
    )
    prune_tree = find_eval.bind_tree(
        find_eval.args_to_tree(args),
        prefix,
        search_path.virtual,
        search_path.raw_path,
    )

    async def read_directory(
        spec: PathSpec, cache: IndexCacheStore | None
    ) -> list[str]:
        if find_eval.tree_has_prune(prune_tree):
            key = spec.mount_path.rstrip("/") or "/"
            depth = len(spec.virtual.rstrip("/").split("/")) - len(
                root_path.rstrip("/").split("/")
            )
            info = await _stat_entry(
                stat, spec.virtual, prefix, cache, unstatted
            )
            empty = (
                await _is_empty_entry(
                    readdir,
                    stat,
                    spec.virtual,
                    True,
                    prefix,
                    cache,
                    links,
                    unstatted,
                    unreadable,
                )
                if find_eval.tree_has_empty(prune_tree)
                else None
            )
            find_eval.keep(
                find_eval.FindEntry(
                    key=key,
                    name=spec.virtual.rstrip("/").rsplit("/", 1)[-1],
                    kind="d",
                    depth=depth,
                    is_empty=empty,
                    mtime=modified_ts(info.modified) if info else None,
                ),
                prune_tree,
                args.mindepth,
            )
            if key in find_eval.pruned_keys(prune_tree):
                return []
        return await readdir(spec, cache)

    root_stat = await _stat_entry(stat, root_path, prefix, index)
    if root_stat is not None:
        collected.append((root_path, printf_kind(root_stat)))
    # GNU depth convention: the search root is depth 0, its children are
    # depth 1. A start point that is not a directory has no children, so
    # readdir on it is either an error the walk would have to swallow
    # (Box answers ENOTDIR) or a wasted round trip everywhere else.
    if root_stat is None or root_stat.type == FileType.DIRECTORY:
        await _walk_collect(
            read_directory,
            stat,
            search_path,
            index,
            args.maxdepth,
            1,
            collected,
            unreadable,
            unstatted,
        )
    tree = find_eval.bind_tree(
        find_eval.args_to_tree(args),
        prefix,
        search_path.virtual,
        search_path.raw_path,
    )
    need_empty = find_eval.tree_has_empty(tree)
    need_size = args.min_size is not None or args.max_size is not None
    need_mtime = args.mtime_min is not None or args.mtime_max is not None
    learned: dict[str, float | None] = {}
    results: list[str] = []
    for p, kind in sorted(collected):
        if not path_allowed(p):
            continue
        is_dir = kind == "d"
        entry_name = p.rsplit("/", 1)[-1]
        key = p[len(prefix) :] if prefix and p.startswith(prefix) else p
        rel = key.strip("/")
        if search_key:
            depth = (
                0
                if rel == search_key
                else rel.count("/") - search_key.count("/")
            )
        else:
            depth = 0 if rel == "" else rel.count("/") + 1
        is_empty = None
        if need_empty:
            is_empty = await _is_empty_entry(
                readdir,
                stat,
                p,
                is_dir,
                prefix,
                index,
                links,
                unstatted,
                unreadable,
            )
        # With a time test in the tree the stat comes first, so the entry
        # answers the test itself and a -prune after it fires only where
        # GNU's would; the stat that -size alone needs waits for the rows
        # the tree kept.
        st = None
        if need_mtime:
            st = await _stat_entry(stat, p, prefix, index, unstatted)
            if st is None:
                continue
            learned[key] = modified_ts(st.modified)
        entry = find_eval.FindEntry(
            key=key,
            name=entry_name,
            kind=kind,
            depth=depth,
            is_empty=is_empty,
            mtime=learned.get(key),
        )
        if not find_eval.keep(entry, tree, args.mindepth):
            continue
        if need_size and not is_dir and st is None:
            st = await _stat_entry(stat, p, prefix, index, unstatted)
            if st is None:
                continue
        if need_size:
            size = DIR_SIZE
            if not is_dir:
                size = (st.size if st is not None else 0) or 0
            if args.min_size is not None and size < args.min_size:
                continue
            if args.max_size is not None and size > args.max_size:
                continue
        if need_mtime and st is not None:
            ts = modified_ts(st.modified)
            if ts is None:
                continue
            if args.mtime_min is not None and ts < args.mtime_min:
                continue
            if args.mtime_max is not None and ts > args.mtime_max:
                continue
        results.append(p)
    results.extend(
        r
        for r in await link_results(
            links, root_path, prefix, search_key, args, tree, follow=follow
        )
        if path_allowed(r)
    )
    find_eval.settle_prunes(tree, learned)
    return sorted(find_eval.drop_pruned(results, tree, prefix))

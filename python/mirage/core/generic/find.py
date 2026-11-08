from collections.abc import Awaitable, Callable
from dataclasses import replace
from functools import partial

from mirage.cache.context import active_cache_manager
from mirage.context import session_visibility
from mirage.core.generic import find_eval
from mirage.core.generic import types as find_types
from mirage.core.generic.find_eval import (
    printf_kind,
)
from mirage.errors.classify import is_entry_error
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.dates import iso_timestamp
from mirage.utils.hidden import path_visible
from mirage.utils.stat_view import DIR_SIZE
from mirage.view.namespace_view import followed_stat
from mirage.view.types import LinkView


def modified_ts(modified: str | None) -> float | None:
    # Missing or unparseable timestamps exclude the entry from -mtime
    # matching, mirroring the TS implementation's NaN handling.
    return iso_timestamp(modified)


async def _stat_entry(
    stat: Callable[[PathSpec], Awaitable[FileStat]],
    path: str,
    unstatted: dict[str, Exception] | None = None,
) -> FileStat | None:
    if unstatted is not None and path in unstatted:
        return None
    spec = PathSpec(
        virtual=path,
        directory=path,
        resolved=False,
        vfs_path=path.strip("/"),
    )
    try:
        row = await stat(spec)
        manager = active_cache_manager()
        if (
            row.type is FileType.FILE
            and row.size is None
            and manager is not None
        ):
            [size] = await manager.cached_sizes([spec])
            if size is not None:
                row = replace(row, size=size)
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
    readdir: Callable[[PathSpec], Awaitable[list[str]]],
    stat: Callable[[PathSpec], Awaitable[FileStat]],
    path: str,
    is_dir: bool,
    unstatted: dict[str, Exception] | None = None,
    unreadable: list[str] | None = None,
) -> bool:
    if is_dir:
        spec = PathSpec(
            virtual=path,
            directory=path,
            resolved=False,
            vfs_path=path.strip("/"),
        )
        try:
            return len(await readdir(spec)) == 0
        except (FileNotFoundError, NotADirectoryError):
            return False
        except PermissionError:
            if unreadable is None:
                raise
            if path not in unreadable:
                unreadable.append(path)
            return False
    st = await _stat_entry(stat, path, unstatted)
    return st is not None and st.type is FileType.FILE and st.size == 0


async def _walk_collect(
    readdir: Callable[[PathSpec], Awaitable[list[str]]],
    stat: Callable[[PathSpec], Awaitable[FileStat]],
    spec: PathSpec,
    maxdepth: int | None,
    depth: int,
    acc: list[tuple[str, str]],
    unreadable: list[str] | None = None,
    unstatted: dict[str, Exception] | None = None,
    real: Callable[[str], str] | None = None,
    chain: tuple[tuple[str, str], ...] = (),
    loops: list[tuple[str, str]] | None = None,
) -> None:
    if maxdepth is not None and depth > maxdepth:
        return
    try:
        children = await readdir(spec)
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
            st = await _stat_entry(stat, trimmed, unstatted)
            is_dir = st is not None and st.type == FileType.DIRECTORY
            kind = printf_kind(st)
        below = chain
        if is_dir and real is not None:
            # Under -L a directory is the one it resolves to, and one
            # already open above is GNU's file system loop: never a row,
            # never entered.
            here = real(trimmed)
            ancestor = next((v for v, r in chain if r == here), None)
            if ancestor is not None:
                if loops is not None:
                    loops.append((trimmed, ancestor))
                continue
            below = (*chain, (trimmed, here))
        acc.append((trimmed, kind))
        if not is_dir:
            continue
        child_spec = PathSpec(
            virtual=trimmed,
            directory=trimmed,
            resolved=False,
            vfs_path=trimmed.strip("/"),
        )
        await _walk_collect(
            readdir,
            stat,
            child_spec,
            maxdepth,
            depth + 1,
            acc,
            unreadable,
            unstatted,
            real,
            below,
            loops,
        )


async def walk_find(
    search_path: PathSpec,
    *,
    readdir: Callable[[PathSpec], Awaitable[list[str]]],
    stat: Callable[[PathSpec], Awaitable[FileStat]],
    args: find_types.FindArgs,
    follow: LinkView | None = None,
    unreadable: list[str] | None = None,
    unstatted: dict[str, Exception] | None = None,
    root: FileStat | None = None,
    loops: list[tuple[str, str]] | None = None,
    enters: Callable[[str], bool] | None = None,
    listing: Callable[[PathSpec], Awaitable[list[str]]] | None = None,
    links: LinkView | None = None,
    stopped: list[str] | None = None,
) -> list[str]:
    """Walk readdir/stat under one start point and match every entry.

    A directory the guarded readdir refuses lands in ``unreadable``. An
    entry whose stat fails lands in ``unstatted`` with its error, in
    walk order: GNU's find names it and carries on, and the entry stays
    in the walk unclassified, a leaf, as a missing one already does,
    that fails every test only its stat could answer. It is never
    statted again. A caller that passes neither gets the failure
    propagated instead.

    The table's stat and readdir see the namespace's links, so a link is
    an entry like any other, kind ``l``. Under ``-L`` an entry is what it
    leads to instead: a link to a directory is walked, a dangling one
    stays ``l`` (GNU reports the link when its target cannot be statted),
    one whose chain loops is an error, and a directory reached again
    lands in ``loops`` with the one above it, neither a row nor entered.

    Args:
        search_path (PathSpec): the start point.
        readdir (Callable): bound readdir, ``readdir(p)``.
        stat (Callable): bound stat, ``stat(p)``.
        args (find_types.FindArgs): parsed find expression.
        follow (LinkView | None): the namespace's links, where ``-L``
            follows them.
        unreadable (list[str] | None): collects refused directories.
        unstatted (dict[str, Exception] | None): collects entries whose
            stat failed.
        root (FileStat | None): the start point's stat when the caller
            has it, which is how a directory only a mount below it
            makes still reports itself; None stats it.
        loops (list[tuple[str, str]] | None): collects, under ``-L``, each
            directory reached again and the one above it it repeats.
        enters (Callable[[str], bool] | None): ``-xdev``'s test of a
            directory's virtual path: one it fails is an entry still, and
            ``-empty`` still reads it, but the walk does not descend.
        listing (Callable | None): the walk's own listing of a directory,
            where the caller bounds it; None lists with ``readdir``.
        links (LinkView | None): the namespace's links whether or not the
            walk follows them, which ``-xtype`` reads past.
        stopped (list[str] | None): receives the entry a ``-quit`` was
            reached on; the walk evaluates nothing after it.
    """
    stat = partial(followed_stat, stat, follow)
    collected: list[tuple[str, str]] = []
    search_key = search_path.virtual.strip("/")
    root_path = (
        search_path.virtual.rstrip("/") if search_path.virtual != "/" else "/"
    )
    prune_tree = find_eval.bind_tree(
        find_eval.args_to_tree(args),
        "",
        search_path.virtual,
        search_path.raw_path,
    )
    prunes = find_eval.tree_has_prune(prune_tree)
    quits = find_eval.tree_has(prune_tree, (find_types.Quit,))
    need_empty = find_eval.tree_has_empty(prune_tree)
    acts = find_eval.tree_has_action(prune_tree)
    reads_stat = find_eval.tree_reads_stat(prune_tree)
    reads_link = find_eval.tree_reads_link(prune_tree)
    need_size = args.min_size is not None or args.max_size is not None
    # Under -depth a directory is judged after what it holds, so its
    # -quit cannot be met on the way in.
    early_quit = quits and not args.depth_first

    async def read_directory(spec: PathSpec) -> list[str]:
        if enters is not None and not enters(spec.virtual):
            return []
        if quits and find_eval.quit_fired(prune_tree):
            return []
        if prunes or early_quit:
            key = spec.virtual.rstrip("/") or "/"
            depth = len(spec.virtual.rstrip("/").split("/")) - len(
                root_path.rstrip("/").split("/")
            )
            info = await _stat_entry(stat, spec.virtual, unstatted)
            empty = (
                await _is_empty_entry(
                    readdir,
                    stat,
                    spec.virtual,
                    True,
                    unstatted,
                    unreadable,
                )
                if need_empty
                else None
            )
            await find_eval.prime_regexes(prune_tree, [key])
            xkind, target = (
                await _other_side(follow, links, key, "d")
                if reads_link
                else (None, None)
            )
            # -size is no node of the tree, so a directory outside its
            # window is not judged where a -quit could stop the walk.
            if not (early_quit and need_size and not _sized(args, DIR_SIZE)):
                find_eval.keep(
                    find_types.FindEntry(
                        key=key,
                        name=spec.virtual.rstrip("/").rsplit("/", 1)[-1],
                        kind="d",
                        depth=depth,
                        is_empty=empty,
                        mtime=modified_ts(info.modified) if info else None,
                        stat=info if reads_stat else None,
                        xkind=xkind,
                        target=target,
                    ),
                    prune_tree,
                    args.mindepth,
                    acts,
                )
            # A directory that reached -quit is the walk's last: what it
            # holds is never read.
            if key in find_eval.pruned_keys(prune_tree) or (
                early_quit and find_eval.quit_fired(prune_tree)
            ):
                return []
        return await (listing or readdir)(spec)

    root_stat = (
        root if root is not None else await _stat_entry(stat, root_path)
    )
    if root_stat is not None:
        collected.append((root_path, printf_kind(root_stat)))
    # GNU depth convention: the search root is depth 0, its children are
    # depth 1. A start point that is not a directory has no children, so
    # readdir on it is either an error the walk would have to swallow
    # (Box answers ENOTDIR) or a wasted round trip everywhere else.
    if root_stat is None or root_stat.type == FileType.DIRECTORY:
        real = follow.resolve if follow is not None else None
        await _walk_collect(
            read_directory,
            stat,
            search_path,
            args.maxdepth,
            1,
            collected,
            unreadable,
            unstatted,
            real,
            ((root_path, real(root_path)),) if real is not None else (),
            loops,
        )
    tree = find_eval.bind_tree(
        find_eval.args_to_tree(args),
        "",
        search_path.virtual,
        search_path.raw_path,
    )
    windowed = args.mtime_min is not None or args.mtime_max is not None
    need_mtime = windowed or find_eval.tree_has_time(tree)
    need_stat = need_mtime or reads_stat
    need_link = find_eval.tree_reads_link(tree)
    failing = find_eval.time_tests_failing(tree)
    learned: dict[str, float | None] = {}
    statted: dict[str, FileStat | None] = {}
    results: list[str] = []
    vis = session_visibility()
    if args.depth_first:
        collected.sort(key=lambda row: depth_first_key(row[0]))
    else:
        collected.sort()
    await find_eval.prime_regexes(tree, (p for p, _ in collected))
    for p, kind in collected:
        if not path_visible(vis, p):
            continue
        is_dir = kind == "d"
        entry_name = p.rsplit("/", 1)[-1]
        key = p
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
                unstatted,
                unreadable,
            )
        # With a time test in the tree the stat comes first, so the entry
        # answers the test itself and a -prune after it fires only where
        # GNU's would; the stat that -size alone needs waits for the rows
        # the tree kept.
        st = None
        if need_stat:
            st = await _stat_entry(stat, p, unstatted)
            if st is None and windowed:
                continue
            # A failed stat leaves the time unknown, which fails every time
            # test, so another -o arm (-name) can still match the entry.
            learned[key] = modified_ts(st.modified) if st is not None else None
            statted[key] = st
        # -size is no node of the tree, so where a -quit could end the
        # walk an entry outside its window is never judged.
        if quits and need_size:
            if st is None:
                st = await _stat_entry(stat, p, unstatted)
            if st is None or not _sized(
                args, DIR_SIZE if is_dir else st.size or 0
            ):
                continue
        xkind, target = (
            await _other_side(follow, links, p, kind)
            if need_link
            else (None, None)
        )
        entry = find_types.FindEntry(
            key=key,
            name=entry_name,
            kind=kind,
            depth=depth,
            is_empty=is_empty,
            mtime=learned.get(key),
            stat=st,
            xkind=xkind,
            target=target,
        )
        judged = failing if need_mtime and entry.mtime is None else tree
        kept = find_eval.keep(entry, judged, args.mindepth, acts)
        if find_eval.quit_fired(judged):
            if kept:
                results.append(p)
            if stopped is not None:
                stopped.append(p)
            break
        if not kept:
            continue
        if need_size and not is_dir and st is None:
            st = await _stat_entry(stat, p, unstatted)
            if st is None:
                continue
        if need_size and not _sized(
            args, DIR_SIZE if is_dir or st is None else st.size or 0
        ):
            continue
        if windowed and st is not None:
            ts = modified_ts(st.modified)
            if ts is None:
                continue
            if args.mtime_min is not None and ts < args.mtime_min:
                continue
            if args.mtime_max is not None and ts > args.mtime_max:
                continue
        results.append(p)
    find_eval.settle_prunes(tree, learned, statted)
    return sorted(find_eval.drop_pruned(results, tree, ""))


def depth_first_key(path: str) -> tuple[tuple[str, int], ...]:
    """The sort key for GNU's ``-depth`` order over sorted siblings.

    A directory's contents, each sorted, then the directory: the final
    component is flagged so a path sorts after its descendants, whose
    entry at that depth carries the same name unflagged. A start point
    spelled with a trailing slash prints as ``d/`` while its descendants
    print as ``d/a``, so the slash is dropped before splitting: kept, it
    would leave an empty final component that sorts the directory ahead
    of everything under it, which is the one order ``-delete`` cannot
    remove a tree in.

    Args:
        path (str): a row as find printed it.
    """
    parts = path.rstrip("/").split("/")
    return (*((part, 0) for part in parts[:-1]), (parts[-1], 1))


def _sized(args: find_types.FindArgs, size: int) -> bool:
    """Whether a size falls inside ``-size``'s window.

    Args:
        args (FindArgs): the window's bounds.
        size (int): the entry's size.
    """
    return not (
        (args.min_size is not None and size < args.min_size)
        or (args.max_size is not None and size > args.max_size)
    )


async def _other_side(
    follow: LinkView | None,
    links: LinkView | None,
    path: str,
    kind: str,
) -> tuple[str, FileStat | None]:
    """``-xtype``'s kind for one entry and the stat of what a live link
    the walk keeps leads to: such a link is what it leads to (``l`` when
    it leads nowhere), a link the walk followed is ``l``, and anything
    else is its own kind.

    Args:
        follow (LinkView | None): the links the walk follows, under -L.
        links (LinkView | None): the namespace's links.
        path (str): the entry's virtual path.
        kind (str): the kind the walk gave it.
    """
    view = follow or links
    if view is None:
        return kind, None
    if follow is not None:
        return ("l" if view.stat_at(path) is not None else kind), None
    if kind != "l":
        return kind, None
    try:
        target = await view.target_stat(path)
    except OSError:
        return "l", None
    if target is None:
        return "l", None
    return printf_kind(target), target

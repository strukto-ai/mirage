import logging
from collections.abc import AsyncGenerator, Awaitable, Callable, Iterator
from dataclasses import replace
from functools import partial
from typing import Any

from mirage.cache.context import active_cache_manager
from mirage.context import session_visibility
from mirage.core.generic import find_eval
from mirage.core.generic import types as find_types
from mirage.core.generic.find_eval import (
    printf_kind,
)
from mirage.errors.classify import is_entry_error
from mirage.types import FileStat, FileType, PathSpec, ReaddirFn
from mirage.utils.dates import in_mtime_window, iso_timestamp
from mirage.utils.hidden import path_visible
from mirage.utils.stat_view import DIR_SIZE
from mirage.view.namespace_view import followed_stat
from mirage.view.types import LinkView

logger = logging.getLogger(__name__)


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
    readdir: ReaddirFn,
    stat: Callable[[PathSpec], Awaitable[FileStat]],
    path: str,
    is_dir: bool,
    unstatted: dict[str, Exception] | None = None,
    unreadable: list[str] | None = None,
    known: FileStat | None = None,
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
    st = known or await _stat_entry(stat, path, unstatted)
    return st is not None and st.type is FileType.FILE and st.size == 0


async def walk_find(
    search_path: PathSpec,
    *,
    readdir: ReaddirFn,
    stat: Callable[[PathSpec], Awaitable[FileStat]],
    args: find_types.FindArgs,
    follow: LinkView | None = None,
    unreadable: list[str] | None = None,
    unstatted: dict[str, Exception] | None = None,
    root: FileStat | None = None,
    loops: list[tuple[str, str]] | None = None,
    enters: Callable[[str], bool] | None = None,
    listing: Callable[[ReaddirFn, PathSpec], Awaitable[list[str]]]
    | None = None,
    links: LinkView | None = None,
    stopped: list[str] | None = None,
) -> AsyncGenerator[str, None]:
    """Walk readdir/stat under one start point, yielding each entry the
    expression keeps as the walk reaches it.

    A directory's entries are visited in name order, where findutils
    takes them in the order the directory lists them, so the rows come in
    a tree walk's order: a directory, then what it holds, or under
    ``-depth`` what it holds, then the directory. Each entry is judged
    once, when it is reached: a ``-prune`` keeps the walk out of the
    directory it holds for, a ``-quit`` ends the walk, and a reader that
    stops reading stops the walk with it.

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
        listing (Callable | None): the walk's own listing of a directory
            through the readdir it is handed, where the caller bounds it;
            None lists with ``readdir``.
        links (LinkView | None): the namespace's links whether or not the
            walk follows them, which ``-xtype`` reads past.
        stopped (list[str] | None): receives the entry a ``-quit`` was
            reached on; the walk evaluates nothing after it.
    """
    stat = partial(followed_stat, stat, follow)
    root_path = (
        search_path.virtual.rstrip("/") if search_path.virtual != "/" else "/"
    )
    tree = find_eval.bind_tree(
        find_eval.args_to_tree(args),
        "",
        search_path.virtual,
        search_path.raw_path,
    )
    quits = find_eval.tree_has(tree, (find_types.Quit,))
    regexes = find_eval.tree_has(tree, (find_types.Regex,))
    need_empty = find_eval.tree_has_empty(tree)
    acts = find_eval.tree_has_action(tree)
    need_size = args.min_size is not None or args.max_size is not None
    windowed = args.mtime_min is not None or args.mtime_max is not None
    need_mtime = windowed or find_eval.tree_has_time(tree)
    need_stat = need_mtime or find_eval.tree_reads_stat(tree)
    need_link = find_eval.tree_reads_link(tree)
    failing = find_eval.time_tests_failing(tree)
    vis = session_visibility()
    real = follow.resolve if follow is not None else None
    quit = False
    # The directory a -prune keeps the walk out of: the one just judged,
    # which the walk enters next if at all.
    pruned: str | None = None
    # The last directory read and its names: -empty and the walk each read
    # a directory, and whichever comes second takes what the first read.
    held: tuple[str, list[str]] | None = None

    async def listed(spec: PathSpec, **kwargs: Any) -> list[str]:
        nonlocal held
        if held is not None and held[0] == spec.virtual:
            return held[1]
        names = await readdir(spec, **kwargs)
        held = (spec.virtual, names)
        return names

    async def judge(
        p: str, kind: str, depth: int, known: FileStat | None
    ) -> bool:
        nonlocal quit, pruned
        if not path_visible(vis, p):
            return False
        is_dir = kind == "d"
        is_empty = None
        if need_empty:
            is_empty = await _is_empty_entry(
                listed, stat, p, is_dir, unstatted, unreadable, known
            )
        # With a time test in the tree the stat comes first, so the entry
        # answers the test itself; the stat that -size alone needs waits
        # for the entries the tree kept.
        st = None
        mtime = None
        if need_stat:
            st = (
                known
                if known is not None
                else await _stat_entry(stat, p, unstatted)
            )
            if st is None and windowed:
                return False
            # A failed stat leaves the time unknown, which fails every time
            # test, so another -o arm (-name) can still match the entry.
            mtime = modified_ts(st.modified) if st is not None else None
        xkind, target = (
            await _other_side(follow, links, p, kind)
            if need_link
            else (None, None)
        )
        if regexes:
            await find_eval.prime_regexes(tree, [p])
        entry = find_types.FindEntry(
            key=p,
            name=p.rsplit("/", 1)[-1],
            kind=kind,
            depth=depth,
            is_empty=is_empty,
            mtime=mtime,
            stat=st,
            xkind=xkind,
            target=target,
        )
        judged = failing if need_mtime and mtime is None else tree
        kept, prunes = find_eval.verdict(entry, judged, args.mindepth, acts)
        if prunes:
            pruned = p
        if quits and find_eval.quit_fired(judged):
            quit = True
            if stopped is not None:
                stopped.append(p)
            return kept
        if not kept:
            return False
        if need_size and not is_dir and st is None:
            st = known or await _stat_entry(stat, p, unstatted)
            if st is None:
                return False
        if need_size and not _sized(
            args, DIR_SIZE if is_dir or st is None else st.size or 0
        ):
            return False
        return st is None or in_mtime_window(
            modified_ts(st.modified), args.mtime_min, args.mtime_max
        )

    async def entries(p: str, depth: int) -> list[str]:
        """The names a directory the walk enters holds, in name order."""
        if (
            (args.maxdepth is not None and depth >= args.maxdepth)
            or (enters is not None and not enters(p))
            or p == pruned
        ):
            return []
        spec = PathSpec(
            virtual=p, directory=p, resolved=False, vfs_path=p.strip("/")
        )
        try:
            children = await (
                listed(spec) if listing is None else listing(listed, spec)
            )
        except (FileNotFoundError, NotADirectoryError) as exc:
            # Only vanished dirs are skipped; API errors (rate limit, auth)
            # propagate.
            logger.debug("find: %s vanished before its listing: %s", p, exc)
            return []
        except PermissionError:
            # A directory the session may not open (a rule refused it at
            # the guarded readdir): find names it and walks on, so a caller
            # that collects those gets the path and the walk continues;
            # one that does not is not left with a silent gap in its
            # listing.
            if unreadable is None:
                raise
            if p not in unreadable:
                unreadable.append(p)
            return []
        return sorted(children, key=lambda child: child.rstrip("/"))

    start = root if root is not None else await _stat_entry(stat, root_path)
    chain = ((root_path, real(root_path)),) if real is not None else ()
    # Each open directory: its path, depth, the -L chain above it, the
    # entries left to visit, whether it is judged itself (a start point
    # that could not be statted reports only what it holds), and its stat
    # when known.
    frames: list[
        tuple[
            str,
            int,
            tuple[tuple[str, str], ...],
            Iterator[str],
            bool,
            FileStat | None,
        ]
    ] = []
    # find's depth convention: the search root is depth 0, its children are
    # depth 1. A start point that is not a directory has no children, so
    # readdir on it is either an error the walk would have to swallow
    # (Box answers ENOTDIR) or a wasted round trip everywhere else.
    if start is None:
        frames.append(
            (
                root_path,
                0,
                chain,
                iter(await entries(root_path, 0)),
                False,
                None,
            )
        )
    else:
        kind = printf_kind(start)
        first = not args.depth_first or kind != "d"
        if first and await judge(root_path, kind, 0, start):
            yield root_path
        if kind == "d" and not quit:
            frames.append(
                (
                    root_path,
                    0,
                    chain,
                    iter(await entries(root_path, 0)),
                    True,
                    start,
                )
            )
    while frames and not quit:
        p, depth, above, left, judged, known = frames[-1]
        child = next(left, None)
        if child is None:
            frames.pop()
            if (
                args.depth_first
                and judged
                and await judge(p, "d", depth, known)
            ):
                yield p
            continue
        # Classification is stat's job (an index lookup right after the
        # readdir that populated it). The one in-band proof is a trailing
        # slash on a cold listing: no backend renders a file with one.
        trimmed = child.rstrip("/")
        found = (
            None
            if child.endswith("/")
            else await _stat_entry(stat, trimmed, unstatted)
        )
        kind = "d" if child.endswith("/") else printf_kind(found)
        inner = above
        if kind == "d" and real is not None:
            # Under -L a directory is the one it resolves to, and one
            # already open above is find's file system loop: never a row,
            # never entered.
            here = real(trimmed)
            ancestor = next((v for v, r in above if r == here), None)
            if ancestor is not None:
                if loops is not None:
                    loops.append((trimmed, ancestor))
                continue
            inner = (*above, (trimmed, here))
        first = not args.depth_first or kind != "d"
        if first and await judge(trimmed, kind, depth + 1, found):
            yield trimmed
        if kind == "d" and not quit:
            frames.append(
                (
                    trimmed,
                    depth + 1,
                    inner,
                    iter(await entries(trimmed, depth + 1)),
                    True,
                    found,
                )
            )


def depth_first_order(path: str) -> tuple[tuple[str, int], ...]:
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
    except OSError as exc:
        logger.debug("find: link %s leads nowhere: %s", path, exc)
        return "l", None
    if target is None:
        return "l", None
    return printf_kind(target), target

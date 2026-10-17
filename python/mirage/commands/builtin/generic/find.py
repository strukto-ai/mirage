from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass
from functools import partial

from mirage.cache.context import active_cache_manager
from mirage.commands.builtin.find_parse import (
    parse_depth,
    parse_find_expression,
    parse_mtime,
    parse_size,
)
from mirage.commands.builtin.utils.links import (
    landing_root,
    links_of,
    mounts_of,
)
from mirage.commands.builtin.utils.paths import (
    dot_refusal,
    link_follow,
    stat_or_enoent,
)
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.context import session_visibility
from mirage.core.generic import find_eval
from mirage.core.generic.find import modified_ts, walk_find
from mirage.core.generic.find_eval import printf_kind
from mirage.errors.classify import failure_text
from mirage.errors.constants import MISS_ERRORS
from mirage.errors.fs import fs_strerror, walk_refusal
from mirage.errors.posix import posix_phrase
from mirage.errors.types import FsCondition
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileStat, FileType, FindType, PathSpec, Visibility
from mirage.utils.hidden import path_visible
from mirage.utils.key_prefix import mount_key, mount_prefix_of
from mirage.utils.path import respell_one, respell_raw
from mirage.view.types import LinkView, StatPath


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
) -> find_eval.FindArgs:
    if texts:
        expr = parse_find_expression(list(texts))
        return find_eval.FindArgs(
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
    md = parse_depth(maxdepth, "-maxdepth") if maxdepth is not None else None
    md_min = (
        parse_depth(mindepth, "-mindepth") if mindepth is not None else None
    )
    min_size, max_size = (None, None)
    if size is not None:
        min_size, max_size = parse_size(size)
    mtime_min, mtime_max = (None, None)
    if mtime is not None:
        mtime_min, mtime_max = parse_mtime(mtime)
    return find_eval.FindArgs(
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


def _matched_path(row: str, search: PathSpec) -> PathSpec:
    virtual = find_eval.unrespell_raw(
        row, search.virtual, search.raw_path or search.virtual
    )
    prefix = mount_prefix_of(search.virtual, search.vfs_path)
    return PathSpec(
        virtual=virtual,
        directory=virtual.rsplit("/", 1)[0] or "/",
        vfs_path=mount_key(virtual, prefix),
        resolved=True,
        raw_path=row,
    )


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


def missing_start_line(
    search_path: PathSpec, detail: str = posix_phrase(FsCondition.ENOENT)
) -> str:
    """GNU's stderr line for a start point find will not walk.

    The detail is the strerror: a start point that is not there, or one
    typed with a trailing slash that did not name a directory.

    Args:
        search_path (PathSpec): the start point, as the operand named it.
        detail (str): the strerror to report.
    """
    return f"find: '{search_path.raw_path}': {detail}"


def is_link(links: LinkView | None, search: PathSpec) -> bool:
    """Whether a start point is itself a namespace symlink.

    Args:
        links (LinkView | None): the namespace's symlink facts.
        search (PathSpec): the start point.
    """
    return links is not None and links.stat_at(search.virtual) is not None


@dataclass(frozen=True, slots=True)
class StartPoint:
    """What a start point makes ``find`` do with one operand.

    One of three things: the subtree is walked, these rows are the whole
    answer, or nothing is there and GNU's diagnostic is. ``stat`` carries
    the start point's own stat when a directory was walked, which is what
    lets the caller report the root itself without statting it twice.
    """

    walk: bool
    results: list[str]
    missing: bool = False
    stat: FileStat | None = None
    # The strerror the diagnostic carries when `missing` is set. A start
    # point that is simply absent keeps GNU's default wording; one under a
    # plain file, or typed with a trailing slash that resolved to a
    # non-directory, reports ENOTDIR instead (`find flink/` -> "Not a
    # directory").
    detail: str = posix_phrase(FsCondition.ENOENT)


WALK_START = StartPoint(walk=True, results=[])
MISSING_START = StartPoint(walk=False, results=[], missing=True)
NOT_DIR_START = StartPoint(
    walk=False,
    results=[],
    missing=True,
    detail=posix_phrase(FsCondition.ENOTDIR),
)


async def _missing_start(
    search: PathSpec, stat: Callable[[PathSpec], Awaitable[FileStat]] | None
) -> StartPoint:
    """The start point ``stat_path`` found nothing at, with GNU's errno.

    ``stat_path`` answers None for both ways a lookup fails, because every
    other caller of it treats them alike, while GNU names the one its stat
    met. So the mount's own stat is asked which, on the failure path only:
    a start point under a plain file is ENOTDIR.

    Args:
        search (PathSpec): the start point, as the operand named it.
        stat (Callable[[PathSpec], Awaitable[FileStat]] | None):
            the mount's stat, None when the caller has
            none to offer.
    """
    if stat is None:
        return MISSING_START
    try:
        await stat(search)
    except NotADirectoryError:
        return NOT_DIR_START
    except MISS_ERRORS:
        return MISSING_START
    return MISSING_START


async def resolve_start(
    search: PathSpec,
    args: find_eval.FindArgs,
    stat_path: StatPath | None,
    *,
    is_link: bool = False,
    stat: Callable[[PathSpec], Awaitable[FileStat]] | None = None,
    follow: Callable[[str], str] | None = None,
) -> StartPoint:
    """Decide what one start point contributes, before any walk.

    GNU stats every start point: only a directory has a subtree,
    anything else is reported as itself, and nothing at all is a
    diagnostic.

    ``stat_path`` asks both channels a backend can answer on, so a
    directory that exists only as its children still reports as one and
    None means nothing is there (see ``resolve_path_stat``). That is what
    makes the missing case answerable above every backend rather than
    only where one wires a stat.

    A symlink start point is walked as itself.

    Args:
        search (PathSpec): the start point, as the operand named it.
        args (FindArgs): parsed find expression.
        stat_path (StatPath | None): dispatcher-backed stat, None when the
            command runs outside a workspace (the walk then decides).
        is_link (bool): whether the start point is itself a namespace link.
        stat (Callable[[PathSpec], Awaitable[FileStat]] | None):
            the mount's stat, asked only to name the
            errno of a start point ``stat_path`` found nothing at.
        follow (Callable[[str], str] | None): the namespace's link
            resolution, which the start point may already have been
            taken through.
    """
    if search.walk_error is not None:
        # The walk refused the start point before find ran (the empty
        # name, a link loop), and every probe below goes by the path it
        # simplifies to.
        return StartPoint(
            walk=False,
            results=[],
            missing=True,
            detail=fs_strerror(walk_refusal(search))
            or posix_phrase(FsCondition.ENOENT),
        )
    if stat_path is None:
        return WALK_START
    # A start point's own `.` and `..` resolve first, link or not: the
    # lookup below asks about the path they simplify to.
    refusal = await dot_refusal(
        partial(stat_or_enoent, stat_path), search, follow
    )
    if refusal is not None:
        return StartPoint(
            walk=False,
            results=[],
            missing=True,
            detail=fs_strerror(refusal) or posix_phrase(FsCondition.ENOENT),
        )
    if is_link:
        return WALK_START
    try:
        start = await stat_path(search)
    except OSError as exc:
        # A start point the dispatcher refuses to stat is GNU's own
        # diagnostic for it, quoted like a missing one
        # (`find: 'P': Permission denied`), not an escaped error.
        detail = fs_strerror(exc)
        if detail is None:
            raise
        return StartPoint(walk=False, results=[], missing=True, detail=detail)
    if start is None:
        return await _missing_start(search, stat)
    manager = active_cache_manager()
    if start.size is None and manager is not None:
        cached_size = await manager.cached_size(search)
        if cached_size is not None:
            start = start.model_copy(update={"size": cached_size})
    if start.type == FileType.DIRECTORY:
        return StartPoint(walk=True, results=[], stat=start)
    # POSIX reads `x/` as `x/.`, so an operand typed with a trailing
    # slash has to name a directory; GNU refuses the rest with ENOTDIR
    # rather than reporting the entry itself.
    if search.raw_path.endswith("/"):
        return NOT_DIR_START
    prefix = mount_prefix_of(search.virtual, search.vfs_path)
    # `-path` matches the row as printed, so Path nodes carry the mount
    # prefix and the operand's spelling; the walk stamps its own tree
    # inside walk_find.
    tree = find_eval.bind_tree(
        find_eval.args_to_tree(args), prefix, search.virtual, search.raw_path
    )
    rows = apply_mount_prefix(
        start_point_results(search, start, args, tree), prefix
    )
    return StartPoint(
        walk=False, results=respell_raw(rows, search.virtual, search.raw_path)
    )


def start_point_results(
    search_path: PathSpec,
    start: FileStat,
    args: find_eval.FindArgs,
    tree: find_eval.PredNode,
) -> list[str]:
    """Results for a start point that is not a directory.

    GNU reports a non-directory start point when it matches the
    expression and walks nothing, because there is no subtree to
    descend. The entry sits at depth 0 and tests as ``f``, offering its
    own size and mtime to ``-size``, ``-mtime`` and ``-empty``.

    Asking a backend to walk one instead is what this replaces, and
    every backend answered differently: an object store listed the key
    as a prefix and returned nothing, Graph 404'd on the children of a
    file, and Box raised ENOTDIR.

    Args:
        search_path (PathSpec): the start point, as the operand named it.
        start (FileStat): the start point's own stat.
        args (FindArgs): parsed find expression.
        tree (PredNode): the prefix-stamped predicate tree.
    """
    results: list[str] = []
    if args.mtime_min is not None or args.mtime_max is not None:
        ts = modified_ts(start.modified)
        if ts is None:
            return results
        if args.mtime_min is not None and ts < args.mtime_min:
            return results
        if args.mtime_max is not None and ts > args.mtime_max:
            return results
    empty = None
    if args.empty:
        # GNU -empty matches only a size-0 regular file here; a device
        # start point is never empty-eligible.
        empty = start.size == 0 if start.type is FileType.FILE else False
    find_eval.emit_start_path(
        results,
        search_path.mount_path,
        find_eval.start_basename(search_path),
        kind=printf_kind(start),
        is_empty=empty,
        exists=True,
        tree=tree,
        maxdepth=args.maxdepth,
        mindepth=args.mindepth,
        size=start.size,
        min_size=args.min_size,
        max_size=args.max_size,
    )
    return results


def root_dir_results(
    search_path: PathSpec,
    args: find_eval.FindArgs,
    tree: find_eval.PredNode,
    *,
    is_empty: bool | None,
) -> list[str]:
    """Results for the directory start point itself, at depth 0.

    GNU lists a directory start point before descending into it, so
    ``find <dir>`` names the directory even when it holds nothing. The
    start point was already statted to get here, so this row needs no
    walk. ``-mtime`` is not applied: the caller skips the row under a
    time test and leaves it to the walk.

    Args:
        search_path (PathSpec): the start point, as the operand named it.
        args (FindArgs): parsed find expression.
        tree (PredNode): the prefix-stamped predicate tree.
        is_empty (bool | None): whether the directory holds nothing, None
            when no listing was taken (``-empty`` then cannot match it).
    """
    results: list[str] = []
    find_eval.emit_start_path(
        results,
        search_path.mount_path,
        find_eval.start_basename(search_path),
        kind="d",
        is_empty=is_empty,
        exists=True,
        tree=tree,
        maxdepth=args.maxdepth,
        mindepth=args.mindepth,
        min_size=args.min_size,
        max_size=args.max_size,
    )
    return results


async def early_root(
    search: PathSpec,
    args: find_eval.FindArgs,
    start: StartPoint,
    visibility: Visibility | None,
) -> list[str]:
    """Emit an independently known start point before asking for descendants.

    The walk must not delay the directory row the dispatcher already
    resolved, so a closing pipe can stop here before any listing.

    Args:
        search (PathSpec): the start point, as the operand named it.
        args (FindArgs): parsed find expression, shared across operands.
        start (StartPoint): the start point as resolve_start found it.
        visibility (Visibility | None): the session's visibility.

    Returns:
        list[str]: the start point's own row, or nothing when it cannot
            be answered before the walk.
    """
    if (
        args.empty
        or args.mtime_min is not None
        or args.mtime_max is not None
        or start.stat is None
        or not path_visible(visibility, search.virtual)
    ):
        return []
    prefix = mount_prefix_of(search.virtual, search.vfs_path)
    tree = find_eval.bind_tree(
        find_eval.args_to_tree(args), prefix, search.virtual, search.raw_path
    )
    rows = root_dir_results(search, args, tree, is_empty=None)
    return respell_raw(
        apply_mount_prefix(rows, prefix), search.virtual, search.raw_path
    )


@dataclass(frozen=True, slots=True)
class FindFlags:
    name: str | None = None
    type: str | None = None
    size: str | None = None
    mtime: str | None = None
    maxdepth: str | None = None
    iname: str | None = None
    path: str | None = None
    mindepth: str | None = None
    empty: bool = False
    follow: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> FindFlags:
    fl = FlagView(flags, spec=SPECS["find"])
    return FindFlags(
        name=fl.as_str("name"),
        type=fl.as_str("type"),
        size=fl.as_str("size"),
        mtime=fl.as_str("mtime"),
        maxdepth=fl.as_str("maxdepth"),
        iname=fl.as_str("iname"),
        path=fl.as_str("path"),
        mindepth=fl.as_str("mindepth"),
        empty=fl.as_bool("empty"),
        # The last of -H, -L and -P decides, as in GNU; only -L follows
        # the links the walk meets.
        follow=fl.typed_order("H", "L", "P")[-1:] == ["L"],
    )


async def find_walk_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    *,
    readdir: Callable[..., Awaitable[list[str]]],
    stat: Callable[..., Awaitable[FileStat]],
    unbounded: tuple[
        Callable[..., Awaitable[list[str]]],
        Callable[..., Awaitable[FileStat]],
    ]
    | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Run find by walking readdir/stat; mirrors findGeneric.

    GNU find walks every start point in operand order, names each one it
    cannot stat, keeps going with the rest, and exits 1; results print
    under the operand as typed.

    Args:
        paths (list[PathSpec]): Glob-resolved start points.
        texts (list[str]): The raw expression words.
        ctx (Context): Flags, the index for the walk, and namespace
            facts (stat_path, links) from the dispatcher.
        readdir (Callable): Bound readdir called as ``readdir(p, index)``.
        stat (Callable): Bound overlaid stat called as ``stat(p, index)``.
        unbounded (tuple[Callable, Callable] | None): the walk to take
            when no ``-maxdepth`` bounds it (one the mount answers whole),
            else ``readdir`` and ``stat``.
    """
    parsed = parse_flags(ctx.flags)
    flags = FlagView(ctx.flags, spec=SPECS["find"])
    bounded = flags.as_bool("xdev") or flags.as_bool("mount")
    mounts = mounts_of(ctx)
    stat_path = ctx.stat_path
    links = links_of(ctx)
    searches = (
        paths if paths else [PathSpec(virtual="/", directory="/", vfs_path="")]
    )
    args = parse_find_args(
        tuple(texts),
        name=parsed.name,
        type=parsed.type,
        size=parsed.size,
        mtime=parsed.mtime,
        maxdepth=parsed.maxdepth,
        iname=parsed.iname,
        path=parsed.path,
        mindepth=parsed.mindepth,
        empty=parsed.empty,
    )
    if unbounded is not None and args.maxdepth is None:
        readdir, stat = unbounded
    matched_runs: list[list[PathSpec]] = []
    io = IOResult(matched_runs=matched_runs)

    async def stream() -> AsyncIterator[bytes]:
        missing: list[str] = []
        for search in searches:
            start = await resolve_start(
                search,
                args,
                stat_path,
                stat=partial(stat, index=ctx.index),
                is_link=is_link(links, search),
                follow=link_follow(links),
            )
            first = await early_root(
                search,
                args,
                start,
                session_visibility(),
            )
            for row in first:
                yield (row + "\n").encode()
            if start.missing:
                missing.append(missing_start_line(search, start.detail))
                matched_runs.append([])
                continue
            if not start.walk:
                rows = start.results
            else:
                unreadable: list[str] = []
                unstatted: dict[str, Exception] = {}
                loops: list[tuple[str, str]] = []
                home = (
                    landing_root(mounts, links, search.virtual)
                    if bounded and mounts is not None
                    else None
                )

                def stays(virtual: str) -> bool:
                    return (
                        mounts is None
                        or landing_root(mounts, links, virtual) == home
                    )

                walked = await walk_find(
                    search,
                    readdir=readdir,
                    stat=stat,
                    index=ctx.index,
                    args=args,
                    follow=links if parsed.follow else None,
                    unreadable=unreadable,
                    unstatted=unstatted,
                    root=start.stat,
                    loops=loops,
                    enters=stays if home is not None else None,
                )
                rows = respell_raw(walked, search.virtual, search.raw_path)
                # GNU names a directory it may not open in the walk's own
                # order, lists the directory itself, and exits 1 like a
                # start point it could not read.
                missing.extend(
                    f"find: '{shown}': Permission denied"
                    for shown in respell_raw(
                        unreadable, search.virtual, search.raw_path
                    )
                )
                for path, exc in unstatted.items():
                    shown = respell_one(path, search.virtual, search.raw_path)
                    missing.append(f"find: '{shown}': {failure_text(exc)}")
                for path, above in loops:
                    missing.append(
                        "find: File system loop detected; "
                        f"'{respell_one(path, search.virtual, search.raw_path)}'"
                        " is part of the same file system loop as "
                        f"'{respell_one(above, search.virtual, search.raw_path)}'."
                    )
            for row in rows:
                if row not in first:
                    yield (row + "\n").encode()
            matched_runs.append([_matched_path(row, search) for row in rows])
        if missing:
            io.stderr = ("\n".join(missing) + "\n").encode()
            io.exit_code = 1

    return stream(), io

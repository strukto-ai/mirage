from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass
from functools import partial

from mirage.cache.context import active_cache_manager
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin import find_eval
from mirage.commands.builtin.find_parse import (
    parse_depth,
    parse_find_expression,
    parse_mtime,
    parse_size,
)
from mirage.commands.builtin.find_printf import printf_kind
from mirage.commands.builtin.utils.paths import (
    dot_refusal,
    link_follow,
    stat_or_enoent,
)
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.core.generic.find import link_results, modified_ts, walk_find
from mirage.errors.classify import failure_text
from mirage.errors.constants import MISS_ERRORS
from mirage.errors.fs import fs_strerror, walk_refusal
from mirage.errors.posix import posix_phrase
from mirage.errors.types import FsCondition
from mirage.io.types import ByteSource, IOResult
from mirage.ops.types import LinkView, StatPath
from mirage.types import FileStat, FileType, FindType, PathSpec, Visibility
from mirage.utils.dates import matches_mtime
from mirage.utils.hidden import path_visible
from mirage.utils.key_prefix import mount_key, mount_prefix_of
from mirage.utils.path import respell_one, respell_raw


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


def _row_spec(row: str, mount_prefix: str) -> PathSpec:
    """The stat probe's path for one mount-relative row.

    Args:
        row (str): the row, as the backend keyed it.
        mount_prefix (str): the mount prefix the row sits under.
    """
    virtual = apply_mount_prefix([row], mount_prefix)[0]
    return PathSpec(
        virtual=virtual,
        directory=virtual,
        resolved=False,
        vfs_path=mount_key(virtual, mount_prefix),
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
            s = await stat(_row_spec(r, mount_prefix))
        except (FileNotFoundError, NotADirectoryError, ValueError):
            continue
        # `matches_mtime` is the same helper the rest of this file already
        # uses. Parsing inline instead stamped UTC over an offset the
        # backend actually reported, moving the entry by that offset, and
        # let a malformed timestamp raise out of the walk.
        if matches_mtime(s.modified, mtime_min, mtime_max):
            filtered.append(r)
    return filtered


async def _row_mtime(
    stat: Callable[[PathSpec], Awaitable[FileStat]],
    mount_prefix: str,
    row: str,
) -> float | None:
    """Epoch-second mtime of one mount-relative row, None when it has
    none or is gone.

    Args:
        stat (Callable): overlay-aware stat.
        mount_prefix (str): the mount prefix the row sits under.
        row (str): the row, as the backend keyed it.
    """
    try:
        return modified_ts((await stat(_row_spec(row, mount_prefix))).modified)
    except (FileNotFoundError, NotADirectoryError, ValueError):
        return None


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

    One spelling of the diagnostic, because both find paths emit it: the
    native-op path and the walk each collect one per operand. The detail
    is the strerror: a start point that is not there, or one typed with
    a trailing slash that did not name a directory.

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
        stat (Callable | None): the mount's stat, None when the caller has
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

    The single place ``find`` classifies a start point, so the answer
    cannot depend on whether the mounted backend ships a native find op
    or is walked through readdir. GNU stats every start point for the
    same reason: only a directory has a subtree, anything else is
    reported as itself, and nothing at all is a diagnostic.

    ``stat_path`` asks both channels a backend can answer on, so a
    directory that exists only as its children still reports as one and
    None means nothing is there (see ``resolve_path_stat``). That is what
    makes the missing case answerable above every backend rather than
    only where one wires a stat.

    A symlink start point is left to the caller, which merges namespace
    links separately; it has no backend inode to stat.

    Args:
        search (PathSpec): the start point, as the operand named it.
        args (FindArgs): parsed find expression.
        stat_path (StatPath | None): dispatcher-backed stat, None when the
            command runs outside a workspace (the walk then decides).
        is_link (bool): whether the start point is itself a namespace link.
        stat (Callable | None): the mount's stat, asked only to name the
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
        start = await stat_path(search.virtual)
    except OSError as exc:
        # A start point the door refuses to stat is GNU's own
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
    # prefix and the operand's spelling. Built here rather than read off
    # args.tree: only the native-op path stamps that, the walk stamps
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
    generic already statted the start point to get here, so it decides
    this row and the backend only has to answer for descendants (see
    ``with_root_row`` for why the backend's own row is dropped).

    ``-mtime`` is deliberately not applied here: the caller either
    filters every row against namespace-aware times afterwards, or
    pushed the window into the backend, and re-testing it against the
    probe's own stat would drop rows a ``touch`` had just matched.

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


def with_root_row(
    results: list[str], search_path: PathSpec, root: list[str]
) -> list[str]:
    """Replace the backend's row for the start point with the generic's.

    Most native find ops emit the start path themselves, and each judged
    it on the only facts it had: ssh calls every directory non-empty, an
    object store calls one empty only when its own listing was empty, and
    a store holding no directory marker reported nothing at all for a
    directory that ``test -d`` and ``tree`` both saw. Merging instead of
    replacing would keep whichever of those a backend happened to say, so
    the row is dropped and the generic's takes its place. Descendants are
    still entirely the backend's answer.

    Compared with trailing slashes stripped, because a directory key is
    spelled both ways across backends.

    Args:
        results (list[str]): mount-relative rows the backend returned.
        search_path (PathSpec): the start point, as the operand named it.
        root (list[str]): the generic's row for the start point, empty if
            it did not match the expression.
    """
    key = search_path.mount_path.rstrip("/") or "/"
    return [r for r in results if (r.rstrip("/") or "/") != key] + root


async def find(
    paths: list[PathSpec],
    texts: tuple[str, ...],
    *,
    find_core: Callable[..., Awaitable[list[str]]],
    stat_path: StatPath | None = None,
    stat: Callable[[PathSpec], Awaitable[FileStat]] | None = None,
    dir_empty: Callable[[PathSpec], Awaitable[bool]] | None = None,
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
    follow: bool = False,
    visibility: Visibility | None = None,
) -> tuple[ByteSource | None, IOResult]:
    args = parse_find_args(
        texts,
        name=name,
        type=type,
        size=size,
        mtime=mtime,
        maxdepth=maxdepth,
        iname=iname,
        path=path,
        mindepth=mindepth,
        empty=empty,
    )
    searches = (
        paths if paths else [PathSpec(virtual="/", directory="/", vfs_path="")]
    )
    # GNU find walks every start point in operand order — duplicates and
    # all — names each one it cannot stat, keeps going with the rest, and
    # exits 1; the rows already found still print. One run per start
    # point, empty for one that matched nothing or is missing: the action
    # layer reads a row's start point off its run (-printf's %P and %d).
    matched_runs: list[list[PathSpec]] = []
    io = IOResult(matched_runs=matched_runs)

    async def stream() -> AsyncIterator[bytes]:
        missing: list[str] = []
        for search_path in searches:
            first = await early_root(
                search_path, args, stat_path, stat, links, visibility
            )
            for row in first:
                yield (row + "\n").encode()
            rows, detail = await _find_root(
                search_path,
                args,
                find_core=find_core,
                stat_path=stat_path,
                stat=stat,
                dir_empty=dir_empty,
                links=links,
                follow=follow,
                visibility=visibility,
            )
            if rows is None:
                missing.append(missing_start_line(search_path, detail))
                matched_runs.append([])
                continue
            for row in rows:
                if row not in first:
                    yield (row + "\n").encode()
            matched_runs.append(
                [_matched_path(row, search_path) for row in rows]
            )
        if missing:
            io.stderr = ("\n".join(missing) + "\n").encode()
            io.exit_code = 1

    return stream(), io


async def early_root(
    search: PathSpec,
    args: find_eval.FindArgs,
    stat_path: StatPath | None,
    stat: Callable[[PathSpec], Awaitable[FileStat]] | None,
    links: LinkView | None,
    visibility: Visibility | None,
) -> list[str]:
    """Emit an independently known start point before asking for descendants.

    Native find ops can batch their descendants; they must not delay the
    directory row that the dispatcher already knows. A closing pipe can
    consequently stop here without starting a remote traversal.

    Args:
        search (PathSpec): the start point, as the operand named it.
        args (FindArgs): parsed find expression, shared across operands.
        stat_path (StatPath | None): dispatcher-backed stat probe.
        stat (Callable | None): overlay-aware stat for the mtime filter.
        links (LinkView | None): the namespace's symlink facts.
        visibility (Visibility | None): the session's visibility.

    Returns:
        list[str]: the start point's own row, or nothing when it cannot
            be answered before the walk.
    """
    if args.empty or (
        stat is None
        and (args.mtime_min is not None or args.mtime_max is not None)
    ):
        return []
    start = await resolve_start(
        search,
        args,
        stat_path,
        is_link=is_link(links, search),
        follow=link_follow(links),
    )
    if start.stat is None or not path_visible(visibility, search.virtual):
        return []
    prefix = mount_prefix_of(search.virtual, search.vfs_path)
    tree = find_eval.bind_tree(
        find_eval.args_to_tree(args), prefix, search.virtual, search.raw_path
    )
    rows = root_dir_results(search, args, tree, is_empty=None)
    if stat is not None:
        rows = await apply_mtime_filter(
            rows,
            mtime_min=args.mtime_min,
            mtime_max=args.mtime_max,
            stat=stat,
            mount_prefix=prefix,
        )
    return respell_raw(
        apply_mount_prefix(rows, prefix), search.virtual, search.raw_path
    )


async def _find_root(
    search_path: PathSpec,
    args: find_eval.FindArgs,
    *,
    find_core: Callable[..., Awaitable[list[str]]],
    stat_path: StatPath | None,
    stat: Callable[[PathSpec], Awaitable[FileStat]] | None,
    dir_empty: Callable[[PathSpec], Awaitable[bool]] | None,
    links: LinkView | None,
    follow: bool,
    visibility: Visibility | None = None,
) -> tuple[list[str] | None, str]:
    """One start point's rows on the native-op path, None when missing.

    The second element is the strerror the caller's diagnostic carries
    when the rows are None, so the native-op path words a start point it
    will not walk exactly as the walk path does.

    Args:
        search_path (PathSpec): the start point, as the operand named it.
        args (FindArgs): parsed find expression, shared across operands.
        find_core (Callable): the backend's native find op.
        stat_path (StatPath | None): dispatcher-backed stat probe.
        stat (Callable | None): overlay-aware stat for the mtime filter.
        dir_empty (Callable | None): emptiness probe for ``-empty``.
        links (LinkView | None): the namespace's symlink facts.
        follow (bool): whether ``-L`` follows namespace links.
        visibility (Visibility | None): the session's visibility.
    """
    # A start point that is itself a symlink has no backend inode, so
    # neither the existence guard nor the backend walk can see it. GNU's
    # default -P reports the link and stops there, which is exactly what
    # link_results emits below.
    root_is_link = (
        links is not None and links.stat_at(search_path.virtual) is not None
    )
    # Fallback existence guard for a caller with no dispatcher probe (a
    # unit test, or a command run outside a workspace). With stat_path
    # wired, resolve_start below answers absence for every backend, so
    # spending a second stat here would only duplicate it.
    if stat_path is None and stat is not None and not root_is_link:
        try:
            await stat(search_path)
        except NotADirectoryError:
            # The operand carried a trailing slash and did not name a
            # directory; the backend stat is the only probe wired here.
            return None, posix_phrase(FsCondition.ENOTDIR)
        except (FileNotFoundError, ValueError):
            return None, posix_phrase(FsCondition.ENOENT)
    root_prefix = mount_prefix_of(search_path.virtual, search_path.vfs_path)
    # `-path` matches the row as printed; stamp the mount prefix and the
    # operand's spelling onto Path nodes before the backend walks
    # mount-relative keys (#396). Stamped into a per-operand tree: args
    # is shared by every start point and must stay unbound.
    tree = find_eval.bind_tree(
        find_eval.args_to_tree(args),
        root_prefix,
        search_path.virtual,
        search_path.raw_path,
    )
    # With a stat wired, the mtime window is applied by the overlay-
    # aware post-filter below, not pushed into the core: backend cores
    # only see native times and would drop files whose mtime lives in
    # the namespace (touch results, observed writes).
    push_mtime = stat is None
    # What the start point is decides which walk is even possible, so it
    # is resolved once, ahead of all of them: a symlink has no backend
    # inode (link_results reports it), a non-directory has no subtree,
    # and nothing at all is GNU's diagnostic. Statted through the
    # dispatcher, so a start point the router already resolved into
    # another mount answers there rather than on this command's mount.
    start = await resolve_start(
        search_path,
        args,
        stat_path,
        is_link=root_is_link,
        stat=stat,
        follow=link_follow(links),
    )
    if start.missing:
        return None, start.detail
    if not start.walk and not root_is_link:
        return start.results, start.detail
    results: list[str] = (
        []
        if root_is_link
        else await find_core(
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
            tree=tree,
        )
    )
    # GNU lists a directory start point itself before descending into it,
    # so it is named even when it holds nothing. Decided here rather than
    # by each native find op, which read existence off its own listing and
    # so said nothing at all for an empty directory that `test -d` and
    # `tree` both saw. A pushed-down mtime window is the one case left to
    # the backend: this row never passed through it.
    mtime_pushed = push_mtime and (
        args.mtime_min is not None or args.mtime_max is not None
    )
    # Emptiness is the one fact this row needs that a caller can decline to
    # offer (a bespoke wrapper wires no readdir), and that caller's core may
    # know it. Left alone in that case, so a backend's answer is never
    # traded for "unknown".
    can_probe = dir_empty is not None or not args.empty
    if start.stat is not None and not mtime_pushed and can_probe:
        root_empty = (
            await dir_empty(search_path)
            if args.empty and dir_empty is not None
            else None
        )
        if root_empty:
            # A symlink is namespace state no backend readdir can see, so a
            # directory holding only one would read as empty. GNU counts the
            # link as an entry.
            root_empty = not find_eval.has_link_children(
                links, search_path.virtual
            )
        results = with_root_row(
            results,
            search_path,
            root_dir_results(search_path, args, tree, is_empty=root_empty),
        )
    if stat is not None:
        results = await apply_mtime_filter(
            results,
            mtime_min=args.mtime_min,
            mtime_max=args.mtime_max,
            stat=stat,
            mount_prefix=root_prefix,
        )
    results = apply_mount_prefix(results, root_prefix)
    root_path = (
        search_path.virtual.rstrip("/") if search_path.virtual != "/" else "/"
    )
    results = sorted(
        results
        + await link_results(
            links,
            root_path,
            root_prefix,
            search_path.mount_path.strip("/"),
            args,
            tree,
            follow=follow,
        )
    )
    # What -prune reached is known only once every row has been judged:
    # a flat listing meets a child before its parent, so the ledger the
    # tree kept is applied here, after the backend and the link merge.
    if stat is not None:
        await find_eval.settle_pending_prunes(
            tree, partial(_row_mtime, stat, root_prefix)
        )
    results = find_eval.drop_pruned(results, tree, root_prefix)
    # Hidden rows drop here, above the native-op/walk fork and after the
    # link merge, so a mount's visibility behavior cannot depend on
    # whether its backend ships a native find op.
    results = [r for r in results if path_visible(visibility, r)]
    return respell_raw(
        results, search_path.virtual, search_path.raw_path
    ), start.detail


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
        follow=fl.as_bool("L"),
    )


async def find_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    *,
    find_core: Callable[..., Awaitable[list[str]]],
    stat: Callable[[PathSpec], Awaitable[FileStat]] | None = None,
    dir_empty: Callable[[PathSpec], Awaitable[bool]] | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Run find through a backend's native op; mirrors findGeneric.

    Args:
        paths (list[PathSpec]): Glob-resolved start points.
        texts (list[str]): The raw expression words.
        opts (CommandOpts): Flags and namespace facts (stat_path, links)
            from the dispatcher.
        find_core (Callable): The backend's native find op, bound.
        stat (Callable | None): Bound overlaid stat, when the backend
            serves local stats cheaply.
        dir_empty (Callable | None): Whether a directory start point is
            empty, for ``-empty``.
    """
    parsed = parse_flags(opts.flags)
    return await find(
        paths,
        tuple(texts),
        find_core=find_core,
        stat_path=opts.stat_path,
        stat=stat,
        dir_empty=dir_empty,
        name=parsed.name,
        type=parsed.type,
        size=parsed.size,
        mtime=parsed.mtime,
        maxdepth=parsed.maxdepth,
        iname=parsed.iname,
        path=parsed.path,
        mindepth=parsed.mindepth,
        empty=parsed.empty,
        links=opts.ns.links if opts.ns is not None else None,
        visibility=opts.ns.visibility if opts.ns is not None else None,
        follow=parsed.follow,
    )


async def find_walk_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    *,
    readdir: Callable[..., Awaitable[list[str]]],
    stat: Callable[..., Awaitable[FileStat]],
) -> tuple[ByteSource | None, IOResult]:
    """Run find by walking readdir/stat; the no-native-op twin.

    GNU find walks every start point in operand order, names each one it
    cannot stat, keeps going with the rest, and exits 1; results print
    under the operand as typed.

    Args:
        paths (list[PathSpec]): Glob-resolved start points.
        texts (list[str]): The raw expression words.
        opts (CommandOpts): Flags, the index for the walk, and namespace
            facts (stat_path, links) from the dispatcher.
        readdir (Callable): Bound readdir called as ``readdir(p, index)``.
        stat (Callable): Bound overlaid stat called as ``stat(p, index)``.
    """
    parsed = parse_flags(opts.flags)
    flags = FlagView(opts.flags, spec=SPECS["find"])
    bounded = flags.as_bool("xdev") or flags.as_bool("mount")
    mounts = opts.ns.mounts if opts.ns else None
    stat_path = opts.stat_path
    links = opts.ns.links if opts.ns is not None else None
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
    matched_runs: list[list[PathSpec]] = []
    io = IOResult(matched_runs=matched_runs)

    async def stream() -> AsyncIterator[bytes]:
        missing: list[str] = []
        for search in searches:
            first = await early_root(
                search,
                args,
                stat_path,
                None,
                links,
                opts.ns.visibility if opts.ns is not None else None,
            )
            for row in first:
                yield (row + "\n").encode()
            # Same start-point rule as the native-op path, so what `find` does
            # with a file or a missing operand does not depend on whether the
            # mounted backend ships a find op.
            start = await resolve_start(
                search,
                args,
                stat_path,
                stat=partial(stat, index=opts.index),
                is_link=is_link(links, search),
                follow=link_follow(links),
            )
            if start.missing:
                missing.append(missing_start_line(search, start.detail))
                matched_runs.append([])
                continue
            if not start.walk:
                rows = start.results
            else:
                unreadable: list[str] = []
                unstatted: dict[str, Exception] = {}

                async def read_directory(
                    path: PathSpec, index: IndexCacheStore | None
                ) -> list[str]:
                    if (
                        bounded
                        and mounts is not None
                        and mounts.root_of(path.virtual)
                        != mounts.root_of(search.virtual)
                    ):
                        return []
                    return await readdir(path, index)

                walked = await walk_find(
                    search,
                    readdir=read_directory,
                    stat=stat,
                    index=opts.index,
                    args=args,
                    links=links,
                    follow=parsed.follow,
                    unreadable=unreadable,
                    unstatted=unstatted,
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
            for row in rows:
                if row not in first:
                    yield (row + "\n").encode()
            matched_runs.append([_matched_path(row, search) for row in rows])
        if missing:
            io.stderr = ("\n".join(missing) + "\n").encode()
            io.exit_code = 1

    return stream(), io

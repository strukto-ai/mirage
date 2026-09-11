from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from functools import partial

from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.find_eval import (FindArgs, FindEntry, PredNode,
                                               args_to_tree, emit_start_path,
                                               has_link_children, keep,
                                               prefix_path_nodes,
                                               start_basename, tree_has_empty,
                                               unrespell_raw)
from mirage.commands.builtin.find_parse import (parse_depth,
                                                parse_find_expression,
                                                parse_mtime, parse_size)
from mirage.commands.builtin.find_printf import (expand_printf, printf_kind,
                                                 printf_needs_stat)
from mirage.commands.builtin.utils.identity import Identity, identity_of
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.context import path_allowed
from mirage.io.types import ByteSource, IOResult
from mirage.ops.types import LinkView, StatPath
from mirage.types import FileStat, FileType, FindType, PathSpec
from mirage.utils.dates import iso_timestamp, matches_mtime
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
            printf=expr.printf,
        )
    ftype: FindType | str | None = type
    if type in (FindType.DIRECTORY.value, FindType.FILE.value):
        ftype = FindType(type)
    md = parse_depth(maxdepth, "-maxdepth") if maxdepth is not None else None
    md_min = (parse_depth(mindepth, "-mindepth")
              if mindepth is not None else None)
    min_size, max_size = (None, None)
    if size is not None:
        min_size, max_size = parse_size(size)
    mtime_min, mtime_max = (None, None)
    if mtime is not None:
        mtime_min, mtime_max = parse_mtime(mtime)
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
        # `matches_mtime` is the same helper the rest of this file already
        # uses. Parsing inline instead stamped UTC over an offset the
        # backend actually reported, moving the entry by that offset, and
        # let a malformed timestamp raise out of the walk.
        if matches_mtime(s.modified, mtime_min, mtime_max):
            filtered.append(r)
    return filtered


def _matched_path(row: str, search: PathSpec) -> PathSpec:
    virtual = unrespell_raw(row, search.virtual, search.raw_path
                            or search.virtual)
    prefix = mount_prefix_of(search.virtual, search.resource_path)
    return PathSpec(virtual=virtual,
                    directory=virtual.rsplit("/", 1)[0] or "/",
                    resource_path=mount_key(virtual, prefix),
                    resolved=True,
                    raw_path=row)


async def _printf_stat(
    row: str,
    search: PathSpec,
    stat: Callable[[PathSpec], Awaitable[FileStat]] | None,
    stat_path: StatPath | None,
    links: LinkView | None,
) -> tuple[FileStat | None, FileStat | None]:
    """The stat one -printf row renders from, plus what %Y classifies.

    A namespace link answers first (it has no backend inode); its
    second element is the target's stat through the workspace, None
    when the link dangles. Every other row's second element is None
    and unused, since %Y is %y there.

    Args:
        row (str): the display row.
        search (PathSpec): the start point the row came from.
        stat (Callable | None): bound overlay-aware stat, when wired.
        stat_path (StatPath | None): the dispatcher's stat probe.
        links (LinkView | None): the namespace's symlink facts.
    """
    virtual = unrespell_raw(row, search.virtual, search.raw_path
                            or search.virtual)
    if links is not None:
        link_row = links.stat_at(virtual)
        if link_row is not None:
            return link_row, await links.target_stat(virtual)
    return await _backend_stat(virtual, search, stat, stat_path), None


async def _backend_stat(
    virtual: str,
    search: PathSpec,
    stat: Callable[[PathSpec], Awaitable[FileStat]] | None,
    stat_path: StatPath | None,
) -> FileStat | None:
    if stat is not None:
        prefix = mount_prefix_of(search.virtual, search.resource_path)
        spec = PathSpec(virtual=virtual,
                        directory=virtual,
                        resolved=False,
                        resource_path=mount_key(virtual, prefix))
        try:
            return await stat(spec)
        except (FileNotFoundError, NotADirectoryError, ValueError):
            return None
    if stat_path is not None:
        # The dispatcher probe answers for every backend, including the
        # ones that wire no cheap local stat (an object store); it is the
        # same channel resolve_start classifies start points on.
        return await stat_path(virtual)
    return None


async def _stat_with_index(stat: Callable[..., Awaitable[FileStat]],
                           index: IndexCacheStore | None,
                           spec: PathSpec) -> FileStat:
    return await stat(spec, index)


async def render_printf_rows(
    pairs: list[tuple[str, PathSpec]],
    fmt: str,
    stat: Callable[[PathSpec], Awaitable[FileStat]] | None,
    stat_path: StatPath | None,
    links: LinkView | None,
    missing: list[str],
    identity: Identity | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Render matched rows through a -printf format.

    Stats are fetched per row only when the format reads one (%s %y %m
    %M %T), through the same overlay-aware channel the -mtime filter
    uses, with namespace links answered first since a link row has no
    backend inode. Warning lines (unrecognized directives) ride stderr
    without touching the exit code, GNU's behavior; missing start points
    keep forcing exit 1.

    Args:
        pairs (list[tuple[str, PathSpec]]): display rows with the start
            point each came from.
        fmt (str): the -printf format as typed.
        stat (Callable | None): bound overlay-aware stat, when wired.
        links (LinkView | None): the namespace's symlink facts.
        missing (list[str]): diagnostics for start points not walked.
        identity (Identity | None): who the session is, for the owner
            directives on an entry that reports no owner of its own.
    """
    warnings: list[str] = []
    needs = printf_needs_stat(fmt)
    parts: list[str] = []
    for row, search in pairs:
        st, target = (await _printf_stat(row, search, stat, stat_path, links)
                      if needs else (None, None))
        parts.append(
            expand_printf(fmt, row, search, st, warnings, target, identity))
    err = missing + warnings
    io = IOResult(stderr=("\n".join(err) + "\n").encode() if err else None,
                  exit_code=1 if missing else 0)
    return "".join(parts).encode(), io


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


def missing_start_line(search_path: PathSpec,
                       detail: str = "No such file or directory") -> str:
    """GNU's stderr line for a start point find will not walk.

    One spelling of the diagnostic, because both find paths emit it: the
    native-op path and the walk each collect one per operand. The detail
    is the strerror: a start point that is not there, or one typed with
    a trailing slash that did not name a directory.

    Args:
        search_path (PathSpec): the start point, as the operand named it.
        detail (str): the strerror to report.
    """
    label = search_path.raw_path or search_path.virtual
    return f"find: '{label}': {detail}"


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
    # point that is simply absent keeps GNU's default wording; one typed
    # with a trailing slash that resolved to a non-directory reports
    # ENOTDIR instead (`find flink/` -> "Not a directory").
    detail: str = "No such file or directory"


WALK_START = StartPoint(walk=True, results=[])
MISSING_START = StartPoint(walk=False, results=[], missing=True)
NOT_DIR_START = StartPoint(walk=False,
                           results=[],
                           missing=True,
                           detail="Not a directory")


async def resolve_start(
    search: PathSpec,
    args: FindArgs,
    stat_path: StatPath | None,
    *,
    is_link: bool = False,
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
    """
    if stat_path is None or is_link:
        return WALK_START
    start = await stat_path(search.virtual)
    if start is None:
        return MISSING_START
    if start.type == FileType.DIRECTORY:
        return StartPoint(walk=True, results=[], stat=start)
    # POSIX reads `x/` as `x/.`, so an operand typed with a trailing
    # slash has to name a directory; GNU refuses the rest with ENOTDIR
    # rather than reporting the entry itself.
    if search.raw_path.endswith("/"):
        return NOT_DIR_START
    prefix = mount_prefix_of(search.virtual, search.resource_path)
    # `-path` matches the display path, so Path nodes carry the mount
    # prefix. Built here rather than read off args.tree: only the
    # native-op path stamps that, the walk stamps inside walk_find.
    tree = prefix_path_nodes(args_to_tree(args), prefix)
    rows = apply_mount_prefix(start_point_results(search, start, args, tree),
                              prefix)
    return StartPoint(walk=False,
                      results=respell_raw(rows, search.virtual,
                                          search.raw_path))


def start_point_results(
    search_path: PathSpec,
    start: FileStat,
    args: FindArgs,
    tree: PredNode,
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
        ts = _modified_ts(start.modified)
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
        empty = (start.size
                 or 0) == 0 if start.type is FileType.FILE else False
    emit_start_path(results,
                    search_path.mount_path,
                    start_basename(search_path),
                    kind=printf_kind(start),
                    is_empty=empty,
                    exists=True,
                    tree=tree,
                    maxdepth=args.maxdepth,
                    mindepth=args.mindepth,
                    size=start.size,
                    min_size=args.min_size,
                    max_size=args.max_size)
    return results


def root_dir_results(
    search_path: PathSpec,
    args: FindArgs,
    tree: PredNode,
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
    emit_start_path(results,
                    search_path.mount_path,
                    start_basename(search_path),
                    kind="d",
                    is_empty=is_empty,
                    exists=True,
                    tree=tree,
                    maxdepth=args.maxdepth,
                    mindepth=args.mindepth,
                    min_size=args.min_size,
                    max_size=args.max_size)
    return results


def with_root_row(results: list[str], search_path: PathSpec,
                  root: list[str]) -> list[str]:
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
    identity: Identity | None = None,
) -> tuple[ByteSource | None, IOResult]:
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
    searches = paths if paths else [
        PathSpec(virtual="/", directory="/", resource_path="")
    ]
    # GNU find walks every start point in operand order — duplicates and
    # all — names each one it cannot stat, keeps going with the rest, and
    # exits 1; the rows already found still print.
    results: list[str] = []
    matched_runs: list[list[PathSpec]] = []
    missing: list[str] = []
    printf_pairs: list[tuple[str, PathSpec]] = []
    for search_path in searches:
        rows, detail = await _find_root(search_path,
                                        args,
                                        find_core=find_core,
                                        stat_path=stat_path,
                                        stat=stat,
                                        dir_empty=dir_empty,
                                        links=links,
                                        follow=follow)
        if rows is None:
            missing.append(missing_start_line(search_path, detail))
            continue
        results.extend(rows)
        matched_runs.append([_matched_path(row, search_path) for row in rows])
        if args.printf is not None:
            printf_pairs.extend((row, search_path) for row in rows)
    if args.printf is not None:
        return await render_printf_rows(printf_pairs, args.printf, stat,
                                        stat_path, links, missing, identity)
    if missing:
        return format_records(results), IOResult(matched_runs=matched_runs,
                                                 stderr=("\n".join(missing) +
                                                         "\n").encode(),
                                                 exit_code=1)
    return format_records(results), IOResult(matched_runs=matched_runs)


async def _find_root(
    search_path: PathSpec,
    args: FindArgs,
    *,
    find_core: Callable[..., Awaitable[list[str]]],
    stat_path: StatPath | None,
    stat: Callable[[PathSpec], Awaitable[FileStat]] | None,
    dir_empty: Callable[[PathSpec], Awaitable[bool]] | None,
    links: LinkView | None,
    follow: bool,
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
    """
    # A start point that is itself a symlink has no backend inode, so
    # neither the existence guard nor the backend walk can see it. GNU's
    # default -P reports the link and stops there, which is exactly what
    # link_results emits below.
    root_is_link = (links is not None
                    and links.stat_at(search_path.virtual) is not None)
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
            return None, "Not a directory"
        except (FileNotFoundError, ValueError):
            return None, "No such file or directory"
    root_prefix = mount_prefix_of(search_path.virtual,
                                  search_path.resource_path)
    # `-path` matches the display path as printed; stamp the mount
    # prefix onto Path nodes before the backend walks mount-relative
    # keys (#396). Stamped into a per-operand tree — args is shared by
    # every start point and must stay unprefixed.
    tree = prefix_path_nodes(args_to_tree(args), root_prefix)
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
    start = await resolve_start(search_path,
                                args,
                                stat_path,
                                is_link=root_is_link)
    if start.missing:
        return None, start.detail
    if not start.walk and not root_is_link:
        return start.results, start.detail
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
        tree=tree,
    )
    # GNU lists a directory start point itself before descending into it,
    # so it is named even when it holds nothing. Decided here rather than
    # by each native find op, which read existence off its own listing and
    # so said nothing at all for an empty directory that `test -d` and
    # `tree` both saw. A pushed-down mtime window is the one case left to
    # the backend: this row never passed through it.
    mtime_pushed = push_mtime and (args.mtime_min is not None
                                   or args.mtime_max is not None)
    # Emptiness is the one fact this row needs that a caller can decline to
    # offer (a bespoke wrapper wires no readdir), and that caller's core may
    # know it. Left alone in that case, so a backend's answer is never
    # traded for "unknown".
    can_probe = dir_empty is not None or not args.empty
    if start.stat is not None and not mtime_pushed and can_probe:
        root_empty = (await dir_empty(search_path)
                      if args.empty and dir_empty is not None else None)
        if root_empty:
            # A symlink is namespace state no backend readdir can see, so a
            # directory holding only one would read as empty. GNU counts the
            # link as an entry.
            root_empty = not has_link_children(links, search_path.virtual)
        results = with_root_row(
            results, search_path,
            root_dir_results(search_path, args, tree, is_empty=root_empty))
    if stat is not None:
        results = await apply_mtime_filter(results,
                                           mtime_min=args.mtime_min,
                                           mtime_max=args.mtime_max,
                                           stat=stat,
                                           mount_prefix=root_prefix)
    results = apply_mount_prefix(results, root_prefix)
    root_path = (search_path.virtual.rstrip("/")
                 if search_path.virtual != "/" else "/")
    results = sorted(results +
                     await link_results(links,
                                        root_path,
                                        root_prefix,
                                        search_path.mount_path.strip("/"),
                                        args,
                                        tree,
                                        follow=follow))
    # Hidden rows drop here, above the native-op/walk fork and after the
    # link merge, so a mount's visibility behavior cannot depend on
    # whether its backend ships a native find op.
    results = [r for r in results if path_allowed(r)]
    return respell_raw(results, search_path.virtual,
                       search_path.raw_path), start.detail


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
    links: LinkView | None = None,
) -> bool:
    if is_dir:
        if has_link_children(links, path):
            return False
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
    spec: PathSpec,
    index: IndexCacheStore,
    maxdepth: int | None,
    depth: int,
    acc: list[tuple[str, str]],
    unreadable: list[str] | None = None,
) -> None:
    if maxdepth is not None and depth > maxdepth:
        return
    try:
        children = await readdir(spec, index)
    except FileNotFoundError:
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
    prefix = mount_prefix_of(spec.virtual, spec.resource_path)
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
            st = await _stat_entry(stat, trimmed, prefix, index)
            is_dir = st is not None and st.type == FileType.DIRECTORY
            kind = printf_kind(st)
        acc.append((trimmed, kind))
        if is_dir:
            child_spec = PathSpec(virtual=trimmed,
                                  directory=trimmed,
                                  resolved=False,
                                  resource_path=mount_key(trimmed, prefix))
            await _walk_collect(readdir, stat, child_spec, index, maxdepth,
                                depth + 1, acc, unreadable)


async def link_results(
    links: LinkView | None,
    search_root: str,
    prefix: str,
    search_key: str,
    args: FindArgs,
    tree: PredNode,
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
                          kind=kind,
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
    index: IndexCacheStore,
    args: FindArgs,
    links: LinkView | None = None,
    follow: bool = False,
    unreadable: list[str] | None = None,
) -> list[str]:
    collected: list[tuple[str, str]] = []
    prefix = mount_prefix_of(search_path.virtual, search_path.resource_path)
    search_key = search_path.mount_path.strip("/")
    root_path = (search_path.virtual.rstrip("/")
                 if search_path.virtual != "/" else "/")
    root_stat = await _stat_entry(stat, root_path, prefix, index)
    if root_stat is not None:
        collected.append((root_path, printf_kind(root_stat)))
    # GNU depth convention: the search root is depth 0, its children are
    # depth 1. A start point that is not a directory has no children, so
    # readdir on it is either an error the walk would have to swallow
    # (Box answers ENOTDIR) or a wasted round trip everywhere else.
    if root_stat is None or root_stat.type == FileType.DIRECTORY:
        await _walk_collect(readdir, stat, search_path, index, args.maxdepth,
                            1, collected, unreadable)
    tree = prefix_path_nodes(args_to_tree(args), prefix)
    need_empty = tree_has_empty(tree)
    results: list[str] = []
    for p, kind in sorted(collected):
        if not path_allowed(p):
            continue
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
                                             index, links)
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
    results.extend(await link_results(links,
                                      root_path,
                                      prefix,
                                      search_key,
                                      args,
                                      tree,
                                      follow=follow))
    return sorted(results)


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
    return await find(paths,
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
                      follow=parsed.follow,
                      identity=identity_of(opts))


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
    stat_path = opts.stat_path
    links = opts.ns.links if opts.ns is not None else None
    searches = paths if paths else [
        PathSpec(virtual="/", directory="/", resource_path="")
    ]
    args = parse_find_args(tuple(texts),
                           name=parsed.name,
                           type=parsed.type,
                           size=parsed.size,
                           mtime=parsed.mtime,
                           maxdepth=parsed.maxdepth,
                           iname=parsed.iname,
                           path=parsed.path,
                           mindepth=parsed.mindepth,
                           empty=parsed.empty)
    results: list[str] = []
    matched_runs: list[list[PathSpec]] = []
    missing: list[str] = []
    printf_pairs: list[tuple[str, PathSpec]] = []
    for search in searches:
        # Same start-point rule as the native-op path, so what `find` does
        # with a file or a missing operand does not depend on whether the
        # mounted backend ships a find op.
        start = await resolve_start(search,
                                    args,
                                    stat_path,
                                    is_link=is_link(links, search))
        if start.missing:
            missing.append(missing_start_line(search, start.detail))
            continue
        if not start.walk:
            rows = start.results
        else:
            unreadable: list[str] = []
            walked = await walk_find(search,
                                     readdir=readdir,
                                     stat=stat,
                                     index=opts.index,
                                     args=args,
                                     links=links,
                                     follow=parsed.follow,
                                     unreadable=unreadable)
            rows = respell_raw(walked, search.virtual, search.raw_path)
            # GNU names a directory it may not open in the walk's own
            # order, lists the directory itself, and exits 1 like a
            # start point it could not read.
            missing.extend(f"find: '{shown}': Permission denied"
                           for shown in respell_raw(unreadable, search.virtual,
                                                    search.raw_path))
        results.extend(rows)
        matched_runs.append([_matched_path(row, search) for row in rows])
        if args.printf is not None:
            printf_pairs.extend((row, search) for row in rows)
    if args.printf is not None:
        return await render_printf_rows(
            printf_pairs, args.printf,
            partial(_stat_with_index, stat, opts.index), stat_path, links,
            missing, identity_of(opts))
    if missing:
        return format_records(results), IOResult(matched_runs=matched_runs,
                                                 stderr=("\n".join(missing) +
                                                         "\n").encode(),
                                                 exit_code=1)
    return format_records(results), IOResult(matched_runs=matched_runs)

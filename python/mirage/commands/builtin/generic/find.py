from collections.abc import (
    AsyncIterator,
    Awaitable,
    Callable,
    Mapping,
    Sequence,
)
from contextlib import aclosing
from dataclasses import dataclass
from functools import partial

from mirage.commands.builtin.utils.links import (
    landing_root,
    links_of,
    mounts_of,
)
from mirage.commands.builtin.utils.paths import (
    dot_refusal,
    link_follow,
    stat_or_enoent,
    vfs_stat_path,
)
from mirage.commands.builtin.utils.tree import WalkBudget
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.constants import OPERAND
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.core.generic import find_eval
from mirage.core.generic import types as find_types
from mirage.core.generic.find import modified_ts, walk_find
from mirage.core.generic.find_eval import printf_kind
from mirage.errors.constants import MISS_ERRORS
from mirage.errors.fs import fs_strerror, strerror_of, walk_refusal
from mirage.errors.posix import posix_phrase
from mirage.errors.types import FsCondition
from mirage.io.types import ByteSource, IOResult, PathRecord
from mirage.rs.find import FindExpr, parse_find_expression
from mirage.types import (
    FileStat,
    FileType,
    FindType,
    Follow,
    LineFacts,
    PathSpec,
)
from mirage.utils.path import respell_one, respell_raw


def parse_find_args(
    texts: tuple[str, ...],
    *,
    find: FindExpr | None = None,
    name: str | None = None,
    type: str | None = None,
    size: str | None = None,
    mtime: str | None = None,
    maxdepth: str | None = None,
    iname: str | None = None,
    path: str | None = None,
    mindepth: str | None = None,
    empty: bool = False,
) -> find_types.FindArgs:
    """The walk's arguments, from the line's expression or from flags.

    Args:
        texts (tuple[str, ...]): the expression words, read by mirage-rs
            when no parsed expression comes with them.
        find (FindExpr | None): the expression the executor parsed once
            for the line.
        name (str | None): ``-name`` as a flag.
        type (str | None): ``-type`` as a flag.
        size (str | None): ``-size`` as a flag.
        mtime (str | None): ``-mtime`` as a flag.
        maxdepth (str | None): ``-maxdepth`` as a flag.
        iname (str | None): ``-iname`` as a flag.
        path (str | None): ``-path`` as a flag.
        mindepth (str | None): ``-mindepth`` as a flag.
        empty (bool): ``-empty`` as a flag.
    """
    if find is not None or texts:
        expr = find if find is not None else parse_find_expression(texts)
        return find_types.FindArgs(
            min_size=expr.min_size,
            max_size=expr.max_size,
            mtime_min=expr.mtime_min,
            mtime_max=expr.mtime_max,
            maxdepth=expr.maxdepth,
            mindepth=expr.mindepth,
            empty=expr.uses_empty,
            tree=expr.tree,
            depth_first=expr.depth_first,
        )
    ftype: FindType | str | None = type
    if type in (FindType.DIRECTORY.value, FindType.FILE.value):
        ftype = FindType(type)
    words = [
        word
        for flag, value in (
            ("-maxdepth", maxdepth),
            ("-mindepth", mindepth),
            ("-size", size),
            ("-mtime", mtime),
        )
        if value is not None
        for word in (flag, value)
    ]
    limits = parse_find_expression(words) if words else FindExpr()
    return find_types.FindArgs(
        name=name,
        iname=iname,
        path_pattern=path,
        type=ftype,
        min_size=limits.min_size,
        max_size=limits.max_size,
        mtime_min=limits.mtime_min,
        mtime_max=limits.mtime_max,
        maxdepth=limits.maxdepth,
        mindepth=limits.mindepth,
        empty=empty,
    )


def _matched_path(row: str, search: PathSpec) -> PathSpec:
    virtual = find_eval.unrespell_raw(
        row, search.virtual, search.raw_path or search.virtual
    )
    return PathSpec(
        virtual=virtual,
        directory=virtual.rsplit("/", 1)[0] or "/",
        vfs_path=virtual.strip("/"),
        resolved=True,
        raw_path=row,
    )


async def _missing_start_detail(
    search: PathSpec, stat: Callable[[PathSpec], Awaitable[FileStat]]
) -> str:
    """The strerror of a start point ``stat_path`` found nothing at.

    ``stat_path`` answers None for both ways a lookup fails, because every
    other caller of it treats them alike, while GNU names the one its stat
    met. So the mount's own stat is asked which, on the failure path only:
    a start point under a plain file is ENOTDIR.

    Args:
        search (PathSpec): the start point, as the operand named it.
        stat (Callable[[PathSpec], Awaitable[FileStat]]): the mount's stat.
    """
    try:
        await stat(search)
    except NotADirectoryError:
        return posix_phrase(FsCondition.ENOTDIR)
    except MISS_ERRORS:
        return posix_phrase(FsCondition.ENOENT)
    return posix_phrase(FsCondition.ENOENT)


def start_point_results(
    search_path: PathSpec,
    start: FileStat,
    args: find_types.FindArgs,
    tree: find_types.PredNode,
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
        tree (PredNode): the predicate tree bound to the start point.
    """
    results: list[str] = []
    ts = None
    if args.mtime_min is not None or args.mtime_max is not None:
        ts = modified_ts(start.modified)
        if ts is None:
            return results
        if args.mtime_min is not None and ts < args.mtime_min:
            return results
        if args.mtime_max is not None and ts > args.mtime_max:
            return results
    elif find_eval.tree_has_time(tree):
        ts = modified_ts(start.modified)
        if ts is None:
            tree = find_eval.time_tests_failing(tree)
    empty = None
    if args.empty:
        # GNU -empty matches only a size-0 regular file here; a device
        # start point is never empty-eligible.
        empty = start.size == 0 if start.type is FileType.FILE else False
    find_eval.emit_start_path(
        results,
        "/" + search_path.virtual.strip("/"),
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
        mtime=ts,
        stat=start,
    )
    return results


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
        # the links the walk meets, and -follow is -L wherever it is.
        follow=fl.typed_order("H", "L", "P")[-1:] == ["L"]
        or fl.as_bool("follow"),
    )


async def find_generic(
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
        ctx (Context): Flags and namespace
            facts (stat_path, links) from the dispatcher.
        readdir (Callable): Bound readdir called as ``readdir(p)``.
        stat (Callable): Bound overlaid stat called as ``stat(p)``.
        unbounded (tuple[Callable, Callable] | None): the walk to take
            when no ``-maxdepth`` bounds it (one the mount answers whole),
            else ``readdir`` and ``stat``.
    """
    parsed = parse_flags(ctx.flags)
    flags = FlagView(ctx.flags, spec=SPECS["find"])
    bounded = flags.as_bool("xdev") or flags.as_bool("mount")
    mounts = mounts_of(ctx)
    stat_path = vfs_stat_path(ctx.vfs)
    links = links_of(ctx)
    searches = (
        paths if paths else [PathSpec(virtual="/", directory="/", vfs_path="")]
    )
    args = parse_find_args(
        tuple(texts),
        find=ctx.find,
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
    records: list[PathRecord] = []
    io = IOResult(records=records)

    async def stream() -> AsyncIterator[bytes]:
        missing: list[str] = []
        stopped: list[str] = []
        for run, search in enumerate(searches):
            if stopped:
                break
            label = f"find: '{search.raw_path}': "
            if search.walk_error is not None:
                # The walk refused the start point before find ran (the
                # empty name, a link loop), and every probe below goes by
                # the path it simplifies to.
                missing.append(
                    label
                    + (
                        fs_strerror(walk_refusal(search))
                        or posix_phrase(FsCondition.ENOENT)
                    )
                )
                continue
            # GNU stats every start point: only a directory has a subtree,
            # anything else is reported as itself, and nothing at all is a
            # diagnostic. stat_path asks both channels a backend can answer
            # on, so a directory that exists only as its children still
            # reports as one and None means nothing is there; without one
            # (outside a workspace) the walk decides.
            start: FileStat | None = None
            if stat_path is not None:
                # A start point's own `.` and `..` resolve first, link or
                # not: the lookup below asks about the path they simplify to.
                refusal = await dot_refusal(
                    partial(stat_or_enoent, stat_path),
                    search,
                    link_follow(links),
                )
                if refusal is not None:
                    missing.append(
                        label
                        + (
                            fs_strerror(refusal)
                            or posix_phrase(FsCondition.ENOENT)
                        )
                    )
                    continue
            # A symlink start point is walked as itself.
            if stat_path is not None and (
                links is None or links.stat_at(search.virtual) is None
            ):
                try:
                    start = await stat_path(search)
                except OSError as err:
                    # A start point the dispatcher refuses to stat is GNU's
                    # own diagnostic for it, quoted like a missing one
                    # (`find: 'P': Permission denied`), not an escaped error.
                    detail = fs_strerror(err)
                    if detail is None:
                        raise
                    missing.append(label + detail)
                    continue
                if start is None:
                    missing.append(
                        label + await _missing_start_detail(search, stat)
                    )
                    continue
                if start.type != FileType.DIRECTORY:
                    # POSIX reads `x/` as `x/.`, so an operand typed with a
                    # trailing slash has to name a directory; GNU refuses
                    # the rest with ENOTDIR rather than reporting the entry.
                    if search.raw_path.endswith("/"):
                        missing.append(
                            label + posix_phrase(FsCondition.ENOTDIR)
                        )
                        continue
                    # `-path` matches the row as printed, so Path nodes
                    # carry the operand's spelling; the walk stamps its own
                    # tree inside walk_find.
                    tree = find_eval.bind_tree(
                        find_eval.args_to_tree(args),
                        "",
                        search.virtual,
                        search.raw_path,
                    )
                    await find_eval.prime_regexes(
                        tree, ["/" + search.virtual.strip("/")]
                    )
                    for row in respell_raw(
                        start_point_results(search, start, args, tree),
                        search.virtual,
                        search.raw_path,
                    ):
                        yield (row + "\n").encode()
                        records.append(
                            PathRecord(_matched_path(row, search), run)
                        )
                    if find_eval.quit_fired(tree):
                        stopped.append(search.virtual)
                    continue
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

            budget = WalkBudget(search, mounts)
            walked = walk_find(
                search,
                readdir=readdir,
                stat=stat,
                args=args,
                follow=links if parsed.follow else None,
                unreadable=unreadable,
                unstatted=unstatted,
                root=start,
                loops=loops,
                enters=stays if home is not None else None,
                listing=budget.listing,
                links=links,
                stopped=stopped,
            )
            async with aclosing(walked) as rows:
                async for key in rows:
                    row = respell_one(key, search.virtual, search.raw_path)
                    yield (row + "\n").encode()
                    records.append(PathRecord(_matched_path(row, search), run))
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
                missing.append(f"find: '{shown}': {strerror_of(exc)}")
            for path, above in loops:
                missing.append(
                    "find: File system loop detected; "
                    f"'{respell_one(path, search.virtual, search.raw_path)}'"
                    " is part of the same file system loop as "
                    f"'{respell_one(above, search.virtual, search.raw_path)}'."
                )
            missing.extend(f"find: {line}" for line in budget.stopped)
        if missing:
            io.stderr = ("\n".join(missing) + "\n").encode()
            io.exit_code = 1

    return stream(), io


def facts(fl: FlagView, operands: Sequence[str | PathSpec]) -> LineFacts:
    """A find line walks every mount below its start points, and follows
    a start point that is a link under ``-H`` or ``-L``: the last of
    ``-P``, ``-H`` and ``-L`` typed before the first start point wins,
    where GNU reads them (findutils 4.10).

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        operands (Sequence[str | PathSpec]): the line's operands.
    """
    follows = Follow.NONE
    for name, _ in fl.occurrences(OPERAND, "P", "H", "L"):
        if name == OPERAND:
            break
        follows = Follow.NONE if name == "P" else Follow.LAST
    if fl.as_bool("follow"):
        follows = Follow.LAST
    return LineFacts(follows=follows, walks=True, reads_subtree=True)

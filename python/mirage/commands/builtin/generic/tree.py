import posixpath
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from functools import partial

from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.context import mount_allowed
from mirage.io.types import IOResult
from mirage.ops.types import MountView, ReaddirPath, StatPath
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import WALK_ERRORS
from mirage.utils.fnmatch import fnmatch
from mirage.utils.key_prefix import rekey

# GNU tree's ASCII (C-locale) drawing set, matching `tree` in the battery's
# docker oracle; the vertical/indent continuations are 4 columns wide.
_BRANCH = "|-- "
_LAST = "`-- "
_VERTICAL = "|   "
_INDENT = "    "

Readdir = Callable[[PathSpec, IndexCacheStore | None], Awaitable[list[str]]]
Stat = Callable[[PathSpec, IndexCacheStore | None], Awaitable[FileStat]]


async def _cross_readdir(readdir_path: ReaddirPath, path: PathSpec,
                         index: IndexCacheStore | None) -> list[str]:
    """List a directory that belongs to another mount.

    Args:
        readdir_path (ReaddirPath): dispatcher-backed readdir.
        path (PathSpec): the directory to list.
        index (IndexCacheStore | None): unused; the owning mount indexes
            its own listing inside the dispatched op.
    """
    return await readdir_path(path.virtual)


async def _cross_stat(stat_path: StatPath, path: PathSpec,
                      index: IndexCacheStore | None) -> FileStat:
    """Stat an entry that belongs to another mount.

    Args:
        stat_path (StatPath): dispatcher-backed stat.
        path (PathSpec): the entry to stat.
        index (IndexCacheStore | None): unused, as for `_cross_readdir`.
    """
    stat = await stat_path(path.virtual)
    if stat is None:
        raise FileNotFoundError(path.virtual)
    return stat


def _child_mounts(mounts: MountView | None, directory: str) -> list[str]:
    """The mount roots mounted directly on this directory.

    A mount point need not exist in the parent backend at all, and when
    it does the parent lists a directory whose contents belong to
    somebody else. Either way the name has to come from the mount table,
    the same way `ls` injects it.

    Session-filtered, because a crossing entry is drawn from the mount
    table alone: its row is synthesized as a directory without asking
    any backend, so the dispatcher never gets the chance to refuse it
    and an ungranted mount's name would reach the drawing. `ls` filters
    the same fact through `child_mount_names`. Note this is the opposite
    of what `du` wants from the same view: there an ungranted mount
    still shadows the parent's keys, so its prefix must stay in the
    list even though the walk never enters it.

    Args:
        mounts (MountView | None): the boundary facts.
        directory (str): absolute virtual path being listed.
    """
    if mounts is None:
        return []
    base = directory.rstrip("/")
    return [
        root for root in mounts.descendants(directory)
        if posixpath.dirname(root) == (base or "/") and mount_allowed(root)
    ]


async def _walk(
    path: PathSpec,
    readdir: Readdir,
    stat: Stat,
    *,
    prefix: str,
    depth: int,
    max_depth: int | None,
    show_hidden: bool,
    ignore_pattern: str | None,
    dirs_only: bool,
    match_pattern: str | None,
    warnings: list[str],
    index: IndexCacheStore,
    mounts: MountView | None = None,
    cross_readdir: Readdir | None = None,
    cross_stat: Stat | None = None,
) -> tuple[list[str], int, int]:
    lines: list[str] = []
    dirs = 0
    files = 0
    try:
        entries = sorted(await readdir(path, index))
    except WALK_ERRORS as exc:
        warnings.append(f"tree: '{path.raw_path}': {exc}")
        return lines, dirs, files
    child_mounts = _child_mounts(mounts, path.virtual)
    if child_mounts:
        entries = sorted(set(entries) | set(child_mounts))

    filtered: list[tuple[PathSpec, FileStat, bool]] = []
    for entry in entries:
        entry_spec = PathSpec(virtual=entry,
                              directory=entry,
                              resolved=False,
                              resource_path=rekey(path.virtual,
                                                  path.resource_path, entry))
        crossing = entry in child_mounts and cross_readdir is not None
        if crossing:
            # The mount table already says this is a directory, and the
            # backend serving it may not stat its own root (an empty
            # mount, or a prefix store with no marker object).
            s = FileStat(name=posixpath.basename(entry.rstrip("/")),
                         type=FileType.DIRECTORY)
        else:
            try:
                s = await stat(entry_spec, index)
            except WALK_ERRORS as exc:
                warnings.append(f"tree: '{entry}': {exc}")
                continue
        if not show_hidden and s.name.startswith("."):
            continue
        if ignore_pattern and fnmatch(s.name, ignore_pattern):
            continue
        if dirs_only and s.type != FileType.DIRECTORY:
            continue
        not_dir = s.type != FileType.DIRECTORY
        if match_pattern and not_dir and not fnmatch(s.name, match_pattern):
            continue
        filtered.append((entry_spec, s, crossing))

    for i, (entry_spec, s, crossing) in enumerate(filtered):
        is_last = i == len(filtered) - 1
        connector = _LAST if is_last else _BRANCH
        lines.append(prefix + connector + s.name)
        if s.type != FileType.DIRECTORY:
            files += 1
            continue
        dirs += 1
        if max_depth is not None and depth + 1 >= max_depth:
            continue
        extension = _INDENT if is_last else _VERTICAL
        # Past a mount root the subtree belongs to another resource, so
        # the rest of this branch reads through the dispatcher. Deeper
        # mounts under it need no second switch: the dispatcher already
        # routes every path to its owner.
        sub_readdir = cross_readdir if crossing and cross_readdir else readdir
        sub_stat = cross_stat if crossing and cross_stat else stat
        sub, sub_dirs, sub_files = await _walk(entry_spec,
                                               sub_readdir,
                                               sub_stat,
                                               prefix=prefix + extension,
                                               depth=depth + 1,
                                               max_depth=max_depth,
                                               show_hidden=show_hidden,
                                               ignore_pattern=ignore_pattern,
                                               dirs_only=dirs_only,
                                               match_pattern=match_pattern,
                                               warnings=warnings,
                                               index=index,
                                               mounts=mounts,
                                               cross_readdir=cross_readdir,
                                               cross_stat=cross_stat)
        lines.extend(sub)
        dirs += sub_dirs
        files += sub_files
    return lines, dirs, files


def _summary(dirs: int, files: int, dirs_only: bool) -> str:
    dir_word = "directory" if dirs == 1 else "directories"
    if dirs_only:
        return f"{dirs} {dir_word}"
    file_word = "file" if files == 1 else "files"
    return f"{dirs} {dir_word}, {files} {file_word}"


def _unopenable(root_label: str, dirs_only: bool, files: int,
                exit_code: int) -> tuple[bytes, IOResult]:
    """GNU's inline marker for a root it could not open.

    ``tree`` prints the marker and nothing on stderr, so the exit code and
    the counted file carry the distinction: a path that is not a directory
    exists and is counted (exit 0), a path that is not there is not
    (exit 2).

    Args:
        root_label (str): the operand as typed.
        dirs_only (bool): whether ``-d`` omits the file count.
        files (int): files to report in the summary.
        exit_code (int): process exit status.
    """
    body = [
        f"{root_label}  [error opening dir]", "",
        _summary(0, files, dirs_only)
    ]
    return format_records(body), IOResult(exit_code=exit_code)


async def tree(
    path: PathSpec,
    *,
    readdir: Readdir,
    stat: Stat,
    max_depth: int | None = None,
    show_hidden: bool = False,
    ignore_pattern: str | None = None,
    dirs_only: bool = False,
    match_pattern: str | None = None,
    index: IndexCacheStore = NULL_INDEX,
    stat_path: StatPath | None = None,
    readdir_path: ReaddirPath | None = None,
    mounts: MountView | None = None,
) -> tuple[bytes, IOResult]:
    """Render one directory tree, GNU ``tree``'s drawing and summary.

    Unlike find and du, tree's output is a single document: one root
    line, one drawing, one count. Concatenating a per-mount run would
    print two of each, so a nested mount is crossed here instead, the
    way real ``tree`` crosses one (pinned on tree 2.2.1: the mounted
    filesystem's entries are drawn under the mount point, the covered
    ones are not drawn at all, and the summary counts the whole thing).

    Args:
        path (PathSpec): the operand to draw.
        readdir (Readdir): this mount's directory listing.
        stat (Stat): this mount's stat.
        max_depth (int | None): -L, deepest level to draw.
        show_hidden (bool): -a.
        ignore_pattern (str | None): -I.
        dirs_only (bool): -d.
        match_pattern (str | None): -P.
        index (IndexCacheStore): listing cache for this mount.
        stat_path (StatPath | None): dispatcher-backed stat, used for the
            operand itself and for entries past a mount boundary.
        readdir_path (ReaddirPath | None): dispatcher-backed readdir,
            which is how a subtree on another mount is read at all.
        mounts (MountView | None): where the mount boundaries are.
    """
    warnings: list[str] = []
    root_label = path.raw_path or path.virtual
    # What the operand is decides the whole result, so it is resolved
    # before the walk rather than inferred from how a backend answered
    # readdir on it: an object store lists a file key as an empty prefix,
    # lists a missing path as one too, and Graph 404s, which read as
    # three different trees. The probe asks both channels a backend can
    # answer on, so a directory that exists only as its children still
    # reports as one and None means nothing is there.
    if stat_path is not None:
        start = await stat_path(path.virtual)
        if start is None:
            return _unopenable(root_label, dirs_only, 0, 2)
        if start.type != FileType.DIRECTORY:
            return _unopenable(root_label, dirs_only, 1, 0)
    cross_readdir = (partial(_cross_readdir, readdir_path)
                     if readdir_path is not None else None)
    cross_stat = (partial(_cross_stat, stat_path)
                  if stat_path is not None else None)
    lines, dirs, files = await _walk(path,
                                     readdir,
                                     stat,
                                     prefix="",
                                     depth=0,
                                     max_depth=max_depth,
                                     show_hidden=show_hidden,
                                     ignore_pattern=ignore_pattern,
                                     dirs_only=dirs_only,
                                     match_pattern=match_pattern,
                                     warnings=warnings,
                                     index=index,
                                     mounts=mounts,
                                     cross_readdir=cross_readdir,
                                     cross_stat=cross_stat)
    # GNU signals an unopenable path with the inline "[error opening dir]"
    # marker and exit 2, and writes nothing to stderr. `warnings` therefore
    # only decides the marker; emitting it would diverge. With stat_path
    # wired the two clear cases are already answered above, so this covers
    # a directory that exists but could not be read (a permission error).
    if warnings and not lines:
        return _unopenable(root_label, dirs_only, 0, 2)
    # GNU counts the root as a directory once it has any listed entry (an
    # empty root reports 0), then a blank line and the summary (the file
    # count is omitted under -d).
    root_dirs = dirs + 1 if lines else 0
    body = [root_label] + lines + ["", _summary(root_dirs, files, dirs_only)]
    return format_records(body), IOResult()


__all__ = ["tree"]


@dataclass(frozen=True, slots=True)
class TreeFlags:
    max_depth: int | None = None
    show_hidden: bool = False
    ignore_pattern: str | None = None
    dirs_only: bool = False
    match_pattern: str | None = None


def parse_flags(flags: Mapping[str, FlagValue]) -> TreeFlags:
    fl = FlagView(flags, spec=SPECS["tree"])
    depth_raw = fl.as_str("L")
    return TreeFlags(
        max_depth=int(depth_raw) if depth_raw is not None else None,
        show_hidden=fl.as_bool("a"),
        ignore_pattern=fl.as_str("args_I"),
        dirs_only=fl.as_bool("d"),
        match_pattern=fl.as_str("P"),
    )


async def tree_generic(paths, texts, opts: CommandOpts, readdir, stat):
    parsed = parse_flags(opts.flags)
    return await tree(paths[0],
                      readdir=readdir,
                      stat=stat,
                      max_depth=parsed.max_depth,
                      show_hidden=parsed.show_hidden,
                      ignore_pattern=parsed.ignore_pattern,
                      dirs_only=parsed.dirs_only,
                      match_pattern=parsed.match_pattern,
                      index=opts.index,
                      stat_path=opts.stat_path,
                      readdir_path=opts.readdir_path,
                      mounts=opts.mounts)

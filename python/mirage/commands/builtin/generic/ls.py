from collections.abc import Awaitable, Callable, Mapping
from dataclasses import asdict, dataclass, field
from typing import Any

from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.utils.formatting import format_ls_long
from mirage.commands.builtin.utils.identity import Identity, identity_of
from mirage.commands.builtin.utils.output import (format_optional_records,
                                                  format_records)
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.io.types import IOResult
from mirage.ops.types import ChildMounts, LinkView, MountView, StatPath
from mirage.types import FileStat, FileType, LsSortBy, PathSpec
from mirage.utils.errors import fs_strerror
from mirage.utils.key_prefix import rekey
from mirage.utils.path import CycleError, respell_one

Readdir = Callable[[PathSpec, IndexCacheStore | None], Awaitable[list[str]]]
Stat = Callable[[PathSpec, IndexCacheStore | None], Awaitable[FileStat]]

LS_OK = 0
LS_MINOR_PROBLEM = 1
LS_FAILURE = 2


@dataclass(frozen=True, slots=True)
class LsFlags:
    long: bool = False
    one_per_line: bool = False
    all_files: bool = False
    human: bool = False
    sort_by: LsSortBy = LsSortBy.NAME
    reverse: bool = False
    recursive: bool = False
    list_dir: bool = False
    classify: bool = False
    deref: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> LsFlags:
    fl = FlagView(flags, spec=SPECS["ls"])
    if fl.as_bool("t"):
        sort_by = LsSortBy.TIME
    elif fl.as_bool("S"):
        sort_by = LsSortBy.SIZE
    else:
        sort_by = LsSortBy.NAME
    return LsFlags(
        long=fl.as_bool("args_l"),
        one_per_line=fl.as_bool("args_1"),
        all_files=fl.as_bool("a") or fl.as_bool("A"),
        human=fl.as_bool("h"),
        sort_by=sort_by,
        reverse=fl.as_bool("r"),
        recursive=fl.as_bool("R"),
        list_dir=fl.as_bool("d"),
        classify=fl.as_bool("F"),
        deref=fl.as_bool("L"),
    )


def ls_options(flags: Mapping[str, FlagValue]) -> dict[str, Any]:
    """Parsed ls flags as the generic's own keyword arguments.

    ``LsFlags`` names every field after the ``ls`` parameter it feeds,
    so both entry points -- the single-mount ``ls_generic`` and the
    cross-mount relay -- share one mapping instead of restating it.

    Args:
        flags (Mapping[str, FlagValue]): Flags for the shared ls spec.
    """
    return asdict(parse_flags(flags))


@dataclass(frozen=True, slots=True)
class LsWarning:
    """One diagnostic plus how serious GNU ls considers it.

    Args:
        message (str): The rendered `ls: ...` stderr line.
        serious (bool): True when the failure was on a command-line operand
            (GNU exit 2); False for problems met while listing or
            recursing below an operand (GNU exit 1).
    """

    message: str
    serious: bool


@dataclass(frozen=True, slots=True)
class Operand:
    """One ls operand once its kind is known.

    ``row`` is set when the operand is not a directory: GNU prints those
    first, as one block with no header. ``groups`` holds one
    ``(dir, entries)`` pair per directory listed under the operand — one
    for a plain listing, the whole pre-order subtree under ``-R``. Both
    empty means the operand could not be accessed.
    """
    path: PathSpec
    row: FileStat | None
    groups: list[tuple[PathSpec, list[FileStat]]]


@dataclass(frozen=True, slots=True)
class WalkResult:
    """Outcome of listing one directory.

    Args:
        entries (list[FileStat]): The stats to render for this directory.
        warnings (list[LsWarning]): Diagnostics collected at or below this
            directory.
        listed (bool): False when the directory itself could not be opened, so
            callers skip emitting a `dir:` header for it.
    """

    entries: list[FileStat] = field(default_factory=list)
    warnings: list[LsWarning] = field(default_factory=list)
    listed: bool = True


def exit_status_for(warnings: list[LsWarning]) -> int:
    """Collapse diagnostics into a GNU ls exit status.

    GNU ratchets the status upward: a serious problem (bad command-line
    operand) always wins, a minor one only upgrades a clean run.

    Args:
        warnings (list[LsWarning]): Diagnostics gathered over every operand.

    Returns:
        0 when clean, 1 for minor problems only, 2 if any was serious.
    """
    if any(w.serious for w in warnings):
        return LS_FAILURE
    return LS_MINOR_PROBLEM if warnings else LS_OK


# GNU -F suffixes: a directory gets "/", a symlink "@". The link mark
# rides the row's type, so it needs no separate lookup.
_CLASSIFY_SUFFIX = {FileType.DIRECTORY: "/", FileType.SYMLINK: "@"}


def format_simple(entries: list[FileStat],
                  *,
                  classify: bool = False) -> list[str]:
    out: list[str] = []
    for e in entries:
        suffix = ""
        if classify and e.type is not None:
            suffix = _CLASSIFY_SUFFIX.get(e.type, "")
        out.append(e.name + suffix)
    return out


def _primary_value(entry: FileStat, sort_by: LsSortBy) -> str | int:
    if sort_by is LsSortBy.TIME:
        return entry.modified or ""
    if sort_by is LsSortBy.SIZE:
        return entry.size or 0
    return entry.name


def _order_rows(rows: list[FileStat], sort_by: LsSortBy,
                reverse: bool) -> list[int]:
    """Indices of ``rows`` in GNU ls order.

    GNU's `-t`/`-S` comparators fall back to the name when the timestamps or
    sizes tie, and `-r` negates the whole comparison, tie-break included. A
    stable name sort followed by the primary key reproduces the first half;
    reversing the finished order reproduces the second.

    Args:
        rows (list[FileStat]): The stats to order.
        sort_by (LsSortBy): The active sort key.
        reverse (bool): Whether `-r` is in effect.
    """
    order = sorted(range(len(rows)), key=lambda i: rows[i].name)
    if sort_by is not LsSortBy.NAME:
        # -t and -S list newest/largest first.
        order.sort(key=lambda i: _primary_value(rows[i], sort_by),
                   reverse=True)
    if reverse:
        order.reverse()
    return order


def sort_stats(entries: list[FileStat], sort_by: LsSortBy,
               reverse: bool) -> list[FileStat]:
    return [entries[i] for i in _order_rows(entries, sort_by, reverse)]


async def _file_entry(
    path: PathSpec,
    stat: Stat,
    index: IndexCacheStore,
) -> FileStat | None:
    try:
        s = await stat(path, index)
    except (OSError, ValueError):
        return None
    if s.type == FileType.DIRECTORY:
        return None
    # GNU ls prints a file operand as given (`ls sub/x.txt` shows
    # sub/x.txt, not x.txt); the row carries the operand spelling.
    return s.model_copy(update={"name": path.raw_path})


async def _deref_entry(
    directory: PathSpec,
    link: FileStat,
    links: LinkView,
    stat: Stat,
    index: IndexCacheStore,
) -> FileStat | None:
    """The target's stat for a link child under -L, or None if unreadable.

    GNU ``ls -L`` reports the referenced file while keeping the link's
    own name, so a dangling link falls back to the link row rather than
    dropping out of the listing.

    Args:
        directory (PathSpec): the directory being listed.
        link (FileStat): the link's own row, whose name is kept.
        links (LinkView): the namespace's symlink facts.
        stat (Stat): backend stat.
        index (IndexCacheStore): listing cache.
    """
    child = directory.virtual.rstrip("/") + "/" + link.name
    try:
        target = links.resolve(child)
    except CycleError:
        return None
    spec = PathSpec(virtual=target,
                    directory=target,
                    resolved=False,
                    resource_path=rekey(directory.virtual,
                                        directory.resource_path, target))
    try:
        return (await stat(spec, index)).model_copy(update={"name": link.name})
    except (OSError, ValueError):
        return None


def _link_row(path: PathSpec, links: LinkView | None) -> FileStat | None:
    """The row for an operand that is itself a symlink, else None.

    A link has no backend inode, so readdir and stat both fail on one;
    without this a link operand reads as a missing file, and a dangling
    link fails the whole listing (GNU prints its row and exits 0).
    Named with the operand's own spelling, like every other ls row.

    Args:
        path (PathSpec): the operand being listed.
        links (LinkView | None): the namespace's symlink facts.
    """
    if links is None:
        return None
    row = links.stat_at(path.virtual)
    if row is None:
        return None
    return row.model_copy(update={"name": path.raw_path})


def _child_spec(path: PathSpec, name: str) -> PathSpec:
    child = path.child(name)
    return PathSpec(virtual=child,
                    directory=child,
                    resolved=False,
                    resource_path=rekey(path.virtual, path.resource_path,
                                        child))


async def _mount_row(
    directory: PathSpec,
    name: str,
    stat_path: StatPath | None,
) -> FileStat:
    """The row for a child mount, carrying its real type.

    No backend can supply it: the parent's cannot see into the child
    mount, and the child's own answers its root with that mount's name
    for itself (``/``), which is why the row is renamed here the way the
    relay renames one. So the fact comes through the dispatcher, which
    routes to whichever mount owns the path.

    A mount root is not always a directory -- every workspace mounts
    ``/.bash_history`` as a whole mount serving one file -- and calling
    one a directory suffixes it with ``/`` under ``-F``, renders it
    ``drwxr-xr-x`` under ``-l``, and offers it to ``-R`` as something to
    descend. GNU lists a file that happens to be a mountpoint as an
    ordinary file row (pinned on coreutils 9.7 over a ``mount --bind``
    of one file onto another). Directory is the fallback for a caller
    with no dispatcher, which is the only thing that absence can mean.

    Args:
        directory (PathSpec): the directory being listed.
        name (str): the child's own name.
        stat_path (StatPath | None): dispatcher-backed stat of one path.
    """
    if stat_path is not None:
        row = await stat_path(directory.child(name))
        if row is not None:
            return row.model_copy(update={"name": name})
    return FileStat(name=name, type=FileType.DIRECTORY)


async def _stat_entries(
    path: PathSpec,
    names: list[str],
    *,
    stat: Stat,
    all_files: bool,
    index: IndexCacheStore,
    links: LinkView | None = None,
    deref: bool = False,
    child_mounts: ChildMounts | None = None,
    stat_path: StatPath | None = None,
) -> tuple[list[FileStat], list[LsWarning]]:
    """Stat every name in a directory, plus the symlinks living there.

    Args:
        path (PathSpec): the directory being listed.
        names (list[str]): entry paths from the backend readdir.
        stat (Stat): backend stat.
        all_files (bool): keep dotfiles.
        index (IndexCacheStore): listing cache.
        links (LinkView | None): the namespace's symlink facts. Links
            have no backend inode, so readdir never names them; merging
            here means every caller (plain, -R, -F, -l, sorting) sees
            them without knowing they are special.
        deref (bool): -L, report the target's stat under the link's own
            name instead of the link row. A dereferenced directory link
            then carries FileType.DIRECTORY, which is what makes -R
            descend it.
        child_mounts (ChildMounts | None): session-filtered child-mount
            names under a directory. A nested mount is namespace
            structure the backend readdir cannot name, merged here like
            a link row. GNU lists a mountpoint as an ordinary entry of
            its parent, so the merge is unconditional: withholding it
            under ``-R`` dropped the row whenever the parent's backend
            held no key of that name.
        stat_path (StatPath | None): dispatcher-backed stat, which is
            the only way to learn a child mount's real type. See
            ``_mount_row``.
    """
    stats: list[FileStat] = []
    warnings: list[LsWarning] = []
    for entry in names:
        entry_spec = PathSpec(virtual=entry,
                              directory=entry,
                              resolved=False,
                              resource_path=rekey(path.virtual,
                                                  path.resource_path, entry))
        try:
            s = await stat(entry_spec, index)
        except (OSError, ValueError) as exc:
            # An entry below an operand is never a command-line arg, so
            # GNU treats it as a minor problem (exit 1).
            warnings.append(
                LsWarning(
                    f"ls: cannot access '{entry}': {fs_strerror(exc) or exc}",
                    False))
            continue
        if not all_files and s.name.startswith("."):
            continue
        stats.append(s)
    seen = {s.name for s in stats}
    for link in (links.children(path.virtual) if links is not None else []):
        if link.name in seen:
            continue
        if not all_files and link.name.startswith("."):
            continue
        seen.add(link.name)
        resolved = (await _deref_entry(path, link, links, stat, index)
                    if deref and links is not None else None)
        stats.append(resolved if resolved is not None else link)
    for name in (child_mounts(path.virtual)
                 if child_mounts is not None else []):
        if name in seen:
            continue
        if not all_files and name.startswith("."):
            continue
        seen.add(name)
        stats.append(await _mount_row(path, name, stat_path))
    return stats, warnings


async def probe_operand(
    path: PathSpec,
    *,
    readdir: Readdir,
    stat: Stat,
    all_files: bool = False,
    sort_by: LsSortBy = LsSortBy.NAME,
    reverse: bool = False,
    recursive: bool = False,
    command_line_arg: bool = True,
    index: IndexCacheStore = NULL_INDEX,
    links: LinkView | None = None,
    deref: bool = False,
    child_mounts: ChildMounts | None = None,
    mounts: MountView | None = None,
    stat_path: StatPath | None = None,
) -> tuple[Operand, list[LsWarning]]:
    """List one operand and report whether it turned out to be a directory.

    Args:
        path (PathSpec): the operand to list.
        readdir (Readdir): backend directory lister.
        stat (Stat): backend stat.
        all_files (bool): keep dotfiles.
        sort_by (LsSortBy): active sort key.
        reverse (bool): reverse the sort.
        recursive (bool): descend, emitting one group per directory (-R).
        command_line_arg (bool): False below an operand, where GNU downgrades
            a failure to a minor problem (exit 1).
        index (IndexCacheStore): listing cache.
        links (LinkView | None): the namespace's symlink facts.
        child_mounts (ChildMounts | None): session-filtered child-mount
            names, merged into every listing: a mountpoint is an
            ordinary directory entry of its parent, ``-R`` or not.
        mounts (MountView | None): the mount boundaries this walk's
            ``readdir`` cannot cross. Under ``-R`` such a root is listed
            but never descended, because that listing is another
            backend's and the cross-mount fan-out assembles the group;
            a namespace-only directory *above* one is descended, since
            no other run renders it. None for a walk that can cross --
            the relay's readdir routes per path, so it descends a
            nested mount itself.
        stat_path (StatPath | None): dispatcher-backed stat, for the
            child-mount rows no backend can supply.
    """
    warnings: list[LsWarning] = []
    structure_only = False
    try:
        names = await readdir(path, index)
    except (OSError, ValueError) as exc:
        row = await _file_entry(path, stat, index)
        if row is not None:
            return Operand(path, row, []), warnings
        link_row = _link_row(path, links)
        if link_row is not None:
            return Operand(path, link_row, []), warnings
        if child_mounts is None or not child_mounts(path.virtual):
            # GNU words a directory it may not read differently from
            # one it cannot stat: the entry is there, opening it is
            # what failed.
            verb = ("cannot open directory" if isinstance(
                exc, PermissionError) else "cannot access")
            warnings.append(
                LsWarning(
                    f"ls: {verb} '{path.raw_path}': "
                    f"{fs_strerror(exc) or exc}", command_line_arg))
            return Operand(path, None, []), warnings
        # No backend serves it, but the namespace owes it children (a
        # nested mount, a link's ancestors), so the door lists it as a
        # directory and ls must agree: the merge below renders those
        # rows from an empty backend listing.
        names = []
        structure_only = True

    if not names and not structure_only:
        row = await _file_entry(path, stat, index)
        if row is not None:
            return Operand(path, row, []), warnings
        # Backends without real directories answer readdir on a link
        # with an empty list instead of raising, so the link operand has
        # to be caught here too or it renders as an empty directory.
        link_row = _link_row(path, links)
        if link_row is not None:
            return Operand(path, link_row, []), warnings

    entries, entry_ws = await _stat_entries(path,
                                            names,
                                            stat=stat,
                                            all_files=all_files,
                                            index=index,
                                            links=links,
                                            deref=deref,
                                            child_mounts=child_mounts,
                                            stat_path=stat_path)
    warnings.extend(entry_ws)
    entries = sort_stats(entries, sort_by, reverse)
    groups: list[tuple[PathSpec, list[FileStat]]] = [(path, entries)]
    if recursive:
        for entry in entries:
            if entry.type != FileType.DIRECTORY:
                continue
            child_path = _child_spec(path, entry.name)
            if mounts is not None and mounts.is_root(child_path.virtual):
                # A nested mount's root. Its row belongs here, but its
                # listing is another backend's, which this walk cannot
                # read: the cross-mount fan-out renders that group.
                continue
            child, child_ws = await probe_operand(child_path,
                                                  readdir=readdir,
                                                  stat=stat,
                                                  all_files=all_files,
                                                  sort_by=sort_by,
                                                  reverse=reverse,
                                                  recursive=True,
                                                  command_line_arg=False,
                                                  index=index,
                                                  links=links,
                                                  deref=deref,
                                                  child_mounts=child_mounts,
                                                  mounts=mounts,
                                                  stat_path=stat_path)
            groups.extend(child.groups)
            warnings.extend(child_ws)
    return Operand(path, None, groups), warnings


async def walk(
    path: PathSpec,
    *,
    readdir: Readdir,
    stat: Stat,
    all_files: bool = False,
    sort_by: LsSortBy = LsSortBy.NAME,
    reverse: bool = False,
    recursive: bool = False,
    list_dir: bool = False,
    command_line_arg: bool = True,
    index: IndexCacheStore = NULL_INDEX,
    links: LinkView | None = None,
    deref: bool = False,
    child_mounts: ChildMounts | None = None,
    mounts: MountView | None = None,
    stat_path: StatPath | None = None,
) -> WalkResult:
    """Flat listing for one operand: a directory's entries, or the operand
    itself when it is not one. ``recursive`` flattens the whole subtree in
    ``ls -R`` order.

    Args:
        path (PathSpec): the operand to list.
        readdir (Readdir): backend directory lister.
        stat (Stat): backend stat.
        all_files (bool): keep dotfiles.
        sort_by (LsSortBy): active sort key.
        reverse (bool): reverse the sort.
        recursive (bool): descend into subdirectories.
        list_dir (bool): stat the operand itself instead of listing it (-d).
        command_line_arg (bool): False below an operand, where GNU downgrades
            a failure to a minor problem (exit 1).
        index (IndexCacheStore): listing cache.
        links (LinkView | None): the namespace's symlink facts.
        child_mounts (ChildMounts | None): session-filtered child-mount
            names to merge into a directory listing.
        mounts (MountView | None): the boundaries this walk's readdir
            cannot cross, so ``-R`` lists a nested mount's root without
            descending it.
        stat_path (StatPath | None): dispatcher-backed stat, for the
            child-mount rows no backend can supply.
    """
    if list_dir:
        link_row = _link_row(path, links)
        if link_row is not None:
            return WalkResult([link_row])
        try:
            listed = await stat(path, index)
        except (OSError, ValueError) as exc:
            if child_mounts is not None and child_mounts(path.virtual):
                # No backend serves it, but the namespace owes it
                # children, so the door stats it as a directory and -d
                # must print the same row.
                return WalkResult(
                    [FileStat(name=path.raw_path, type=FileType.DIRECTORY)])
            detail = fs_strerror(exc) or exc
            return WalkResult(warnings=[
                LsWarning(f"ls: cannot access '{path.raw_path}': {detail}",
                          command_line_arg)
            ],
                              listed=False)
        # GNU ls -d prints the operand as given.
        return WalkResult([listed.model_copy(update={"name": path.raw_path})])

    operand, warnings = await probe_operand(path,
                                            readdir=readdir,
                                            stat=stat,
                                            all_files=all_files,
                                            sort_by=sort_by,
                                            reverse=reverse,
                                            recursive=recursive,
                                            command_line_arg=command_line_arg,
                                            index=index,
                                            links=links,
                                            deref=deref,
                                            child_mounts=child_mounts,
                                            mounts=mounts,
                                            stat_path=stat_path)
    if operand.row is not None:
        return WalkResult([operand.row], warnings)
    entries = [e for _, group in operand.groups for e in group]
    return WalkResult(entries, warnings, listed=bool(operand.groups))


async def _operand_key(
    operand: Operand,
    *,
    sort_by: LsSortBy,
    stat: Stat,
    index: IndexCacheStore,
) -> FileStat:
    """Sort row for one operand, named with the operand's own spelling."""
    if operand.row is not None:
        return operand.row
    if sort_by is LsSortBy.NAME:
        return FileStat(name=operand.path.raw_path, type=FileType.DIRECTORY)
    try:
        s = await stat(operand.path, index)
    except (OSError, ValueError):
        # The stat only supplies a sort key; an operand that cannot be
        # statted sorts as if it had none rather than failing the listing.
        return FileStat(name=operand.path.raw_path, type=FileType.DIRECTORY)
    return s.model_copy(update={"name": operand.path.raw_path})


async def _sorted_operands(
    operands: list[Operand],
    *,
    sort_by: LsSortBy,
    reverse: bool,
    stat: Stat,
    index: IndexCacheStore,
) -> list[Operand]:
    keys = [
        await _operand_key(o, sort_by=sort_by, stat=stat, index=index)
        for o in operands
    ]
    return [operands[i] for i in _order_rows(keys, sort_by, reverse)]


def _render_group(
    results: list[str],
    entries: list[FileStat],
    *,
    long: bool,
    one_per_line: bool,
    human: bool,
    classify: bool,
    identity: Identity | None,
) -> None:
    if long and not one_per_line:
        results.extend(format_ls_long(entries, human=human, identity=identity))
    else:
        results.extend(format_simple(entries, classify=classify))


def _finish(results: list[str],
            warnings: list[LsWarning]) -> tuple[bytes, IOResult]:
    stderr = format_optional_records([w.message for w in warnings])
    return format_records(results), IOResult(
        stderr=stderr, exit_code=exit_status_for(warnings))


async def ls(
    paths: list[PathSpec],
    *,
    readdir: Readdir,
    stat: Stat,
    long: bool = False,
    one_per_line: bool = False,
    all_files: bool = False,
    human: bool = False,
    sort_by: LsSortBy = LsSortBy.NAME,
    reverse: bool = False,
    recursive: bool = False,
    list_dir: bool = False,
    classify: bool = False,
    index: IndexCacheStore = NULL_INDEX,
    links: LinkView | None = None,
    deref: bool = False,
    child_mounts: ChildMounts | None = None,
    mounts: MountView | None = None,
    stat_path: StatPath | None = None,
    identity: Identity | None = None,
) -> tuple[bytes, IOResult]:
    results: list[str] = []
    warnings: list[LsWarning] = []

    if list_dir:
        # -d turns every operand into a plain row, sorted together and
        # printed with no headers.
        rows: list[FileStat] = []
        for p in paths:
            result = await walk(p,
                                readdir=readdir,
                                stat=stat,
                                list_dir=True,
                                index=index,
                                links=links,
                                deref=deref,
                                child_mounts=child_mounts,
                                mounts=mounts,
                                stat_path=stat_path)
            rows.extend(result.entries)
            warnings.extend(result.warnings)
        if len(rows) > 1:
            rows = sort_stats(rows, sort_by, reverse)
        _render_group(results,
                      rows,
                      long=long,
                      one_per_line=one_per_line,
                      human=human,
                      classify=classify,
                      identity=identity)
        return _finish(results, warnings)

    operands: list[Operand] = []
    for p in paths:
        operand, p_ws = await probe_operand(p,
                                            readdir=readdir,
                                            stat=stat,
                                            all_files=all_files,
                                            sort_by=sort_by,
                                            reverse=reverse,
                                            recursive=recursive,
                                            index=index,
                                            links=links,
                                            deref=deref,
                                            child_mounts=child_mounts,
                                            mounts=mounts,
                                            stat_path=stat_path)
        warnings.extend(p_ws)
        operands.append(operand)
    if len(operands) > 1:
        operands = await _sorted_operands(operands,
                                          sort_by=sort_by,
                                          reverse=reverse,
                                          stat=stat,
                                          index=index)

    # GNU names every listed directory once there is more than one operand
    # (or under -R); a lone directory operand is listed bare.
    headed = recursive or len(paths) > 1
    rows = [o.row for o in operands if o.row is not None]
    _render_group(results,
                  rows,
                  long=long,
                  one_per_line=one_per_line,
                  human=human,
                  classify=classify,
                  identity=identity)
    printed = bool(rows)
    for operand in operands:
        for dir_spec, entries in operand.groups:
            if headed:
                if printed:
                    results.append("")
                header = respell_one(dir_spec.virtual, operand.path.virtual,
                                     operand.path.raw_path)
                results.append(f"{header}:")
            _render_group(results,
                          entries,
                          long=long,
                          one_per_line=one_per_line,
                          human=human,
                          classify=classify,
                          identity=identity)
            printed = True

    return _finish(results, warnings)


async def ls_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    readdir: Readdir,
    stat: Stat,
) -> tuple[bytes, IOResult]:
    """Run ls over resolved operands, GNU semantics; mirrors lsGeneric.

    The wiring resolves globs, defaults the operands from the cwd, and
    binds the backend ops (including the stat overlay); flag semantics
    live here, and the namespace facts (links, child mounts), the
    identity the owner columns render, and the index ride ``opts``.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, cwd-defaulted.
        texts (list[str]): Non-path words, unused by ls.
        opts (CommandOpts): Flags and namespace facts from the
            dispatcher.
        readdir (Readdir): Bound readdir called as ``readdir(p, index)``.
        stat (Stat): Bound (overlaid) stat called as ``stat(p, index)``.
    """
    return await ls(
        paths,
        readdir=readdir,
        stat=stat,
        index=opts.index,
        links=opts.ns.links if opts.ns is not None else None,
        child_mounts=opts.ns.child_mounts if opts.ns is not None else None,
        mounts=opts.ns.mounts if opts.ns is not None else None,
        stat_path=opts.stat_path,
        identity=identity_of(opts),
        **ls_options(opts.flags))


__all__ = [
    "LS_FAILURE",
    "LS_MINOR_PROBLEM",
    "LS_OK",
    "LsWarning",
    "Operand",
    "WalkResult",
    "exit_status_for",
    "format_simple",
    "ls",
    "ls_generic",
    "probe_operand",
    "sort_stats",
    "walk",
]

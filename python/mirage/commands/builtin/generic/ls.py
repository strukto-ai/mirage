from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.utils.formatting import format_ls_long
from mirage.commands.builtin.utils.output import (format_optional_records,
                                                  format_records)
from mirage.io.types import IOResult
from mirage.types import FileStat, FileType, LsSortBy, PathSpec
from mirage.utils.errors import fs_strerror
from mirage.utils.key_prefix import rekey
from mirage.utils.path import rebase_one

Readdir = Callable[[PathSpec, IndexCacheStore | None], Awaitable[list[str]]]
Stat = Callable[[PathSpec, IndexCacheStore | None], Awaitable[FileStat]]

LS_OK = 0
LS_MINOR_PROBLEM = 1
LS_FAILURE = 2


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


def format_simple(entries: list[FileStat],
                  *,
                  classify: bool = False) -> list[str]:
    out: list[str] = []
    for e in entries:
        is_dir = classify and e.type == FileType.DIRECTORY
        out.append(e.name + "/" if is_dir else e.name)
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


def _child_spec(path: PathSpec, name: str) -> PathSpec:
    child = path.child(name)
    return PathSpec(virtual=child,
                    directory=child,
                    resolved=False,
                    resource_path=rekey(path.virtual, path.resource_path,
                                        child))


async def _stat_entries(
    path: PathSpec,
    names: list[str],
    *,
    stat: Stat,
    all_files: bool,
    index: IndexCacheStore,
) -> tuple[list[FileStat], list[LsWarning]]:
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
    """
    warnings: list[LsWarning] = []
    try:
        names = await readdir(path, index)
    except (OSError, ValueError) as exc:
        row = await _file_entry(path, stat, index)
        if row is not None:
            return Operand(path, row, []), warnings
        warnings.append(
            LsWarning(
                f"ls: cannot access '{path.raw_path}': "
                f"{fs_strerror(exc) or exc}", command_line_arg))
        return Operand(path, None, []), warnings

    if not names:
        row = await _file_entry(path, stat, index)
        if row is not None:
            return Operand(path, row, []), warnings

    entries, entry_ws = await _stat_entries(path,
                                            names,
                                            stat=stat,
                                            all_files=all_files,
                                            index=index)
    warnings.extend(entry_ws)
    entries = sort_stats(entries, sort_by, reverse)
    groups: list[tuple[PathSpec, list[FileStat]]] = [(path, entries)]
    if recursive:
        for entry in entries:
            if entry.type != FileType.DIRECTORY:
                continue
            child, child_ws = await probe_operand(_child_spec(
                path, entry.name),
                                                  readdir=readdir,
                                                  stat=stat,
                                                  all_files=all_files,
                                                  sort_by=sort_by,
                                                  reverse=reverse,
                                                  recursive=True,
                                                  command_line_arg=False,
                                                  index=index)
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
    """
    if list_dir:
        try:
            listed = await stat(path, index)
        except (OSError, ValueError) as exc:
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
                                            index=index)
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
) -> None:
    if long and not one_per_line:
        results.extend(format_ls_long(entries, human=human))
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
                                index=index)
            rows.extend(result.entries)
            warnings.extend(result.warnings)
        if len(rows) > 1:
            rows = sort_stats(rows, sort_by, reverse)
        _render_group(results,
                      rows,
                      long=long,
                      one_per_line=one_per_line,
                      human=human,
                      classify=classify)
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
                                            index=index)
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
                  classify=classify)
    printed = bool(rows)
    for operand in operands:
        for dir_spec, entries in operand.groups:
            if headed:
                if printed:
                    results.append("")
                header = rebase_one(dir_spec.virtual, operand.path.virtual,
                                    operand.path.raw_path)
                results.append(f"{header}:")
            _render_group(results,
                          entries,
                          long=long,
                          one_per_line=one_per_line,
                          human=human,
                          classify=classify)
            printed = True

    return _finish(results, warnings)


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
    "probe_operand",
    "sort_stats",
    "walk",
]

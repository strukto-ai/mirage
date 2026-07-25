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


async def _file_entry(
    path: PathSpec,
    stat: Callable[[PathSpec, IndexCacheStore | None], Awaitable[FileStat]],
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


async def walk(
    path: PathSpec,
    *,
    readdir: Callable[[PathSpec, IndexCacheStore | None],
                      Awaitable[list[str]]],
    stat: Callable[[PathSpec, IndexCacheStore | None], Awaitable[FileStat]],
    all_files: bool = False,
    sort_by: LsSortBy = LsSortBy.NAME,
    reverse: bool = False,
    recursive: bool = False,
    list_dir: bool = False,
    command_line_arg: bool = True,
    index: IndexCacheStore = NULL_INDEX,
) -> WalkResult:
    warnings: list[LsWarning] = []
    if list_dir:
        try:
            listed = await stat(path, index)
        except (OSError, ValueError) as exc:
            detail = fs_strerror(exc) or exc
            warnings.append(
                LsWarning(f"ls: cannot access '{path.raw_path}': {detail}",
                          command_line_arg))
            return WalkResult(warnings=warnings, listed=False)
        # GNU ls -d prints the operand as given.
        return WalkResult([listed.model_copy(update={"name": path.raw_path})],
                          warnings)

    try:
        entries = await readdir(path, index)
    except (OSError, ValueError) as exc:
        file_entry = await _file_entry(path, stat, index)
        if file_entry is not None:
            return WalkResult([file_entry], warnings)
        warnings.append(
            LsWarning(
                f"ls: cannot access '{path.raw_path}': "
                f"{fs_strerror(exc) or exc}", command_line_arg))
        return WalkResult(warnings=warnings, listed=False)

    if not entries:
        file_entry = await _file_entry(path, stat, index)
        if file_entry is not None:
            return WalkResult([file_entry], warnings)

    stats: list[FileStat] = []
    for entry in entries:
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

    if sort_by is LsSortBy.TIME:
        stats.sort(key=lambda s: s.modified or "", reverse=not reverse)
    elif sort_by is LsSortBy.SIZE:
        stats.sort(key=lambda s: s.size or 0, reverse=not reverse)
    else:
        stats.sort(key=lambda s: s.name, reverse=reverse)

    if recursive:
        nested: list[FileStat] = []
        for s in stats:
            nested.append(s)
            if s.type == FileType.DIRECTORY:
                child_path = path.child(s.name)
                child_spec = PathSpec(virtual=child_path,
                                      directory=child_path,
                                      resolved=False,
                                      resource_path=rekey(
                                          path.virtual, path.resource_path,
                                          child_path))
                sub = await walk(child_spec,
                                 readdir=readdir,
                                 stat=stat,
                                 all_files=all_files,
                                 sort_by=sort_by,
                                 reverse=reverse,
                                 recursive=True,
                                 list_dir=False,
                                 command_line_arg=False,
                                 index=index)
                nested.extend(sub.entries)
                warnings.extend(sub.warnings)
        stats = nested

    return WalkResult(stats, warnings)


async def walk_grouped(
    path: PathSpec,
    *,
    readdir: Callable[[PathSpec, IndexCacheStore | None],
                      Awaitable[list[str]]],
    stat: Callable[[PathSpec, IndexCacheStore | None], Awaitable[FileStat]],
    all_files: bool = False,
    sort_by: LsSortBy = LsSortBy.NAME,
    reverse: bool = False,
    command_line_arg: bool = True,
    index: IndexCacheStore = NULL_INDEX,
) -> tuple[list[tuple[PathSpec, list[FileStat]]], list[LsWarning]]:
    """Recursive walk that returns one (dir, entries) group per directory
    visited, in pre-order. Mirrors GNU `ls -R` output structure.
    """
    groups: list[tuple[PathSpec, list[FileStat]]] = []
    warnings: list[LsWarning] = []
    result = await walk(path,
                        readdir=readdir,
                        stat=stat,
                        all_files=all_files,
                        sort_by=sort_by,
                        reverse=reverse,
                        recursive=False,
                        list_dir=False,
                        command_line_arg=command_line_arg,
                        index=index)
    here = result.entries
    warnings.extend(result.warnings)
    # GNU prints no `dir:` header for a directory it could not open.
    if not result.listed:
        return groups, warnings
    groups.append((path, here))
    for s in here:
        if s.type == FileType.DIRECTORY:
            child_path = path.child(s.name)
            child_spec = PathSpec(virtual=child_path,
                                  directory=child_path,
                                  resolved=False,
                                  resource_path=rekey(path.virtual,
                                                      path.resource_path,
                                                      child_path))
            sub_groups, sub_ws2 = await walk_grouped(child_spec,
                                                     readdir=readdir,
                                                     stat=stat,
                                                     all_files=all_files,
                                                     sort_by=sort_by,
                                                     reverse=reverse,
                                                     command_line_arg=False,
                                                     index=index)
            groups.extend(sub_groups)
            warnings.extend(sub_ws2)
    return groups, warnings


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


async def ls(
    paths: list[PathSpec],
    *,
    readdir: Callable[[PathSpec, IndexCacheStore | None],
                      Awaitable[list[str]]],
    stat: Callable[[PathSpec, IndexCacheStore | None], Awaitable[FileStat]],
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

    if recursive and not list_dir:
        for p in paths:
            groups, sub_ws = await walk_grouped(p,
                                                readdir=readdir,
                                                stat=stat,
                                                all_files=all_files,
                                                sort_by=sort_by,
                                                reverse=reverse,
                                                index=index)
            warnings.extend(sub_ws)
            for dir_spec, entries in groups:
                # An operand that could not be opened renders no group, so
                # the separator keys off what was actually emitted.
                if results:
                    results.append("")
                header = rebase_one(dir_spec.virtual, p.virtual, p.raw_path)
                results.append(f"{header}:")
                _render_group(results,
                              entries,
                              long=long,
                              one_per_line=one_per_line,
                              human=human,
                              classify=classify)
    else:
        for p in paths:
            result = await walk(p,
                                readdir=readdir,
                                stat=stat,
                                all_files=all_files,
                                sort_by=sort_by,
                                reverse=reverse,
                                recursive=False,
                                list_dir=list_dir,
                                index=index)
            warnings.extend(result.warnings)
            _render_group(results,
                          result.entries,
                          long=long,
                          one_per_line=one_per_line,
                          human=human,
                          classify=classify)

    output = format_records(results)
    stderr = format_optional_records([w.message for w in warnings])
    return output, IOResult(stderr=stderr, exit_code=exit_status_for(warnings))


__all__ = [
    "LS_FAILURE",
    "LS_MINOR_PROBLEM",
    "LS_OK",
    "LsWarning",
    "WalkResult",
    "exit_status_for",
    "format_simple",
    "ls",
    "walk",
    "walk_grouped",
]

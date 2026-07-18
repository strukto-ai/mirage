from collections.abc import Awaitable, Callable

from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.utils.formatting import format_ls_long
from mirage.commands.builtin.utils.output import (format_optional_records,
                                                  format_records)
from mirage.io.types import IOResult
from mirage.types import FileStat, FileType, LsSortBy, PathSpec
from mirage.utils.errors import fs_strerror
from mirage.utils.key_prefix import rekey
from mirage.utils.path import rebase_one


def get_extension(name: str) -> str | None:
    dot = name.rfind(".")
    if dot == -1 or "/" in name[dot:]:
        return None
    return name[dot:]


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
    except (FileNotFoundError, ValueError):
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
    index: IndexCacheStore = NULL_INDEX,
) -> tuple[list[FileStat], list[str]]:
    warnings: list[str] = []
    if list_dir:
        try:
            listed = await stat(path, index)
        except (FileNotFoundError, ValueError) as exc:
            detail = fs_strerror(exc) or exc
            warnings.append(f"ls: cannot access '{path.raw_path}': {detail}")
            return [], warnings
        # GNU ls -d prints the operand as given.
        return [listed.model_copy(update={"name": path.raw_path})], warnings

    try:
        entries = await readdir(path, index)
    except (FileNotFoundError, ValueError, NotADirectoryError) as exc:
        file_entry = await _file_entry(path, stat, index)
        if file_entry is not None:
            return [file_entry], warnings
        warnings.append(
            f"ls: cannot access '{path.raw_path}': {fs_strerror(exc) or exc}")
        return [], warnings

    if not entries:
        file_entry = await _file_entry(path, stat, index)
        if file_entry is not None:
            return [file_entry], warnings

    stats: list[FileStat] = []
    for entry in entries:
        entry_spec = PathSpec(virtual=entry,
                              directory=entry,
                              resolved=False,
                              resource_path=rekey(path.virtual,
                                                  path.resource_path, entry))
        try:
            s = await stat(entry_spec, index)
        except (FileNotFoundError, ValueError) as exc:
            warnings.append(
                f"ls: cannot access '{entry}': {fs_strerror(exc) or exc}")
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
                sub, sub_ws = await walk(child_spec,
                                         readdir=readdir,
                                         stat=stat,
                                         all_files=all_files,
                                         sort_by=sort_by,
                                         reverse=reverse,
                                         recursive=True,
                                         list_dir=False,
                                         index=index)
                nested.extend(sub)
                warnings.extend(sub_ws)
        stats = nested

    return stats, warnings


async def walk_grouped(
    path: PathSpec,
    *,
    readdir: Callable[[PathSpec, IndexCacheStore | None],
                      Awaitable[list[str]]],
    stat: Callable[[PathSpec, IndexCacheStore | None], Awaitable[FileStat]],
    all_files: bool = False,
    sort_by: LsSortBy = LsSortBy.NAME,
    reverse: bool = False,
    index: IndexCacheStore = NULL_INDEX,
) -> tuple[list[tuple[PathSpec, list[FileStat]]], list[str]]:
    """Recursive walk that returns one (dir, entries) group per directory
    visited, in pre-order. Mirrors GNU `ls -R` output structure.
    """
    groups: list[tuple[PathSpec, list[FileStat]]] = []
    warnings: list[str] = []
    here, sub_ws = await walk(path,
                              readdir=readdir,
                              stat=stat,
                              all_files=all_files,
                              sort_by=sort_by,
                              reverse=reverse,
                              recursive=False,
                              list_dir=False,
                              index=index)
    warnings.extend(sub_ws)
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
    warnings: list[str] = []

    if recursive and not list_dir:
        for p_idx, p in enumerate(paths):
            groups, sub_ws = await walk_grouped(p,
                                                readdir=readdir,
                                                stat=stat,
                                                all_files=all_files,
                                                sort_by=sort_by,
                                                reverse=reverse,
                                                index=index)
            warnings.extend(sub_ws)
            for g_idx, (dir_spec, entries) in enumerate(groups):
                if p_idx > 0 or g_idx > 0:
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
            entries, sub_ws = await walk(p,
                                         readdir=readdir,
                                         stat=stat,
                                         all_files=all_files,
                                         sort_by=sort_by,
                                         reverse=reverse,
                                         recursive=False,
                                         list_dir=list_dir,
                                         index=index)
            warnings.extend(sub_ws)
            _render_group(results,
                          entries,
                          long=long,
                          one_per_line=one_per_line,
                          human=human,
                          classify=classify)

    output = format_records(results)
    stderr = format_optional_records(warnings)
    exit_code = 1 if warnings and not results else 0
    return output, IOResult(stderr=stderr, exit_code=exit_code)


__all__ = [
    "format_simple",
    "get_extension",
    "ls",
    "walk",
    "walk_grouped",
]

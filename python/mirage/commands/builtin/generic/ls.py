from collections.abc import Awaitable, Callable

from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.utils.formatting import format_ls_long
from mirage.io.types import IOResult
from mirage.types import FileStat, FileType, LsSortBy, PathSpec


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


async def walk(
    path: PathSpec,
    *,
    readdir: Callable[[PathSpec, IndexCacheStore | None],
                      Awaitable[list[str]]],
    stat: Callable[[PathSpec], Awaitable[FileStat]],
    all_files: bool = False,
    sort_by: LsSortBy = LsSortBy.NAME,
    reverse: bool = False,
    recursive: bool = False,
    list_dir: bool = False,
    index: IndexCacheStore | None = None,
) -> tuple[list[FileStat], list[str]]:
    warnings: list[str] = []
    if list_dir:
        try:
            return [await stat(path)], warnings
        except (FileNotFoundError, ValueError) as exc:
            warnings.append(f"ls: cannot access '{path.original}': {exc}")
            return [], warnings

    try:
        entries = await readdir(path, index)
    except (FileNotFoundError, ValueError) as exc:
        warnings.append(f"ls: cannot access '{path.original}': {exc}")
        return [], warnings

    stats: list[FileStat] = []
    for entry in entries:
        entry_spec = PathSpec(original=entry,
                              directory=entry,
                              resolved=False,
                              prefix=path.prefix)
        try:
            s = await stat(entry_spec)
        except (FileNotFoundError, ValueError) as exc:
            warnings.append(f"ls: cannot access '{entry}': {exc}")
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
                child_spec = PathSpec(original=child_path,
                                      directory=child_path,
                                      resolved=False,
                                      prefix=path.prefix)
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


async def _drain_filetype_output(stdout) -> str:
    if isinstance(stdout, bytes):
        return stdout.decode(errors="replace")
    chunks: list[bytes] = []
    async for chunk in stdout:
        chunks.append(chunk)
    return b"".join(chunks).decode(errors="replace")


async def render_long_entry(
    entry: FileStat,
    parent: PathSpec,
    *,
    accessor: object,
    filetype_fns: dict | None,
) -> str | None:
    """Try to render one entry via a registered filetype handler (e.g. parquet
    metadata). Returns formatted string or None if no handler / handler failed.
    """
    if not filetype_fns:
        return None
    ext = get_extension(entry.name)
    if ext not in filetype_fns:
        return None
    fn = filetype_fns[ext]
    try:
        path_for_entry = parent.child(entry.name)
        stdout, _io = await fn(accessor, [path_for_entry], args_l=True)
    except Exception:
        return None
    if not stdout:
        return None
    return await _drain_filetype_output(stdout)


async def walk_grouped(
    path: PathSpec,
    *,
    readdir: Callable[[PathSpec, IndexCacheStore | None],
                      Awaitable[list[str]]],
    stat: Callable[[PathSpec], Awaitable[FileStat]],
    all_files: bool = False,
    sort_by: LsSortBy = LsSortBy.NAME,
    reverse: bool = False,
    index: IndexCacheStore | None = None,
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
            child_spec = PathSpec(original=child_path,
                                  directory=child_path,
                                  resolved=False,
                                  prefix=path.prefix)
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


async def _render_group(
    results: list[str],
    dir_spec: PathSpec,
    entries: list[FileStat],
    *,
    long: bool,
    one_per_line: bool,
    human: bool,
    classify: bool,
    accessor: object,
    filetype_fns: dict | None,
) -> None:
    if long and not one_per_line:
        standard_stats: list[FileStat] = []
        for e in entries:
            rendered = await render_long_entry(e,
                                               dir_spec,
                                               accessor=accessor,
                                               filetype_fns=filetype_fns)
            if rendered is not None:
                results.append(rendered)
                continue
            standard_stats.append(e)
        if standard_stats:
            results.extend(format_ls_long(standard_stats, human=human))
    else:
        results.extend(format_simple(entries, classify=classify))


async def ls(
    paths: list[PathSpec],
    *,
    readdir: Callable[[PathSpec, IndexCacheStore | None],
                      Awaitable[list[str]]],
    stat: Callable[[PathSpec], Awaitable[FileStat]],
    long: bool = False,
    one_per_line: bool = False,
    all_files: bool = False,
    human: bool = False,
    sort_by: LsSortBy = LsSortBy.NAME,
    reverse: bool = False,
    recursive: bool = False,
    list_dir: bool = False,
    classify: bool = False,
    accessor: object = None,
    filetype_fns: dict | None = None,
    index: IndexCacheStore | None = None,
    trailing_newline: bool = False,
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
                results.append(f"{dir_spec.original}:")
                await _render_group(results,
                                    dir_spec,
                                    entries,
                                    long=long,
                                    one_per_line=one_per_line,
                                    human=human,
                                    classify=classify,
                                    accessor=accessor,
                                    filetype_fns=filetype_fns)
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
            await _render_group(results,
                                p,
                                entries,
                                long=long,
                                one_per_line=one_per_line,
                                human=human,
                                classify=classify,
                                accessor=accessor,
                                filetype_fns=filetype_fns)

    body = "\n".join(results)
    if trailing_newline and results:
        body += "\n"
    output = body.encode() if results else b""
    stderr = "\n".join(warnings).encode() if warnings else None
    exit_code = 1 if warnings and not results else 0
    return output, IOResult(stderr=stderr, exit_code=exit_code)


__all__ = [
    "format_simple",
    "get_extension",
    "ls",
    "render_long_entry",
    "walk",
    "walk_grouped",
]

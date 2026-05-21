import fnmatch
from collections.abc import Awaitable, Callable

from mirage.cache.index import IndexCacheStore
from mirage.io.types import IOResult
from mirage.types import FileStat, FileType, PathSpec

_BRANCH = "├── "
_LAST = "└── "
_VERTICAL = "│   "
_INDENT = "    "


async def _walk(
    path: PathSpec,
    readdir: Callable[[PathSpec, IndexCacheStore | None],
                      Awaitable[list[str]]],
    stat: Callable[[PathSpec], Awaitable[FileStat]],
    *,
    prefix: str,
    depth: int,
    max_depth: int | None,
    show_hidden: bool,
    ignore_pattern: str | None,
    dirs_only: bool,
    match_pattern: str | None,
    warnings: list[str],
    index: IndexCacheStore | None,
) -> list[str]:
    lines: list[str] = []
    try:
        entries = sorted(await readdir(path, index))
    except (FileNotFoundError, ValueError) as exc:
        warnings.append(f"tree: '{path.original}': {exc}")
        return lines

    filtered: list[tuple[PathSpec, FileStat]] = []
    for entry in entries:
        entry_spec = PathSpec(original=entry,
                              directory=entry,
                              resolved=False,
                              prefix=path.prefix)
        try:
            s = await stat(entry_spec)
        except (FileNotFoundError, ValueError) as exc:
            warnings.append(f"tree: '{entry}': {exc}")
            continue
        if not show_hidden and s.name.startswith("."):
            continue
        if ignore_pattern and fnmatch.fnmatch(s.name, ignore_pattern):
            continue
        if dirs_only and s.type != FileType.DIRECTORY:
            continue
        not_dir = s.type != FileType.DIRECTORY
        if match_pattern and not_dir and not fnmatch.fnmatch(
                s.name, match_pattern):
            continue
        filtered.append((entry_spec, s))

    for i, (entry_spec, s) in enumerate(filtered):
        is_last = i == len(filtered) - 1
        connector = _LAST if is_last else _BRANCH
        lines.append(prefix + connector + s.name)
        if s.type != FileType.DIRECTORY:
            continue
        if max_depth is not None and depth >= max_depth:
            continue
        extension = _INDENT if is_last else _VERTICAL
        sub = await _walk(entry_spec,
                          readdir,
                          stat,
                          prefix=prefix + extension,
                          depth=depth + 1,
                          max_depth=max_depth,
                          show_hidden=show_hidden,
                          ignore_pattern=ignore_pattern,
                          dirs_only=dirs_only,
                          match_pattern=match_pattern,
                          warnings=warnings,
                          index=index)
        lines.extend(sub)
    return lines


async def tree(
    path: PathSpec,
    *,
    readdir: Callable[[PathSpec, IndexCacheStore | None],
                      Awaitable[list[str]]],
    stat: Callable[[PathSpec], Awaitable[FileStat]],
    max_depth: int | None = None,
    show_hidden: bool = False,
    ignore_pattern: str | None = None,
    dirs_only: bool = False,
    match_pattern: str | None = None,
    index: IndexCacheStore | None = None,
) -> tuple[bytes, IOResult]:
    warnings: list[str] = []
    lines = await _walk(path,
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
                        index=index)
    output = "\n".join(lines).encode()
    stderr = "\n".join(warnings).encode() if warnings else None
    return output, IOResult(stderr=stderr)


__all__ = ["tree"]

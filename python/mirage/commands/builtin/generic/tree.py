from collections.abc import Awaitable, Callable

from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.utils.output import (format_optional_records,
                                                  format_records)
from mirage.io.types import IOResult
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.fnmatch import fnmatch
from mirage.utils.key_prefix import rekey

# GNU tree's ASCII (C-locale) drawing set, matching `tree` in the battery's
# docker oracle; the vertical/indent continuations are 4 columns wide.
_BRANCH = "|-- "
_LAST = "`-- "
_VERTICAL = "|   "
_INDENT = "    "


async def _walk(
    path: PathSpec,
    readdir: Callable[[PathSpec, IndexCacheStore | None],
                      Awaitable[list[str]]],
    stat: Callable[[PathSpec, IndexCacheStore | None], Awaitable[FileStat]],
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
) -> tuple[list[str], int, int]:
    lines: list[str] = []
    dirs = 0
    files = 0
    try:
        entries = sorted(await readdir(path, index))
    except (FileNotFoundError, ValueError) as exc:
        warnings.append(f"tree: '{path.raw_path}': {exc}")
        return lines, dirs, files

    filtered: list[tuple[PathSpec, FileStat]] = []
    for entry in entries:
        entry_spec = PathSpec(virtual=entry,
                              directory=entry,
                              resolved=False,
                              resource_path=rekey(path.virtual,
                                                  path.resource_path, entry))
        try:
            s = await stat(entry_spec, index)
        except (FileNotFoundError, ValueError) as exc:
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
        filtered.append((entry_spec, s))

    for i, (entry_spec, s) in enumerate(filtered):
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
        sub, sub_dirs, sub_files = await _walk(entry_spec,
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
        dirs += sub_dirs
        files += sub_files
    return lines, dirs, files


def _summary(dirs: int, files: int, dirs_only: bool) -> str:
    dir_word = "directory" if dirs == 1 else "directories"
    if dirs_only:
        return f"{dirs} {dir_word}"
    file_word = "file" if files == 1 else "files"
    return f"{dirs} {dir_word}, {files} {file_word}"


async def tree(
    path: PathSpec,
    *,
    readdir: Callable[[PathSpec, IndexCacheStore | None],
                      Awaitable[list[str]]],
    stat: Callable[[PathSpec, IndexCacheStore | None], Awaitable[FileStat]],
    max_depth: int | None = None,
    show_hidden: bool = False,
    ignore_pattern: str | None = None,
    dirs_only: bool = False,
    match_pattern: str | None = None,
    index: IndexCacheStore = NULL_INDEX,
) -> tuple[bytes, IOResult]:
    warnings: list[str] = []
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
                                     index=index)
    root_label = path.raw_path or path.virtual
    stderr = format_optional_records(warnings)
    if warnings and not lines:
        # The root could not be opened (GNU prints the error marker inline
        # and exits 2).
        body = [
            f"{root_label}  [error opening dir]", "",
            _summary(0, 0, dirs_only)
        ]
        return format_records(body), IOResult(stderr=stderr, exit_code=2)
    # GNU counts the root as a directory once it has any listed entry (an
    # empty root reports 0), then a blank line and the summary (the file
    # count is omitted under -d).
    root_dirs = dirs + 1 if lines else 0
    body = [root_label] + lines + ["", _summary(root_dirs, files, dirs_only)]
    return format_records(body), IOResult(stderr=stderr)


__all__ = ["tree"]

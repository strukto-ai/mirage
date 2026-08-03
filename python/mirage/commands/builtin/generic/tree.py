from collections.abc import Awaitable, Callable

from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.utils.output import format_records
from mirage.io.types import IOResult
from mirage.ops.types import StatPath
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
    except WALK_ERRORS as exc:
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
    readdir: Callable[[PathSpec, IndexCacheStore | None],
                      Awaitable[list[str]]],
    stat: Callable[[PathSpec, IndexCacheStore | None], Awaitable[FileStat]],
    max_depth: int | None = None,
    show_hidden: bool = False,
    ignore_pattern: str | None = None,
    dirs_only: bool = False,
    match_pattern: str | None = None,
    index: IndexCacheStore = NULL_INDEX,
    stat_path: StatPath | None = None,
) -> tuple[bytes, IOResult]:
    warnings: list[str] = []
    root_label = path.raw_path or path.virtual
    # What the operand is decides the whole result, so it is resolved
    # before the walk rather than inferred from how a backend answered
    # readdir on it: an object store lists a file key as an empty prefix
    # and Graph 404s, which read as two different trees.
    # Only a positive non-directory answer is acted on here. A stat that
    # sees nothing is not proof of absence: on a backend with implicit
    # directories (an object store's key prefix) a directory exists only
    # as its children, so that case falls through to the walk below,
    # which already reports an unopenable root.
    if stat_path is not None:
        start = await stat_path(path.virtual)
        if start is not None and start.type != FileType.DIRECTORY:
            return _unopenable(root_label, dirs_only, 1, 0)
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

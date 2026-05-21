import difflib
import re
from collections.abc import Awaitable, Callable

from mirage.commands.builtin.diff_helper import _ed_script, _normal_diff
from mirage.commands.builtin.utils.lines import split_lines_keepends
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def _diff_pair(
    accessor: object,
    path1: PathSpec | str,
    path2: PathSpec | str,
    read_bytes: Callable[..., Awaitable[bytes]],
    i: bool,
    w: bool,
    b: bool,
    e: bool,
    u: bool,
    q: bool,
) -> bytes:
    name1 = path1.original if isinstance(path1, PathSpec) else path1
    name2 = path2.original if isinstance(path2, PathSpec) else path2
    text_a = (await read_bytes(accessor, path1)).decode(errors="replace")
    text_b = (await read_bytes(accessor, path2)).decode(errors="replace")
    if i:
        text_a = text_a.lower()
        text_b = text_b.lower()
    if w:
        text_a = re.sub(r"\s+", "", text_a)
        text_b = re.sub(r"\s+", "", text_b)
    if b:
        text_a = re.sub(r"[ \t]+", " ", text_a)
        text_b = re.sub(r"[ \t]+", " ", text_b)
    if q:
        if text_a != text_b:
            return f"Files {name1} and {name2} differ\n".encode()
        return b""
    a_lines = split_lines_keepends(text_a)
    b_lines = split_lines_keepends(text_b)
    if e:
        result = _ed_script(a_lines, b_lines)
    elif u:
        result = list(
            difflib.unified_diff(a_lines,
                                 b_lines,
                                 fromfile=name1,
                                 tofile=name2))
    else:
        result = _normal_diff(a_lines, b_lines)
    return "".join(result).encode()


async def _diff_recursive(
    accessor: object,
    paths: list[PathSpec],
    read_bytes: Callable[..., Awaitable[bytes]],
    readdir_fn: Callable[..., Awaitable[list[str]]],
    index: object,
    i: bool,
    w: bool,
    b: bool,
    e: bool,
    u: bool,
    q: bool,
) -> bytes:
    entries_a = sorted(await readdir_fn(accessor, paths[0], index))
    entries_b = sorted(await readdir_fn(accessor, paths[1], index))
    names = sorted(set(entries_a) | set(entries_b))
    parts: list[bytes] = []
    for name in names:
        p1_str = paths[0].original.rstrip("/") + "/" + name
        p2_str = paths[1].original.rstrip("/") + "/" + name
        p1 = PathSpec(original=p1_str,
                      directory=p1_str,
                      prefix=paths[0].prefix)
        p2 = PathSpec(original=p2_str,
                      directory=p2_str,
                      prefix=paths[1].prefix)
        if name in entries_a and name in entries_b:
            parts.append(await _diff_pair(accessor, p1, p2, read_bytes, i, w,
                                          b, e, u, q))
    return b"".join(parts)


async def diff(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    readdir_fn: Callable[..., Awaitable[list[str]]],
    accessor: object = None,
    index: object = None,
    i: bool = False,
    w: bool = False,
    b: bool = False,
    e: bool = False,
    u: bool = False,
    q: bool = False,
    r: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if len(paths) < 2:
        raise ValueError("diff: requires two paths")
    if r:
        output = await _diff_recursive(accessor, paths, read_bytes, readdir_fn,
                                       index, i, w, b, e, u, q)
    else:
        output = await _diff_pair(accessor, paths[0], paths[1], read_bytes, i,
                                  w, b, e, u, q)
    exit_code = 1 if output else 0
    return output, IOResult(exit_code=exit_code,
                            cache=[paths[0].original, paths[1].original])


__all__ = ["diff"]

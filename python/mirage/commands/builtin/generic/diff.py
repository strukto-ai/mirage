import difflib
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from mirage.commands.builtin.diff_helper import _ed_script, _normal_diff
from mirage.commands.builtin.utils.lines import split_lines_keepends
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec
from mirage.utils.path import gnu_basename


@dataclass(frozen=True, slots=True)
class _DiffFlags:
    i: bool = False
    w: bool = False
    b: bool = False
    e: bool = False
    u: bool = False
    q: bool = False


def _child_spec(parent: PathSpec, name: str) -> PathSpec:
    child = parent.original.rstrip("/") + "/" + name
    return PathSpec(original=child, directory=child, prefix=parent.prefix)


async def _diff_pair(
    accessor: object,
    path1: PathSpec | str,
    path2: PathSpec | str,
    read_bytes: Callable[..., Awaitable[bytes]],
    flags: _DiffFlags,
) -> bytes:
    name1 = path1.original if isinstance(path1, PathSpec) else path1
    name2 = path2.original if isinstance(path2, PathSpec) else path2
    text_a = (await read_bytes(accessor, path1)).decode(errors="replace")
    text_b = (await read_bytes(accessor, path2)).decode(errors="replace")
    if flags.i:
        text_a = text_a.lower()
        text_b = text_b.lower()
    if flags.w:
        text_a = re.sub(r"\s+", "", text_a)
        text_b = re.sub(r"\s+", "", text_b)
    if flags.b:
        text_a = re.sub(r"[ \t]+", " ", text_a)
        text_b = re.sub(r"[ \t]+", " ", text_b)
    if flags.q:
        if text_a != text_b:
            return f"Files {name1} and {name2} differ\n".encode()
        return b""
    a_lines = split_lines_keepends(text_a)
    b_lines = split_lines_keepends(text_b)
    if flags.e:
        result = _ed_script(a_lines, b_lines)
    elif flags.u:
        result = list(
            difflib.unified_diff(a_lines,
                                 b_lines,
                                 fromfile=name1,
                                 tofile=name2))
    else:
        result = _normal_diff(a_lines, b_lines)
    return "".join(result).encode()


async def _diff_dirs(
    accessor: object,
    dir_a: PathSpec,
    dir_b: PathSpec,
    read_bytes: Callable[..., Awaitable[bytes]],
    readdir_fn: Callable[..., Awaitable[list[str]]],
    stat_fn: Callable[..., Awaitable[object]],
    index: object,
    flags: _DiffFlags,
) -> bytes:
    raw_a = await readdir_fn(accessor, dir_a, index)
    raw_b = await readdir_fn(accessor, dir_b, index)
    names_a = {gnu_basename(entry) for entry in raw_a}
    names_b = {gnu_basename(entry) for entry in raw_b}
    left = dir_a.original.rstrip("/")
    right = dir_b.original.rstrip("/")
    parts: list[bytes] = []
    for name in sorted(names_a | names_b):
        if name not in names_b:
            parts.append(f"Only in {left}: {name}\n".encode())
            continue
        if name not in names_a:
            parts.append(f"Only in {right}: {name}\n".encode())
            continue
        child_a = _child_spec(dir_a, name)
        child_b = _child_spec(dir_b, name)
        a_dir = (await stat_fn(accessor, child_a,
                               index)).type == FileType.DIRECTORY
        b_dir = (await stat_fn(accessor, child_b,
                               index)).type == FileType.DIRECTORY
        if a_dir and b_dir:
            parts.append(await
                         _diff_dirs(accessor, child_a, child_b, read_bytes,
                                    readdir_fn, stat_fn, index, flags))
        elif not a_dir and not b_dir:
            body = await _diff_pair(accessor, child_a, child_b, read_bytes,
                                    flags)
            if body:
                if flags.q:
                    parts.append(body)
                else:
                    header = f"diff -r {child_a.original} {child_b.original}\n"
                    parts.append(header.encode() + body)
        elif a_dir:
            parts.append((f"File {child_a.original} is a directory while file "
                          f"{child_b.original} is a regular file\n").encode())
        else:
            parts.append(
                (f"File {child_a.original} is a regular file while file "
                 f"{child_b.original} is a directory\n").encode())
    return b"".join(parts)


async def diff(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    readdir_fn: Callable[..., Awaitable[list[str]]],
    stat_fn: Callable[..., Awaitable[object]] | None = None,
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
    flags = _DiffFlags(i=i, w=w, b=b, e=e, u=u, q=q)
    both_dirs = False
    if r and stat_fn is not None:
        both_dirs = ((await stat_fn(accessor, paths[0],
                                    index)).type == FileType.DIRECTORY
                     and (await stat_fn(accessor, paths[1],
                                        index)).type == FileType.DIRECTORY)
    if both_dirs:
        output = await _diff_dirs(accessor, paths[0], paths[1], read_bytes,
                                  readdir_fn, stat_fn, index, flags)
    else:
        output = await _diff_pair(accessor, paths[0], paths[1], read_bytes,
                                  flags)
    exit_code = 1 if output else 0
    return output, IOResult(
        exit_code=exit_code,
        cache=[paths[0].strip_prefix, paths[1].strip_prefix])


__all__ = ["diff"]

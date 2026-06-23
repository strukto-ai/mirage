# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

from typing import Awaitable, Callable

from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.utils.copy import (backend_key_default,
                                                copy_targets, is_directory,
                                                path_exists)
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec


async def walk(readdir: Callable, stat: Callable, root: str,
               index: IndexCacheStore | None) -> list[tuple[str, bool]]:
    """List a tree as ``(path, is_dir)`` pairs, parents before children.

    The dir/file type is captured here, while the tree is intact, so a caller
    that deletes as it goes (mv) never re-stats a path whose virtual parent dir
    has since vanished (e.g. on S3). Used only by the primitive (no native
    ``copy``) path; backends that inject ``copy``/``find`` never reach it.

    Args:
        readdir (Callable): Lists a directory's full child paths.
        stat (Callable): Stats a path; ``.type`` distinguishes directories.
        root (str): Full path of the tree root.
        index (IndexCacheStore | None): Optional cache index for stat/readdir.
    """
    info = await stat(root, index)
    if info.type != FileType.DIRECTORY:
        return [(root, False)]
    entries = [(root, True)]
    queue = [root]
    while queue:
        directory = queue.pop(0)
        for child in await readdir(directory, index):
            child_info = await stat(child, index)
            is_dir = child_info.type == FileType.DIRECTORY
            entries.append((child, is_dir))
            if is_dir:
                queue.append(child)
    return entries


async def cp(
    paths: list[PathSpec],
    *,
    stat: Callable[..., Awaitable[object]],
    recursive: bool,
    n: bool,
    v: bool,
    copy: Callable[..., Awaitable[None]] | None = None,
    find: Callable[..., Awaitable[list[str]]] | None = None,
    find_type: str = "f",
    read_bytes: Callable[..., Awaitable[bytes]] | None = None,
    write: Callable[..., Awaitable[None]] | None = None,
    mkdir: Callable[..., Awaitable[None]] | None = None,
    readdir: Callable[..., Awaitable[list[str]]] | None = None,
    index: IndexCacheStore | None = None,
    backend_key: Callable[[PathSpec], str] | None = None,
    dir_copy: Callable[..., Awaitable[None]] | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Copy sources to a destination, fanning out into a directory.

    A backend injects its native ``copy``/``find`` for an efficient same-store
    copy. When ``copy`` is omitted (cross-mount), the primitive path is used
    instead: the tree is walked via ``readdir``/``stat`` and each entry is a
    ``mkdir`` (directory) or a ``write`` of ``read_bytes`` (file).

    Args:
        paths (list[PathSpec]): Source operands followed by the destination.
        stat (Callable): Stats a path; raises when missing.
        recursive (bool): Whether to copy directories recursively.
        n (bool): No-clobber; skip targets that already exist.
        v (bool): Verbose; emit one ``src -> target`` line per write.
        copy (Callable | None): Native single-entry copy; None for primitive.
        find (Callable | None): Native tree lister, with ``copy``.
        find_type (str): File-type selector passed to ``find``.
        read_bytes (Callable | None): Whole-file reader (primitive path).
        write (Callable | None): Byte writer, for the primitive path.
        mkdir (Callable | None): Directory creator, for the primitive path.
        readdir (Callable | None): Directory lister, for the primitive walk.
        index (IndexCacheStore | None): Cache for the destination dir probe.
        backend_key (Callable | None): Maps a path to its backend storage key
            for the same-file and into-own-subtree guards; defaults to the
            normalized mount-relative path.

    Returns:
        tuple[ByteSource | None, IOResult]: Verbose output and recorded
        writes, with per-source coreutils errors on stderr and exit code 1
        when any source failed.
    """
    key_of = backend_key if backend_key is not None else backend_key_default
    *sources, dst = paths
    dst_is_dir = await is_directory(stat, dst, index)
    writes: dict[str, bytes] = {}
    lines: list[str] = []
    errors: list[str] = []
    for src, target in copy_targets(sources, dst, dst_is_dir):
        if not await path_exists(stat, src):
            errors.append(f"cp: cannot stat '{src.original}': "
                          "No such file or directory")
            continue
        if key_of(src) == key_of(target):
            errors.append(f"cp: '{src.original}' and '{target.original}' "
                          "are the same file")
            continue
        if recursive and key_of(target).startswith(key_of(src) + "/"):
            errors.append(f"cp: cannot copy a directory, '{src.original}', "
                          f"into itself, '{target.original}'")
            continue
        if not recursive and await is_directory(stat, src, index):
            errors.append("cp: -r not specified; omitting directory "
                          f"'{src.original}'")
            continue
        if recursive:
            src_base = src.strip_prefix.rstrip("/")
            dst_base = target.strip_prefix.rstrip("/")
            if copy is None:
                for entry, is_dir in await walk(readdir, stat, src.original,
                                                index):
                    entry_dst = dst_base + entry[len(src_base):]
                    if is_dir:
                        if not await is_directory(stat, entry_dst, index):
                            await mkdir(entry_dst)
                            writes[entry_dst] = b""
                            if v:
                                lines.append(f"'{entry}' -> '{entry_dst}'")
                        continue
                    if n and await path_exists(stat, entry_dst):
                        continue
                    await write(entry_dst, data=await read_bytes(entry))
                    writes[entry_dst] = b""
                    if v:
                        lines.append(f"'{entry}' -> '{entry_dst}'")
                continue
            if dir_copy is not None:
                if n and await path_exists(stat, target):
                    continue
                await dir_copy(src, target)
                for entry in await find(src, type=find_type):
                    entry_dst = dst_base + entry[len(src_base):]
                    writes[entry_dst] = b""
                    if v:
                        lines.append(f"'{entry}' -> '{entry_dst}'")
                continue
            for entry in await find(src, type=find_type):
                entry_dst = dst_base + entry[len(src_base):]
                if n and await path_exists(stat, entry_dst):
                    continue
                await copy(entry, entry_dst)
                writes[entry_dst] = b""
                if v:
                    lines.append(f"'{entry}' -> '{entry_dst}'")
            continue
        if n and await path_exists(stat, target):
            continue
        if copy is None:
            # write takes bytes, not a stream: the file is materialized here.
            await write(target, data=await read_bytes(src))
        else:
            await copy(src, target)
        writes[target.strip_prefix] = b""
        if v:
            lines.append(f"'{src.original}' -> '{target.original}'")
    output = "\n".join(lines) + "\n" if lines else None
    stderr = ("\n".join(errors) + "\n").encode() if errors else None
    return output.encode() if output else None, IOResult(
        writes=writes,
        stderr=stderr,
        exit_code=1 if errors else 0,
    )

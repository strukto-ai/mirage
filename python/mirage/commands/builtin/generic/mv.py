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
from mirage.commands.builtin.generic.cp import walk
from mirage.commands.builtin.utils.copy import (backend_key_default,
                                                copy_targets, is_directory,
                                                path_exists)
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileStat, PathSpec


async def mv(
    paths: list[PathSpec],
    *,
    stat: Callable[..., Awaitable[FileStat]],
    n: bool,
    v: bool,
    rename: Callable[..., Awaitable[None]] | None = None,
    read_bytes: Callable[..., Awaitable[bytes]] | None = None,
    write: Callable[..., Awaitable[None]] | None = None,
    mkdir: Callable[..., Awaitable[None]] | None = None,
    readdir: Callable[..., Awaitable[list[str]]] | None = None,
    unlink: Callable[..., Awaitable[None]] | None = None,
    rmdir: Callable[..., Awaitable[None]] | None = None,
    index: IndexCacheStore | None = None,
    backend_key: Callable[[PathSpec], str] | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Move sources to a destination, fanning out into a directory.

    A backend injects its native atomic ``rename``. When ``rename`` is omitted
    (cross-mount, where no atomic rename spans two mounts), the primitive path
    copies the tree (parents first, via ``walk`` + ``mkdir``/``write``) then
    removes the source (children first, by the types ``walk`` captured).

    Args:
        paths (list[PathSpec]): Source operands followed by the destination.
        stat (Callable): Stats a path; raises when missing.
        n (bool): No-clobber; skip targets that already exist.
        v (bool): Verbose; emit one ``src -> target`` line per move.
        rename (Callable | None): Native atomic rename; None for primitive.
        read_bytes (Callable | None): Whole-file reader (primitive path).
        write (Callable | None): Byte writer, for the primitive path.
        mkdir (Callable | None): Directory creator, for the primitive path.
        readdir (Callable | None): Directory lister, for the primitive walk.
        unlink (Callable | None): File remover, for the primitive path.
        rmdir (Callable | None): Directory remover, for the primitive path.
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
    writes: dict[str, ByteSource] = {}
    lines: list[str] = []
    errors: list[str] = []
    for src, target in copy_targets(sources, dst, dst_is_dir):
        if not await path_exists(stat, src):
            errors.append(f"mv: cannot stat '{src.virtual}': "
                          "No such file or directory")
            continue
        if key_of(src) == key_of(target):
            errors.append(f"mv: '{src.virtual}' and '{target.virtual}' "
                          "are the same file")
            continue
        if key_of(target).startswith(key_of(src) + "/"):
            errors.append(f"mv: cannot move '{src.virtual}' to a "
                          f"subdirectory of itself, '{target.virtual}'")
            continue
        if n and await path_exists(stat, target):
            continue
        if rename is None:
            assert readdir is not None and mkdir is not None
            assert write is not None and read_bytes is not None
            assert rmdir is not None and unlink is not None
            src_base = src.mount_path.rstrip("/")
            dst_base = target.mount_path.rstrip("/")
            entries = await walk(readdir, stat, src.virtual, index)
            for entry, is_dir in entries:
                entry_dst = dst_base + entry[len(src_base):]
                if is_dir:
                    if not await is_directory(stat, entry_dst, index):
                        await mkdir(entry_dst)
                else:
                    # write takes bytes, not a stream: file materialized here.
                    await write(entry_dst, data=await read_bytes(entry))
            for entry, is_dir in reversed(entries):
                await (rmdir if is_dir else unlink)(entry)
        else:
            await rename(src, target)
        writes[src.mount_path] = b""
        writes[target.mount_path] = b""
        if v:
            lines.append(f"'{src.virtual}' -> '{target.virtual}'")
    output = "\n".join(lines) + "\n" if lines else None
    stderr = ("\n".join(errors) + "\n").encode() if errors else None
    return output.encode() if output else None, IOResult(
        writes=writes,
        stderr=stderr,
        exit_code=1 if errors else 0,
    )

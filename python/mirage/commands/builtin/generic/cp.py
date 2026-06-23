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
from mirage.types import PathSpec


async def cp(
    paths: list[PathSpec],
    *,
    copy: Callable[..., Awaitable[None]],
    find: Callable[..., Awaitable[list[str]]],
    find_type: str,
    stat: Callable[..., Awaitable[object]],
    recursive: bool,
    n: bool,
    v: bool,
    index: IndexCacheStore | None = None,
    backend_key: Callable[[PathSpec], str] | None = None,
    dir_copy: Callable[..., Awaitable[None]] | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Copy sources to a destination, fanning out into a directory.

    Args:
        paths (list[PathSpec]): Source operands followed by the destination.
        copy (Callable): Copies a single source to a target.
        find (Callable): Lists files beneath a directory for ``recursive``.
        find_type (str): File-type selector passed to ``find``.
        stat (Callable): Stats a path; raises when missing.
        recursive (bool): Whether to copy directories recursively.
        n (bool): No-clobber; skip targets that already exist.
        v (bool): Verbose; emit one ``src -> target`` line per write.
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

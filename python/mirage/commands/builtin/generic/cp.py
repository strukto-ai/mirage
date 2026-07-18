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

from typing import Callable

from mirage.commands.builtin.utils.copy import (backend_key_default,
                                                copy_targets, is_directory,
                                                path_exists)
from mirage.io.types import ByteSource, IOResult
from mirage.types import (CopyStrategy, FileType, PathSpec, PrimitiveCopy,
                          ReaddirFn, StatFn)
from mirage.utils.key_prefix import mount_prefix_of, rekey


def descendant_path(root: PathSpec, virtual: str) -> PathSpec:
    return PathSpec.from_str_path(
        virtual, rekey(root.virtual, root.resource_path, virtual))


def mounted_path(root: PathSpec, mount_path: str) -> PathSpec:
    prefix = mount_prefix_of(root.virtual, root.resource_path)
    virtual = prefix + mount_path if prefix else mount_path
    return PathSpec.from_str_path(virtual, mount_path.strip("/"))


async def walk(
    readdir: ReaddirFn,
    stat: StatFn,
    root: PathSpec,
) -> list[tuple[PathSpec, bool]]:
    """List a tree as ``(path, is_dir)`` pairs, parents before children.

    The dir/file type is captured here, while the tree is intact, so a caller
    that deletes as it goes (mv) never re-stats a path whose virtual parent dir
    has since vanished (e.g. on S3). Used only by the primitive (no native
    ``copy``) path; backends that inject ``copy``/``find`` never reach it.

    Args:
        readdir (Callable): Lists a directory's full child paths.
        stat (Callable): Stats a path; ``.type`` distinguishes directories.
        root (PathSpec): Root of the tree.
    """
    info = await stat(root)
    if info.type != FileType.DIRECTORY:
        return [(root, False)]
    entries = [(root, True)]
    queue = [root]
    while queue:
        directory = queue.pop(0)
        for child_virtual in await readdir(directory):
            child = descendant_path(root, child_virtual)
            child_info = await stat(child)
            is_dir = child_info.type == FileType.DIRECTORY
            entries.append((child, is_dir))
            if is_dir:
                queue.append(child)
    return entries


async def cp(
    paths: list[PathSpec],
    *,
    stat: StatFn,
    strategy: CopyStrategy,
    recursive: bool,
    n: bool,
    v: bool,
    find_type: str = "f",
    backend_key: Callable[[PathSpec], str] | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Copy sources to a destination, fanning out into a directory.

    ``NativeCopy`` uses backend ``copy``/``find`` operations for an efficient
    same-store copy. ``PrimitiveCopy`` handles cross-mount copies by walking
    via ``readdir``/``stat`` and applying ``mkdir`` or
    ``write(read_bytes(...))`` to each entry.

    Args:
        paths (list[PathSpec]): Source operands followed by the destination.
        stat (Callable): Stats a path; raises when missing.
        recursive (bool): Whether to copy directories recursively.
        n (bool): No-clobber; skip targets that already exist.
        v (bool): Verbose; emit one ``src -> target`` line per write.
        strategy (CopyStrategy): Complete native or primitive copy capability.
        find_type (str): File-type selector passed to ``find``.
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
    dst_is_dir = await is_directory(stat, dst)
    writes: dict[str, ByteSource] = {}
    reads: dict[str, ByteSource] = {}
    lines: list[str] = []
    errors: list[str] = []
    for src, target in copy_targets(sources, dst, dst_is_dir):
        if not await path_exists(stat, src):
            errors.append(f"cp: cannot stat '{src.virtual}': "
                          "No such file or directory")
            continue
        if key_of(src) == key_of(target):
            errors.append(f"cp: '{src.virtual}' and '{target.virtual}' "
                          "are the same file")
            continue
        if recursive and key_of(target).startswith(key_of(src) + "/"):
            errors.append(f"cp: cannot copy a directory, '{src.virtual}', "
                          f"into itself, '{target.virtual}'")
            continue
        if not recursive and await is_directory(stat, src):
            errors.append("cp: -r not specified; omitting directory "
                          f"'{src.virtual}'")
            continue
        if recursive:
            src_base = src.mount_path.rstrip("/")
            dst_base = target.mount_path.rstrip("/")
            if isinstance(strategy, PrimitiveCopy):
                for entry, is_dir in await walk(strategy.readdir, stat, src):
                    entry_dst = descendant_path(
                        target,
                        target.virtual.rstrip("/") +
                        entry.virtual[len(src.virtual.rstrip("/")):],
                    )
                    if is_dir:
                        if not await is_directory(stat, entry_dst):
                            await strategy.mkdir(entry_dst)
                            writes[entry_dst.mount_path] = b""
                            if v:
                                lines.append(f"'{entry.virtual}' -> "
                                             f"'{entry_dst.virtual}'")
                        continue
                    if n and await path_exists(stat, entry_dst):
                        continue
                    data = await strategy.read_bytes(entry)
                    await strategy.write(entry_dst, data=data)
                    reads[entry.virtual] = data
                    writes[entry_dst.mount_path] = b""
                    if v:
                        lines.append(
                            f"'{entry.virtual}' -> '{entry_dst.virtual}'")
                continue
            if strategy.dir_copy is not None:
                if n and await path_exists(stat, target):
                    continue
                await strategy.dir_copy(src, target)
                for entry_mount in await strategy.find(src, type=find_type):
                    entry = mounted_path(src, entry_mount)
                    entry_dst = mounted_path(
                        target, dst_base + entry_mount[len(src_base):])
                    writes[entry_dst.mount_path] = b""
                    if v:
                        lines.append(
                            f"'{entry.virtual}' -> '{entry_dst.virtual}'")
                continue
            for entry_mount in await strategy.find(src, type=find_type):
                entry = mounted_path(src, entry_mount)
                entry_dst = mounted_path(
                    target, dst_base + entry_mount[len(src_base):])
                if n and await path_exists(stat, entry_dst):
                    continue
                await strategy.copy(entry, entry_dst)
                writes[entry_dst.mount_path] = b""
                if v:
                    lines.append(f"'{entry.virtual}' -> '{entry_dst.virtual}'")
            continue
        if n and await path_exists(stat, target):
            continue
        if isinstance(strategy, PrimitiveCopy):
            # write takes bytes, not a stream: the file is materialized here.
            data = await strategy.read_bytes(src)
            await strategy.write(target, data=data)
            reads[src.virtual] = data
        else:
            await strategy.copy(src, target)
        writes[target.mount_path] = b""
        if v:
            lines.append(f"'{src.virtual}' -> '{target.virtual}'")
    output = "\n".join(lines) + "\n" if lines else None
    stderr = ("\n".join(errors) + "\n").encode() if errors else None
    # Sources that streamed through the client are recorded as reads so
    # apply_io can populate the file cache: a cp is also a full read.
    return output.encode() if output else None, IOResult(
        writes=writes,
        reads=dict(reads),
        cache=list(reads),
        stderr=stderr,
        exit_code=1 if errors else 0,
    )

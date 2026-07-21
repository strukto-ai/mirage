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

from mirage.commands.builtin.generic.cp import copy_entries, walk
from mirage.commands.builtin.utils.copy import (backend_key_default,
                                                copy_targets, is_directory,
                                                path_exists)
from mirage.io.types import ByteSource, IOResult
from mirage.types import MoveStrategy, PathSpec, PrimitiveMove, StatFn
from mirage.utils.errors import FS_ERRORS, fs_strerror


async def _entry_gone(strategy: PrimitiveMove, stat: StatFn, entry: PathSpec,
                      is_dir: bool) -> bool:
    """Confirm a failed removal actually left something behind.

    On dirless object stores a directory vanishes with its last child, so
    a failed ``rmdir`` of a path that no longer exists (or that no longer
    lists any children — an existing empty directory is impossible there)
    is a completed removal, not an error. The listing check covers index
    backends whose per-entry stat can lag a just-unlinked child within a
    command.

    Args:
        strategy (PrimitiveMove): Transfer primitives for both mounts.
        stat (StatFn): Stats a path; raises when missing.
        entry (PathSpec): The path whose removal failed.
        is_dir (bool): Whether the entry is a directory.

    Returns:
        bool: True when nothing of the source remains at ``entry``.
    """
    if not await path_exists(stat, entry):
        return True
    if not is_dir:
        return False
    try:
        children = await strategy.readdir(entry)
    except FS_ERRORS:
        return True
    return not children


async def _remove_entries(
    strategy: PrimitiveMove,
    stat: StatFn,
    entries: list[tuple[PathSpec, bool]],
    errors: list[str],
) -> tuple[bool, bool]:
    """Remove copied source entries children first, GNU rm style.

    A failed removal is reported per entry (``mv: cannot remove ...``) and
    the remaining entries are still attempted; directories with a failed
    descendant are skipped silently like GNU, which never reports the
    not-empty ancestors of a file it could not remove. A failure is
    confirmed via ``_entry_gone`` first, so a source that already vanished
    (dirless object stores) is a completed removal, not an error.

    Args:
        strategy (PrimitiveMove): Transfer primitives for both mounts.
        stat (StatFn): Stats a path; raises when missing.
        entries (list[tuple[PathSpec, bool]]): ``walk`` output, parents
            first; removal runs it in reverse.
        errors (list[str]): Collected stderr lines, appended in place.

    Returns:
        tuple[bool, bool]: ``(removed_any, removed_all)`` — whether the
        source changed at all, and whether it is fully gone.
    """
    failed: list[str] = []
    removed_any = False
    for entry, is_dir in reversed(entries):
        base = entry.virtual.rstrip("/")
        if is_dir and any(f.startswith(base + "/") for f in failed):
            failed.append(base)
            continue
        try:
            await (strategy.rmdir if is_dir else strategy.unlink)(entry)
        except FS_ERRORS as exc:
            if await _entry_gone(strategy, stat, entry, is_dir):
                removed_any = True
                continue
            errors.append(f"mv: cannot remove '{entry.virtual}': "
                          f"{fs_strerror(exc)}")
            failed.append(base)
            continue
        removed_any = True
    return removed_any, not failed


async def mv(
    paths: list[PathSpec],
    *,
    stat: StatFn,
    strategy: MoveStrategy,
    n: bool,
    v: bool,
    backend_key: Callable[[PathSpec], str] | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Move sources to a destination, fanning out into a directory.

    ``NativeMove`` uses an atomic backend rename. ``PrimitiveMove`` handles
    cross-mount moves by copying the tree (parents first, via ``walk`` plus
    ``mkdir``/``write``) and then removing the source children first.
    Failures follow GNU mv on a cross-device move: a copy failure keeps the
    whole source and skips removal, a removal failure (e.g. a source mount
    with no ``unlink``) reports ``cannot remove`` and leaves the copied
    destination in place; either way the remaining sources still move.

    Args:
        paths (list[PathSpec]): Source operands followed by the destination.
        stat (Callable): Stats a path; raises when missing.
        n (bool): No-clobber; skip targets that already exist.
        v (bool): Verbose; emit one ``src -> target`` line per move.
        strategy (MoveStrategy): Complete native or primitive move capability.
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
        if isinstance(strategy, PrimitiveMove):
            entries = await walk(strategy.readdir, stat, src)
            copied_all, wrote_any = await copy_entries("mv", strategy, stat,
                                                       src, target, entries,
                                                       errors)
            if wrote_any:
                writes[target.mount_path] = b""
            if not copied_all:
                # GNU keeps the whole source tree when any copy failed;
                # the destination keeps the entries that landed.
                continue
            removed_any, removed_all = await _remove_entries(
                strategy, stat, entries, errors)
            if removed_any:
                writes[src.mount_path] = b""
            if not removed_all:
                # GNU leaves the copied destination in place and reports
                # the source entries it could not remove.
                continue
        else:
            await strategy.rename(src, target)
            writes[src.mount_path] = b""
            writes[target.mount_path] = b""
        if v:
            lines.append(f"renamed '{src.virtual}' -> '{target.virtual}'")
    output = "\n".join(lines) + "\n" if lines else None
    stderr = ("\n".join(errors) + "\n").encode() if errors else None
    return output.encode() if output else None, IOResult(
        writes=writes,
        stderr=stderr,
        exit_code=1 if errors else 0,
    )

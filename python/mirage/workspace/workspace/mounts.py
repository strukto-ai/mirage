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

import asyncio
import inspect
from collections.abc import Callable
from functools import partial

from mirage.cache.file.io import mutation_lock
from mirage.cache.file.mixin import FileCacheMixin
from mirage.cache.index import IndexConfig
from mirage.cache.index.store import IndexCacheStore
from mirage.ops import Ops
from mirage.types import KERNEL_BACKENDS, MountBackend, MountMode, ReadSpec
from mirage.vfs.base import BaseVFS
from mirage.vfs.history import HISTORY_PREFIX
from mirage.vfs.ram import RAMVFS
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.mount import MountEntry
from mirage.workspace.mount.read_policy import check_read_capability
from mirage.workspace.mount.spec import Mount
from mirage.workspace.workspace.types import MountSpec, VFSMount


def check_vfs(prefix: str, vfs: BaseVFS) -> None:
    """Refuse a mount value that is not a VFS, naming the mount.

    ``MountSpec.VFS`` is annotated ``BaseVFS`` but the class is
    a plain dataclass, so nothing enforced it and the wrong value rode
    all the way to ``install_mounts``, where it surfaced as
    ``'X' object has no attribute 'set_index'`` -- a method the caller
    never called, in a file they never touched, with no mount named.

    The coroutine arm is spelled out because it is the mistake this
    function exists for: 0.0.5 briefly made ``build_vfs`` async, so
    every caller written against 0.0.3/0.0.4 handed the mount table an
    un-awaited coroutine.

    Args:
        prefix (str): the mount point the value was given for.
        vfs (BaseVFS): the value to check.

    Raises:
        TypeError: ``vfs`` is a coroutine or not a BaseVFS.
    """
    if inspect.iscoroutine(vfs):
        raise TypeError(
            f"mount {prefix!r}: got a coroutine, not a VFS. "
            "build_vfs() is synchronous; if you wrote "
            "`await build_vfs(...)` against 0.0.5, drop the await.")
    if not isinstance(vfs, BaseVFS):
        raise TypeError(f"mount {prefix!r}: expected a BaseVFS, got "
                        f"{type(vfs).__name__}")


def normalize_mounts(mounts: dict[str, VFSMount], default_mode: MountMode,
                     default_read: ReadSpec) -> list[MountSpec]:
    """Narrow every accepted ``mounts`` spelling to one shape.

    Every spelling converges here, which is why this is where a mount's
    read policy is checked against what its backend can honour: one
    verdict per mount, whatever door declared it.

    Args:
        mounts (dict[str, VFSMount]): the constructor mapping.
        default_mode (MountMode): mode for entries that name none.
        default_read (ReadSpec): read policy for entries that name none.

    Raises:
        TypeError: a tuple entry is not (VFS, mode) or
            (VFS, mode, command_limits), or an entry's VFS is
            not a :class:`BaseVFS`.
        ValueError: a mount declares a read policy its backend cannot
            honour.
    """
    specs: list[MountSpec] = []
    for prefix, value in mounts.items():
        if isinstance(value, Mount):
            specs.append(
                MountSpec(
                    prefix=prefix,
                    vfs=value.vfs,
                    mode=value.mode
                    if value.mode is not None else default_mode,
                    backend=value.backend,
                    mountpoint=value.mountpoint,
                    command_limits=dict(value.command_limits or {}),
                    read=value.read
                    if value.read is not None else default_read,
                ))
        elif isinstance(value, tuple):
            if len(value) not in (2, 3):
                raise TypeError("VFS tuples must be (VFS, mode) or "
                                "(VFS, mode, command_limits)")
            command_limits = dict(
                value[2]) if len(value) == 3 and value[2] else {}
            specs.append(
                MountSpec(prefix=prefix,
                          vfs=value[0],
                          mode=value[1],
                          command_limits=command_limits,
                          read=default_read))
        else:
            specs.append(
                MountSpec(prefix=prefix,
                          vfs=value,
                          mode=default_mode,
                          read=default_read))
    for spec in specs:
        check_vfs(spec.prefix, spec.vfs)
        check_read_capability(spec.prefix, spec.vfs, spec.read)
    return specs


def kernel_targets(
        specs: list[MountSpec]) -> list[tuple[str, MountBackend, str | None]]:
    """Entries that also want a real mountpoint, in declaration order.

    Args:
        specs (list[MountSpec]): the normalized mount specs.
    """
    return [(s.prefix, s.backend, s.mountpoint) for s in specs
            if s.backend in KERNEL_BACKENDS]


def install_mounts(registry: MountRegistry, specs: list[MountSpec],
                   index: IndexConfig | None, default_mode: MountMode,
                   default_read: ReadSpec) -> bool:
    """Mount every spec, adding an implicit scratch root if none claims /.

    A workspace-level ``index`` is installed on every VFS, its TTL
    included: the config names the store the whole workspace shares, so
    a VFS that declares ``index_ttl = 0`` caches its listings for the
    workspace's TTL under it (the redis index example relies on exactly
    that to share a RAM mount's listing between two processes). With no
    workspace config a VFS keeps the index it was constructed with
    or given through ``set_index``, as the TypeScript workspace does;
    resetting it to a RAM default here silently discarded a
    ``RedisIndexConfig`` passed to the VFS itself.

    Args:
        registry (MountRegistry): the workspace's mount table.
        specs (list[MountSpec]): the normalized mount specs.
        index (IndexConfig | None): index config installed per VFS,
            or None to leave each VFS's own index in place.
        default_mode (MountMode): mode for the implicit root.
        default_read (ReadSpec): read policy for the implicit root.

    Returns:
        bool: whether the root mount was synthesized.
    """
    for spec in specs:
        registry.check_vfs_available(spec.vfs)
        if index is not None:
            spec.vfs.set_index(index)
        entry = registry.mount(spec.prefix, spec.vfs, spec.mode, spec.read)
        if spec.command_limits:
            entry.command_limits.update(spec.command_limits)
    implicit_root = registry.root_mount is None
    if implicit_root:
        # Pinned bounded, not inherited. This anchor is synthesized after
        # `normalize_mounts` has run, so it never meets the capability
        # verdict -- and RAM does not cache reads, so a workspace-level
        # `fresh` would stamp on it exactly the combination the verdict
        # exists to refuse. It is snapshotted like any other mount, so
        # that stray policy came back as a refusal on restore.
        registry.mount("/", RAMVFS(), default_mode, ReadSpec())
    return implicit_root


async def clear_mount_cache(cache: FileCacheMixin | None, prefix: str,
                            indices: list[IndexCacheStore]) -> None:
    """Drop a mount's cache state atomically with deferred file-cache fills."""

    async def clear_indices() -> None:
        for index in dict.fromkeys(indices):
            await index.invalidate_prefix(prefix.rstrip("/"))

    if cache is None:
        await clear_indices()
        return
    async with mutation_lock(cache):
        await cache.remove(prefix.rstrip("/"))
        await cache.evict_prefix(prefix)
        await clear_indices()


def prepare_added_mount(registry: MountRegistry, entry: MountEntry,
                        previous: list[MountEntry]) -> None:
    """Keep synchronous registration; I/O awaits removal of shadowed state."""
    indices = [entry.vfs.index]
    indices.extend(m.vfs.index for m in previous
                   if entry.prefix.startswith(m.prefix))
    entry.before_use = partial(clear_mount_cache, registry.file_cache,
                               entry.prefix, indices)


async def unmount(registry: MountRegistry, ops: Ops, prefix: str,
                  is_shutting_down: Callable[[], bool],
                  shared_mounts: set[int]) -> None:
    """Remove one mount, closing its VFS if nothing else uses it.

    The virtual root, the device mount, and the history view are
    permanent. The VFS is closed only when no remaining mount
    holds the same instance. Admitted calls and streams finish first;
    callers must consume or close streams. Closed instances cannot be
    mounted again. Commands and operations belong to each
    mount, so removing one leaves other mounts of the same kind intact.

    Args:
        registry (MountRegistry): the workspace's mount table.
        ops (Ops): the ops facade to detach the prefix from.
        prefix (str): the mount's virtual prefix.
        is_shutting_down: live admission check after asynchronous cleanup.
        shared_mounts: instances owned by another workspace.

    Raises:
        ValueError: the prefix names a permanent mount.
    """
    stripped = prefix.strip("/")
    norm = ("/" + stripped + "/" if stripped else "/")
    if norm == "/":
        raise ValueError(f"cannot unmount the virtual root: {prefix!r}")
    if norm == "/dev/":
        raise ValueError("cannot unmount reserved prefix: '/dev/'")
    if norm == HISTORY_PREFIX + "/":
        raise ValueError(f"cannot unmount history view: {HISTORY_PREFIX!r}")
    entry = registry.try_mount_for_prefix(prefix)
    if entry is None:
        raise ValueError(f"no mount at prefix: {norm!r}")
    if entry.retiring:
        raise ValueError(f"mount is being unmounted: {norm!r}")
    entry.retiring = True
    try:
        await clear_mount_cache(registry.file_cache, norm, [entry.vfs.index])
        if is_shutting_down():
            raise RuntimeError("Workspace is closed")
        if registry.try_mount_for_prefix(prefix) is not entry:
            raise ValueError(f"mount changed while unmounting: {prefix!r}")
        removed = registry.unmount(prefix)
    except BaseException:
        entry.retiring = False
        raise
    ops.unmount(prefix)
    remaining = registry.mounts()
    still_instance = any(m.vfs is removed.vfs for m in remaining)
    # The mount owns its op table, so dropping the mount drops the ops
    # with it; the facade keeps no second registry to clean up.
    if not still_instance and id(removed.vfs) not in shared_mounts:
        identity = id(removed.vfs)
        registry.retired_mounts[identity] = removed.vfs
        closing = asyncio.create_task(_close_vfs(removed))
        registry.retiring_mounts[identity] = closing
        closing.add_done_callback(partial(_release_vfs, registry, identity))
        await asyncio.shield(closing)


async def _close_vfs(entry: MountEntry) -> None:
    await entry.activity.wait()
    close = getattr(entry.vfs, "close", None)
    if callable(close):
        result = close()
        if inspect.isawaitable(result):
            await result


def _release_vfs(registry: MountRegistry, identity: int,
                 closing: asyncio.Task[None]) -> None:
    registry.retiring_mounts.pop(identity, None)
    # The caller may have been cancelled while shield kept cleanup alive.
    if not closing.cancelled():
        closing.exception()

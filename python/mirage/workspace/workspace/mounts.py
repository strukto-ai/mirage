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
from mirage.nfs.config import NFSConfig
from mirage.ops import Ops
from mirage.resource.base import BaseResource
from mirage.resource.history import HISTORY_PREFIX
from mirage.resource.ram import RAMResource
from mirage.types import KERNEL_BACKENDS, MountBackend, MountMode
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.mount import MountEntry
from mirage.workspace.mount.spec import Mount
from mirage.workspace.workspace.types import MountSpec, ResourceMount


def check_resource(prefix: str, resource: BaseResource) -> None:
    """Refuse a mount value that is not a resource, naming the mount.

    ``MountSpec.resource`` is annotated ``BaseResource`` but the class is
    a plain dataclass, so nothing enforced it and the wrong value rode
    all the way to ``install_mounts``, where it surfaced as
    ``'X' object has no attribute 'set_index'`` -- a method the caller
    never called, in a file they never touched, with no mount named.

    The coroutine arm is spelled out because it is the mistake this
    function exists for: 0.0.5 briefly made ``build_resource`` async, so
    every caller written against 0.0.3/0.0.4 handed the mount table an
    un-awaited coroutine.

    Args:
        prefix (str): the mount point the value was given for.
        resource (BaseResource): the value to check.

    Raises:
        TypeError: ``resource`` is a coroutine or not a BaseResource.
    """
    if inspect.iscoroutine(resource):
        raise TypeError(
            f"mount {prefix!r}: got a coroutine, not a resource. "
            "build_resource() is synchronous; if you wrote "
            "`await build_resource(...)` against 0.0.5, drop the await.")
    if not isinstance(resource, BaseResource):
        raise TypeError(f"mount {prefix!r}: expected a BaseResource, got "
                        f"{type(resource).__name__}")


def normalize_resources(resources: dict[str, ResourceMount],
                        default_mode: MountMode) -> list[MountSpec]:
    """Narrow every accepted ``resources`` spelling to one shape.

    Args:
        resources (dict[str, ResourceMount]): the constructor mapping.
        default_mode (MountMode): mode for entries that name none.

    Raises:
        TypeError: a tuple entry is not (resource, mode) or
            (resource, mode, command_limits), or an entry's resource is
            not a :class:`BaseResource`.
    """
    specs: list[MountSpec] = []
    for prefix, value in resources.items():
        if isinstance(value, Mount):
            specs.append(
                MountSpec(
                    prefix=prefix,
                    resource=value.resource,
                    mode=value.mode
                    if value.mode is not None else default_mode,
                    backend=value.backend,
                    mountpoint=value.mountpoint,
                    nfs_config=value.nfs_config,
                    command_limits=dict(value.command_limits or {}),
                ))
        elif isinstance(value, tuple):
            if len(value) not in (2, 3):
                raise TypeError("resource tuples must be (resource, mode) or "
                                "(resource, mode, command_limits)")
            command_limits = dict(
                value[2]) if len(value) == 3 and value[2] else {}
            specs.append(
                MountSpec(prefix=prefix,
                          resource=value[0],
                          mode=value[1],
                          command_limits=command_limits))
        else:
            specs.append(
                MountSpec(prefix=prefix, resource=value, mode=default_mode))
    for spec in specs:
        check_resource(spec.prefix, spec.resource)
    return specs


def kernel_targets(
    specs: list[MountSpec]
) -> list[tuple[str, MountBackend, str | None, "NFSConfig | None"]]:
    """Entries that also want a real mountpoint, in declaration order.

    The nfs config rides along because a declared mount is the only
    place a user can express it; without it, `backend=nfs` in a spec
    could not choose a port, an idle window, or a soft mount, and only
    the explicit ``add_nfs_mount`` could be tuned at all.

    Args:
        specs (list[MountSpec]): the normalized mount specs.
    """
    return [(s.prefix, s.backend, s.mountpoint, s.nfs_config) for s in specs
            if s.backend in KERNEL_BACKENDS]


def install_mounts(registry: MountRegistry, specs: list[MountSpec],
                   index: IndexConfig | None, default_mode: MountMode) -> bool:
    """Mount every spec, adding an implicit scratch root if none claims /.

    Args:
        registry (MountRegistry): the workspace's mount table.
        specs (list[MountSpec]): the normalized mount specs.
        index (IndexConfig | None): index config installed per resource.
        default_mode (MountMode): mode for the implicit root.

    Returns:
        bool: whether the root mount was synthesized.
    """
    for spec in specs:
        registry.check_resource_available(spec.resource)
        spec.resource.set_index(index)
        entry = registry.mount(spec.prefix, spec.resource, spec.mode)
        if spec.command_limits:
            entry.command_limits.update(spec.command_limits)
    implicit_root = registry.root_mount is None
    if implicit_root:
        registry.mount("/", RAMResource(), default_mode)
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
    indices = [entry.resource.index]
    indices.extend(m.resource.index for m in previous
                   if entry.prefix.startswith(m.prefix))
    entry.before_use = partial(clear_mount_cache, registry.file_cache,
                               entry.prefix, indices)


async def unmount(registry: MountRegistry, ops: Ops, prefix: str,
                  is_shutting_down: Callable[[], bool],
                  shared_resources: set[int]) -> None:
    """Remove one mount, closing its resource if nothing else uses it.

    The virtual root, the device mount, and the history view are
    permanent. The resource is closed only when no remaining mount
    holds the same instance. Admitted calls and streams finish first;
    callers must consume or close streams. Closed instances cannot be
    mounted again. Commands and operations belong to each
    mount, so removing one leaves other mounts of the same kind intact.

    Args:
        registry (MountRegistry): the workspace's mount table.
        ops (Ops): the ops facade to detach the prefix from.
        prefix (str): the mount's virtual prefix.
        is_shutting_down: live admission check after asynchronous cleanup.
        shared_resources: instances owned by another workspace.

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
        await clear_mount_cache(registry.file_cache, norm,
                                [entry.resource.index])
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
    still_instance = any(m.resource is removed.resource for m in remaining)
    # The mount owns its op table, so dropping the mount drops the ops
    # with it; the facade keeps no second registry to clean up.
    if not still_instance and id(removed.resource) not in shared_resources:
        identity = id(removed.resource)
        registry.retired_resources[identity] = removed.resource
        closing = asyncio.create_task(_close_resource(removed))
        registry.retiring_resources[identity] = closing
        closing.add_done_callback(
            partial(_release_resource, registry, identity))
        await asyncio.shield(closing)


async def _close_resource(entry: MountEntry) -> None:
    await entry.activity.wait()
    close = getattr(entry.resource, "close", None)
    if callable(close):
        result = close()
        if inspect.isawaitable(result):
            await result


def _release_resource(registry: MountRegistry, identity: int,
                      closing: asyncio.Task[None]) -> None:
    registry.retiring_resources.pop(identity, None)
    # The caller may have been cancelled while shield kept cleanup alive.
    if not closing.cancelled():
        closing.exception()

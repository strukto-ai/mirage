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

from mirage.cache.index import IndexConfig
from mirage.ops import Ops
from mirage.resource.history import HISTORY_PREFIX
from mirage.resource.ram import RAMResource
from mirage.types import KERNEL_BACKENDS, MountBackend, MountMode
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.spec import Mount
from mirage.workspace.workspace.types import MountSpec, ResourceMount


def normalize_resources(resources: dict[str, ResourceMount],
                        default_mode: MountMode) -> list[MountSpec]:
    """Narrow every accepted ``resources`` spelling to one shape.

    Args:
        resources (dict[str, ResourceMount]): the constructor mapping.
        default_mode (MountMode): mode for entries that name none.

    Raises:
        TypeError: a tuple entry is not (resource, mode) or
            (resource, mode, command_limits).
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
        spec.resource.set_index(index)
        entry = registry.mount(spec.prefix, spec.resource, spec.mode)
        if spec.command_limits:
            entry.command_limits.update(spec.command_limits)
    implicit_root = registry.root_mount is None
    if implicit_root:
        registry.mount("/", RAMResource(), default_mode)
    return implicit_root


async def unmount(registry: MountRegistry, ops: Ops, prefix: str) -> None:
    """Remove one mount, closing its resource if nothing else uses it.

    The virtual root, the device mount, and the history view are
    permanent. The resource is closed only when no remaining mount
    holds the same instance; its command registration is dropped only
    when no remaining mount holds the same kind.

    Args:
        registry (MountRegistry): the workspace's mount table.
        ops (Ops): the ops facade to detach the prefix from.
        prefix (str): the mount's virtual prefix.

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
    removed = registry.unmount(prefix)
    ops.unmount(prefix)
    remaining = registry.mounts()
    still_instance = any(m.resource is removed.resource for m in remaining)
    # The mount owns its op table, so dropping the mount drops the ops
    # with it; the facade keeps no second registry to clean up.
    if not still_instance:
        close = getattr(removed.resource, "close", None)
        if callable(close):
            result = close()
            if hasattr(result, "__await__"):
                await result

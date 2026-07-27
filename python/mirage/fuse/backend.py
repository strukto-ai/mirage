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

import posixpath
import sys

from mirage.ops import Ops
from mirage.types import KERNEL_BACKENDS, MountBackend

# FSKit mounts only under /Volumes. Anywhere else the mount fails with an
# opaque driver error, so the rule is enforced here rather than discovered
# at run time (github.com/strukto-ai/mirage#82).
FSKIT_MOUNT_ROOT = "/Volumes"


def resolve_backend(value: "str | MountBackend | None") -> MountBackend:
    """Coerce a user-supplied backend name into a MountBackend.

    Missing means VFS, everywhere: an absent ``backend`` in YAML, ``None``
    here, and the ``Mount`` dataclass default all resolve to the same thing.
    Callers that need a kernel mount say so explicitly rather than relying
    on this function to reinterpret an absent value.

    Args:
        value (str | MountBackend | None): the requested backend; None and
            the empty string mean VFS.

    Returns:
        MountBackend: the resolved backend.

    Raises:
        ValueError: the name is not a known backend.
    """
    if value is None or value == "":
        return MountBackend.VFS
    try:
        return MountBackend(str(value).lower())
    except ValueError:
        known = ", ".join(b.value for b in MountBackend)
        raise ValueError(
            f"unknown mount backend {value!r}; expected one of: {known}")


def require_kernel_backend(backend: MountBackend) -> None:
    """Reject a backend that registers nothing with the kernel.

    Args:
        backend (MountBackend): the resolved backend.

    Raises:
        ValueError: the backend is VFS, so there is no mount to make.
    """
    if backend not in KERNEL_BACKENDS:
        raise ValueError(
            f"backend {backend.value!r} does not register a mountpoint; it "
            "is served inside mirage's own filesystem, so there is nothing "
            "to mount")


def check_platform(backend: MountBackend) -> None:
    """Reject a backend the current platform cannot serve.

    Args:
        backend (MountBackend): the requested backend.

    Raises:
        RuntimeError: fskit was requested off macOS.
    """
    if backend is MountBackend.FSKIT and sys.platform != "darwin":
        raise RuntimeError(
            f"the fskit mount backend is macOS-only (running on "
            f"{sys.platform!r}); use backend='fuse'")


def check_mountpoint(backend: MountBackend, mountpoint: str) -> None:
    """Reject a mountpoint the backend cannot mount on.

    FSKit mounts only under /Volumes. This is measured, not assumed: issue
    #82 tried an fskit mount under /tmp and got "mount_macfuse: the file
    system is not available (1)", and the same mount succeeded once it moved
    to /Volumes. The cost is that /Volumes is root-owned, so mirage names
    its mountpoint there but never creates it.

    Args:
        backend (MountBackend): the requested backend.
        mountpoint (str): the intended mountpoint.

    Raises:
        ValueError: fskit was pointed outside /Volumes.
    """
    if backend is not MountBackend.FSKIT:
        return
    resolved = posixpath.normpath(mountpoint)
    if resolved != FSKIT_MOUNT_ROOT and not resolved.startswith(
            FSKIT_MOUNT_ROOT + "/"):
        raise ValueError(
            f"the fskit mount backend only mounts under {FSKIT_MOUNT_ROOT}; "
            f"got {mountpoint!r}")


def check_sizes(backend: MountBackend,
                ops: Ops,
                root_prefix: str = "") -> None:
    """Refuse an fskit mount that would serve silently empty files.

    FSKit drives reads from the size the filesystem reports and has no
    ``direct_io`` escape hatch, so a resource that cannot size a file
    without fetching it reports 0, the kernel issues no reads, and every
    such file comes back empty with exit code 0. That is worse than a
    failed mount, so it fails here by name instead.

    Args:
        backend (MountBackend): the requested backend.
        ops (Ops): the op facade whose mounts are being served.
        root_prefix (str): mount root, when the tree is scoped to one mount.

    Raises:
        RuntimeError: at least one mounted resource cannot size its files.
    """
    if backend is not MountBackend.FSKIT:
        return
    offenders = ops.unsized_mounts(root_prefix)
    if not offenders:
        return
    # resource_type may be a ResourceName enum member; print its value, not
    # the "ResourceName.SLACK" repr Python 3.12 gives a str-mixin Enum.
    listed = ", ".join(f"{prefix} ({getattr(name, 'value', name)})"
                       for prefix, name in offenders)
    raise RuntimeError(
        f"the fskit mount backend cannot serve resources whose file sizes "
        f"are only known after a read; these mounts would return empty "
        f"files: {listed}. Mount them with backend='fuse', or scope the "
        f"fskit mount to a byte-store resource (ram, disk, redis, s3, "
        f"gridfs).")


def prepare_backend(value: "str | MountBackend | None",
                    ops: Ops | None = None,
                    mountpoint: str | None = None,
                    root_prefix: str = "") -> MountBackend:
    """Resolve a backend for a kernel mount and run every guard it implies.

    One entry point, so a new mount path cannot pick up fskit support while
    silently skipping the macOS, /Volumes, or size checks. Callers that have
    not chosen a mountpoint yet pass None and call check_mountpoint later.

    Args:
        value (str | MountBackend | None): the requested backend.
        ops (Ops | None): op facade to size-check, when one is available.
        mountpoint (str | None): intended mountpoint, when already known.
        root_prefix (str): mount root, for scoping the size check.

    Returns:
        MountBackend: the validated kernel backend.
    """
    backend = resolve_backend(value)
    require_kernel_backend(backend)
    check_platform(backend)
    if mountpoint is not None:
        check_mountpoint(backend, mountpoint)
    if ops is not None:
        check_sizes(backend, ops, root_prefix)
    return backend

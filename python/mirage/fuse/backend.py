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

import logging
import posixpath
import sys

from mirage.mount.backend import require_kernel_backend, resolve_backend
from mirage.ops import Ops
from mirage.types import MountBackend

logger = logging.getLogger(__name__)

# FSKit mounts only under /Volumes. Anywhere else the mount fails with an
# opaque driver error, so the rule is enforced here rather than discovered
# at run time (github.com/strukto-ai/mirage#82).
FSKIT_MOUNT_ROOT = "/Volumes"


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
    """Warn when an fskit mount will serve size-unknown files as empty.

    FSKit drives reads from the size the filesystem reports and has no
    ``direct_io`` escape hatch, so a resource that cannot size a file
    without fetching it reports 0, the kernel issues no reads, and every
    such file comes back empty with exit code 0 (verified on a live fskit
    mount: the read clamp is pinned at lookup-time size and never
    refreshed, so hydrate-on-open does not help). The mount proceeds
    anyway: per-backend size push-down is closing this gap, and the
    degraded mounts are named loudly here rather than refused.

    Args:
        backend (MountBackend): the requested backend.
        ops (Ops): the op facade whose mounts are being served.
        root_prefix (str): mount root, when the tree is scoped to one mount.
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
    logger.warning(
        "the fskit mount backend cannot serve resources whose file sizes "
        "are only known after a read; size-unknown files under these "
        "mounts will read as empty: %s. Mount them with backend='fuse', "
        "or scope the fskit mount to a byte-store resource (ram, disk, "
        "redis, s3, gridfs).", listed)


def check_writes(backend: MountBackend,
                 ops: Ops,
                 root_prefix: str = "") -> None:
    """Warn when an fskit mount accepts writes the shim may corrupt.

    Measured on live fskit mounts, pinned in ``integ/fuse/truth_fskit.json``:
    the macFUSE FSKit shim flushes pages a file did not already have (a new
    file, an empty file, a truncate-then-write) as NUL bytes of the right
    length, and appended regions arrive intact or zeroed depending on cache
    state. Metadata ops (create, mkdir, rename, unlink) are reliable. The
    writer sees no error either way, so the corruption is silent; the mount
    proceeds with a warning naming the writable mounts.

    Args:
        backend (MountBackend): the requested backend.
        ops (Ops): the op facade whose mounts are being served.
        root_prefix (str): mount root, when the tree is scoped to one mount.
    """
    if backend is not MountBackend.FSKIT:
        return
    # /dev is mounted writable into every workspace, and a zeroed flush
    # cannot corrupt a discard/byte-source device, so it never warns.
    offenders = [(prefix, name)
                 for prefix, name in ops.writable_mounts(root_prefix)
                 if prefix.rstrip("/") != "/dev"]
    if not offenders:
        return
    listed = ", ".join(f"{prefix} ({getattr(name, 'value', name)})"
                       for prefix, name in offenders)
    logger.warning(
        "file data written through an fskit mount may be flushed by the "
        "macFUSE FSKit shim as zeroed pages (metadata ops are reliable; "
        "the writer sees no error): %s. Mount them read-only, or use "
        "backend='fuse' for writes.", listed)


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
        check_writes(backend, ops, root_prefix)
    return backend

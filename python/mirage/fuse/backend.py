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
from enum import Enum

from mirage.ops import Ops

# FSKit mounts only under /Volumes. Anywhere else the mount fails with an
# opaque driver error, so the rule is enforced here rather than discovered
# at run time (github.com/strukto-ai/mirage#82).
FSKIT_MOUNT_ROOT = "/Volumes"


class MountBackend(str, Enum):
    """Which kernel interface serves a mount.

    FUSE is the default everywhere and the only backend on Linux and
    Windows. FSKIT routes through macFUSE 5.x's FSKit shim, which needs no
    kernel extension but has no ``direct_io`` equivalent, so it can only
    serve resources whose files always have a known size.

    There is deliberately no ``auto``: auto-selecting fskit would silently
    break every API-backed mount, and an option whose safe value is always
    the default is a trap.
    """

    FUSE = "fuse"
    FSKIT = "fskit"


def resolve_backend(value: "str | MountBackend | None") -> MountBackend:
    """Coerce a user-supplied backend name into a MountBackend.

    Args:
        value (str | MountBackend | None): the requested backend; None and
            the empty string mean the default.

    Returns:
        MountBackend: the resolved backend.

    Raises:
        ValueError: the name is not a known backend.
    """
    if value is None or value == "":
        return MountBackend.FUSE
    if isinstance(value, MountBackend):
        return value
    try:
        return MountBackend(value.lower())
    except ValueError:
        known = ", ".join(b.value for b in MountBackend)
        raise ValueError(
            f"unknown mount backend {value!r}; expected one of: {known}")


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

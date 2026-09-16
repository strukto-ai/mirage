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
import socket
import sys

from mirage.mount.backend import require_kernel_backend, resolve_backend
from mirage.nfs.config import NFSConfig
from mirage.ops import Ops
from mirage.types import MountBackend

logger = logging.getLogger(__name__)

# Platforms whose mount command needs elevated privileges. macOS mounts a
# loopback NFS export as the invoking user; Linux reserves mount(2) for
# root unless an fstab entry says otherwise.
PRIVILEGED_PLATFORMS = ("linux", "win32")


def requires_privilege(platform: str | None = None) -> bool:
    """Whether mounting needs elevated privileges on this platform.

    Args:
        platform (str | None): platform tag to test; defaults to the
            running one.

    Returns:
        bool: True when the mount command must be run with privileges.
    """
    return (sys.platform
            if platform is None else platform).startswith(PRIVILEGED_PLATFORMS)


def check_platform_nfs(platform: str | None = None) -> None:
    """Refuse a platform whose mount command this backend cannot build.

    macOS and Linux both ship a kernel NFS client and a mount command
    the argv builder knows. Windows does not qualify yet: the client is
    Pro-only, ``mount.exe`` speaks a different grammar, and none of it
    has been exercised -- refusing loudly beats emitting a Linux-shaped
    command that cannot work, the same advisory stance the repo takes
    on FUSE-over-WinFsp.

    Args:
        platform (str | None): platform tag to test; defaults to the
            running one.

    Raises:
        RuntimeError: the platform is Windows.
    """
    tag = sys.platform if platform is None else platform
    if tag.startswith("win"):
        raise RuntimeError(
            "the nfs mount backend does not support Windows yet; use "
            "backend='fuse' with WinFsp")


def prepare_nfs_backend(value: "str | MountBackend | None") -> MountBackend:
    """Resolve and validate a backend for an NFS mount.

    One entry point, mirroring ``fuse.backend.prepare_backend``, so a new
    mount path cannot pick up NFS while skipping its guards.

    Args:
        value (str | MountBackend | None): the requested backend.

    Returns:
        MountBackend: always ``MountBackend.NFS``.

    Raises:
        ValueError: the backend is unknown, is not a kernel backend, or
            names a different kernel backend.
    """
    backend = resolve_backend(value)
    require_kernel_backend(backend)
    if backend is not MountBackend.NFS:
        raise ValueError(
            f"the nfs mount path serves backend='nfs'; got {backend.value!r}")
    return backend


def check_port_available(host: str, port: int) -> None:
    """Fail before starting a server on a port already in use.

    Bound before the server so a collision surfaces here, naming the
    port, rather than as an opaque failure from inside the extension.
    Port 0 always passes: it asks the OS to choose.

    Args:
        host (str): address the server will bind.
        port (int): port the server will bind; 0 means OS-assigned.

    Raises:
        OSError: the port is already bound.
    """
    if port == 0:
        return
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind((host, port))
        except OSError as err:
            raise OSError(
                err.errno,
                f"nfs port {port} on {host} is already in use: {err}") from err


def check_sizes_nfs(ops: Ops, root_prefix: str = "") -> None:
    """Warn when a mount will serve size-unknown files as empty.

    NFSv3 has no OPEN procedure, so the hydrate-on-open trick the FUSE
    adapter uses never fires, and the client stops reading at the size
    GETATTR reported. A resource that cannot size a file without
    fetching it therefore reports 0 and the file reads as empty. The
    mount proceeds: the degraded mounts are named loudly here rather
    than refused, matching what the fskit backend does with the same
    limitation.

    Args:
        ops (Ops): the op facade whose mounts are being served.
        root_prefix (str): mount root, when the tree is scoped.
    """
    offenders = ops.unsized_mounts(root_prefix)
    if not offenders:
        return
    listed = ", ".join(f"{prefix} ({getattr(name, 'value', name)})"
                       for prefix, name in offenders)
    logger.warning(
        "the nfs mount backend cannot serve resources whose file sizes are "
        "only known after a read; size-unknown files under these mounts "
        "will read as empty: %s. Mount them with backend='fuse', or scope "
        "the nfs mount to a byte-store resource (ram, disk, redis, s3, "
        "gridfs).", listed)


def prepare_nfs_mount(value: "str | MountBackend | None",
                      ops: Ops,
                      config: NFSConfig,
                      root_prefix: str = "") -> MountBackend:
    """Run every guard an NFS mount implies, in order.

    Args:
        value (str | MountBackend | None): the requested backend.
        ops (Ops): the op facade to serve.
        config (NFSConfig): host and port the server will bind.
        root_prefix (str): mount root, for scoping the size check.

    Returns:
        MountBackend: the validated backend.
    """
    backend = prepare_nfs_backend(value)
    check_platform_nfs()
    check_port_available(config.host, config.port)
    check_sizes_nfs(ops, root_prefix)
    if requires_privilege():
        logger.warning(
            "mounting an nfs export on %s needs elevated privileges, and "
            "mirage does not elevate for you: run this process with them, "
            "or the mount command fails with EPERM", sys.platform)
    return backend

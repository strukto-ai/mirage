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

from enum import Enum

from mirage.types import KERNEL_BACKENDS, MountBackend


class KernelRoute(Enum):
    """How a backend's mount is brought up, and by whom.

    The distinction is not cosmetic: it decides which call can mount a
    prefix at all. A THREAD backend hands the kernel a file descriptor
    and services it from a daemon thread, so it comes up inside a
    synchronous constructor. A LOOP backend is served by the caller's
    own event loop, so mounting one from a synchronous call would
    deadlock the loop that has to answer the kernel's first request.
    NONE never reaches the kernel at all.
    """

    NONE = "none"
    THREAD = "thread"
    LOOP = "loop"


# One row per MountBackend member. Exhaustive on purpose and checked as
# such: without the check, a backend added to the enum falls into
# whatever the last else branch happened to be, which is how a
# loop-served mount would end up being started from a constructor.
_ROUTES: dict[MountBackend, KernelRoute] = {
    MountBackend.VFS: KernelRoute.NONE,
    MountBackend.FUSE: KernelRoute.THREAD,
    MountBackend.FSKIT: KernelRoute.THREAD,
    MountBackend.NFS: KernelRoute.LOOP,
}


def route_of(backend: MountBackend) -> KernelRoute:
    """How this backend's mount has to be brought up.

    Args:
        backend (MountBackend): the resolved backend.

    Returns:
        KernelRoute: the route that mounts it.

    Raises:
        ValueError: the backend declares no route, which means the table
            above was not updated when the enum was.
    """
    route = _ROUTES.get(backend)
    if route is None:
        raise ValueError(
            f"backend {backend.value!r} declares no kernel route; add one to "
            "mirage/mount/backend.py rather than letting it default")
    return route


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

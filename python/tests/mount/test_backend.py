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

import pytest

from mirage.mount.backend import (KernelRoute, require_kernel_backend,
                                  resolve_backend, route_of)
from mirage.types import KERNEL_BACKENDS, MountBackend


def test_every_backend_declares_a_route():
    # The point of the table: a backend added to the enum has to say how
    # it is mounted, rather than falling into whatever branch came last.
    for backend in MountBackend:
        assert isinstance(route_of(backend), KernelRoute)


def test_the_kernel_backends_are_exactly_the_routed_ones():
    routed = {b for b in MountBackend if route_of(b) is not KernelRoute.NONE}

    assert routed == set(KERNEL_BACKENDS)


def test_a_thread_route_is_what_a_synchronous_constructor_can_mount():
    assert route_of(MountBackend.FUSE) is KernelRoute.THREAD
    assert route_of(MountBackend.FSKIT) is KernelRoute.THREAD


def test_nfs_is_served_by_the_callers_loop():
    # Mounting one from a synchronous call deadlocks the loop that has
    # to answer the kernel's first request.
    assert route_of(MountBackend.NFS) is KernelRoute.LOOP


def test_vfs_never_reaches_the_kernel():
    assert route_of(MountBackend.VFS) is KernelRoute.NONE


def test_resolve_backend_reads_a_missing_value_as_vfs():
    assert resolve_backend(None) is MountBackend.VFS
    assert resolve_backend("") is MountBackend.VFS


def test_resolve_backend_names_the_known_ones_when_it_refuses():
    with pytest.raises(ValueError, match="unknown mount backend"):
        resolve_backend("smb")


def test_require_kernel_backend_refuses_vfs():
    with pytest.raises(ValueError, match="does not register a mountpoint"):
        require_kernel_backend(MountBackend.VFS)

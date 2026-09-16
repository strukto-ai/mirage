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

import socket

import pytest

from mirage.nfs.backend import (check_platform_nfs, check_port_available,
                                check_sizes_nfs, prepare_nfs_backend,
                                requires_privilege)
from mirage.types import MountBackend


class FakeOps:

    def __init__(self, unsized: list[tuple[str, str]]) -> None:
        self._unsized = unsized

    def unsized_mounts(self, root_prefix: str = "") -> list[tuple[str, str]]:
        return self._unsized


def test_prepare_accepts_the_nfs_backend():
    assert prepare_nfs_backend("nfs") is MountBackend.NFS


def test_prepare_refuses_a_non_kernel_backend():
    with pytest.raises(ValueError, match="does not register a mountpoint"):
        prepare_nfs_backend("vfs")


def test_prepare_refuses_a_different_kernel_backend():
    with pytest.raises(ValueError, match="fuse"):
        prepare_nfs_backend("fuse")


def test_a_free_port_passes():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        free = probe.getsockname()[1]
    check_port_available("127.0.0.1", free)


def test_a_taken_port_is_refused_with_the_port_named():
    with socket.socket() as held:
        held.bind(("127.0.0.1", 0))
        held.listen(1)
        taken = held.getsockname()[1]
        with pytest.raises(OSError, match=str(taken)):
            check_port_available("127.0.0.1", taken)


def test_size_unknown_mounts_are_warned_about(caplog):
    check_sizes_nfs(FakeOps([("/slack/", "slack")]))
    assert "slack" in caplog.text


def test_no_warning_when_every_mount_can_size_its_files(caplog):
    check_sizes_nfs(FakeOps([]))
    assert caplog.text == ""


def test_privilege_requirement_is_platform_specific():
    assert requires_privilege("darwin") is False
    assert requires_privilege("linux") is True


def test_windows_is_refused_with_a_clear_error():
    # mount_args has no win32 branch and the Windows NFS client (Pro
    # only, mount.exe grammar) is untested; refusing loudly beats
    # emitting a Linux-shaped command that cannot work.
    with pytest.raises(RuntimeError) as exc:
        check_platform_nfs("win32")
    assert "windows" in str(exc.value).lower()


def test_macos_and_linux_pass_the_platform_check():
    check_platform_nfs("darwin")
    check_platform_nfs("linux")

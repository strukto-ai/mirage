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

import os
import socket
import struct
from pathlib import Path

import pytest

from mirage import Mount, MountBackend, MountMode, Workspace
from mirage.vfs.ram import RAMVFS


def null_call(port: int) -> int:
    body = struct.pack(">IIIIIIIIII", 7, 0, 2, 100003, 3, 0, 0, 0, 0, 0)
    with socket.create_connection(("127.0.0.1", port), timeout=5) as conn:
        conn.sendall(struct.pack(">I", len(body) | 0x8000_0000) + body)
        reply = conn.recv(4096)
    (xid,) = struct.unpack_from(">I", reply, 4)
    return int(xid)


class FakeMount:
    def __init__(
        self, monkeypatch: pytest.MonkeyPatch, refuse: bool = False
    ) -> None:
        self.mounted: list[tuple[int, str]] = []
        self.unmounted: list[str] = []
        self.refuse = refuse
        monkeypatch.setattr("mirage.mount.nfs.RESERVED_PORTS", 1 << 16)
        monkeypatch.setattr("mirage.workspace.nfs.mount_nfs", self.mount)
        monkeypatch.setattr(
            "mirage.workspace.nfs.unmount_nfs", self.unmounted.append
        )

    def mount(self, port: int, mountpoint: str) -> None:
        self.mounted.append((port, mountpoint))
        if self.refuse:
            raise RuntimeError("nfs mount refused")


def test_an_nfs_mount_serves_until_it_is_removed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fake = FakeMount(monkeypatch)
    with Workspace({"/a/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        mountpoint = ws.add_fuse_mount(
            "/a/", str(tmp_path / "mp"), backend=MountBackend.NFS
        )
        assert ws.fuse_mountpoints == {"/a/": mountpoint}
        port, at = fake.mounted[0]
        assert at == mountpoint
        assert null_call(port) == 7
        ws.remove_fuse_mount("/a/")
        assert fake.unmounted == [mountpoint]
        assert ws.fuse_mountpoints == {}
        with pytest.raises(OSError):
            null_call(port)


def test_a_refused_mount_stops_the_server_and_leaves_no_temp_dir(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = FakeMount(monkeypatch, refuse=True)
    with Workspace({"/a/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        with pytest.raises(RuntimeError, match="refused"):
            ws.add_fuse_mount("/a/", backend=MountBackend.NFS)
        assert ws.fuse_mountpoints == {}
        port, mountpoint = fake.mounted[0]
        assert not os.path.exists(mountpoint)
        with pytest.raises(OSError):
            null_call(port)


def test_a_declared_nfs_mount_comes_up_with_the_workspace(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fake = FakeMount(monkeypatch)
    mountpoint = str(tmp_path / "mp")
    mount = Mount(
        RAMVFS(),
        mode=MountMode.READ,
        backend=MountBackend.NFS,
        mountpoint=mountpoint,
    )
    with Workspace({"/a/": mount}) as ws:
        assert ws.fuse_mountpoints == {"/a/": mountpoint}
        assert fake.mounted[0][1] == mountpoint
    assert fake.unmounted == [mountpoint]


def test_a_mountpoint_is_kept_as_the_path_the_kernel_mounts(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fake = FakeMount(monkeypatch)
    (tmp_path / "base").mkdir()
    (tmp_path / "link").symlink_to(tmp_path / "base")
    kernel = os.path.join(os.path.realpath(tmp_path / "base"), "mp")
    with Workspace({"/a/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        ws.add_fuse_mount(
            "/a/", str(tmp_path / "link" / "mp"), backend=MountBackend.NFS
        )
        (tmp_path / "link").unlink()
        ws.remove_fuse_mount("/a/")
    assert fake.mounted[0][1] == kernel
    assert fake.unmounted == [kernel]

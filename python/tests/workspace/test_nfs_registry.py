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

import mirage.workspace.workspace.kernel_mounts as kernel_mounts
from mirage import Mount, MountBackend, MountMode, Workspace
from mirage.nfs.config import NFSConfig
from mirage.resource.ram import RAMResource
from mirage.workspace.nfs import NFSManager


class _FakeHandle:

    def __init__(self) -> None:
        self.stopped = False

    def port(self) -> int:
        return 20490

    def stop(self) -> None:
        self.stopped = True


class _FakeFS:

    def __init__(self) -> None:
        self.flushed = False

    async def flush_all(self) -> None:
        self.flushed = True


class _Kernel:
    """What the fakes record, so a test asserts on the wire, not a mock."""

    def __init__(self) -> None:
        self.starts = 0
        self.mounted: list[tuple[str, int, str]] = []
        self.unmounted: list[str] = []
        self.handle = _FakeHandle()
        # One per started server: a session-scoped mount starts a second
        # one, and a test that counted stops on a shared handle could
        # not tell which of them went away.
        self.handles: list[_FakeHandle] = []
        self.fs = _FakeFS()
        self.fail_setup = False
        self.sessions: list[object] = []

    @property
    def stopped(self) -> int:
        """How many started servers have been stopped."""
        return sum(1 for handle in self.handles if handle.stopped)


def _install(monkeypatch, kernel: _Kernel) -> None:
    """Route every NFSManager KernelMounts builds through the fakes."""

    async def start(_ops, _config, session=None):
        kernel.starts += 1
        kernel.sessions.append(session)
        handle = kernel.handle if not kernel.handles else _FakeHandle()
        kernel.handles.append(handle)
        return kernel.fs, handle

    async def mount(mountpoint: str,
                    port: int,
                    export: str,
                    config: NFSConfig | None = None) -> None:
        del config
        if kernel.fail_setup:
            raise RuntimeError("no kernel here")
        kernel.mounted.append((mountpoint, port, export))

    async def umount(mountpoint: str) -> None:
        kernel.unmounted.append(mountpoint)

    def build() -> NFSManager:
        return NFSManager(start_fn=start, mount_fn=mount, unmount_fn=umount)

    monkeypatch.setattr(kernel_mounts, "NFSManager", build)


def _ws(mountpoint: str | None = None) -> Workspace:
    options = {"backend": MountBackend.NFS}
    if mountpoint is not None:
        options["mountpoint"] = mountpoint
    return Workspace({"/data": Mount(RAMResource(), **options)},
                     mode=MountMode.WRITE)


@pytest.mark.asyncio
async def test_declared_mount_waits_for_ready(monkeypatch, tmp_path):
    kernel = _Kernel()
    _install(monkeypatch, kernel)
    point = str(tmp_path / "data")
    ws = _ws(point)
    try:
        assert ws.nfs_mountpoints == {}
        assert kernel.mounted == []
        await ws.nfs_ready()
        assert ws.nfs_mountpoints == {"/data": point}
        assert kernel.mounted == [(point, 20490, "/data")]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_execute_mounts_the_declaration(monkeypatch, tmp_path):
    kernel = _Kernel()
    _install(monkeypatch, kernel)
    point = str(tmp_path / "data")
    ws = _ws(point)
    try:
        await ws.execute("echo hi > /data/x.txt")
        assert ws.nfs_mountpoints == {"/data": point}
        assert kernel.starts == 1
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_nfs_mounts_are_not_fuse_mounts(monkeypatch, tmp_path):
    kernel = _Kernel()
    _install(monkeypatch, kernel)
    ws = _ws(str(tmp_path / "data"))
    try:
        await ws.nfs_ready()
        assert ws.fuse_mountpoints == {}
        assert ws.fuse_mountpoint is None
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_one_server_backs_every_prefix(monkeypatch, tmp_path):
    kernel = _Kernel()
    _install(monkeypatch, kernel)
    ws = _ws(str(tmp_path / "data"))
    try:
        await ws.nfs_ready()
        second = await ws.add_nfs_mount("/data/sub", str(tmp_path / "sub"))
        assert second == str(tmp_path / "sub")
        assert kernel.starts == 1
        assert set(ws.nfs_mountpoints) == {"/data", "/data/sub"}
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_remove_unmounts_one_prefix(monkeypatch, tmp_path):
    kernel = _Kernel()
    _install(monkeypatch, kernel)
    point = str(tmp_path / "data")
    ws = _ws(point)
    try:
        await ws.nfs_ready()
        await ws.remove_nfs_mount("/data")
        assert ws.nfs_mountpoints == {}
        assert kernel.unmounted == [point]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_close_unmounts_and_stops_the_server(monkeypatch, tmp_path):
    kernel = _Kernel()
    _install(monkeypatch, kernel)
    point = str(tmp_path / "data")
    ws = _ws(point)
    await ws.nfs_ready()
    await ws.close()
    assert kernel.unmounted == [point]
    assert kernel.fs.flushed
    assert kernel.handle.stopped
    assert ws.nfs_mountpoints == {}


@pytest.mark.asyncio
async def test_sync_routes_refuse_an_nfs_prefix(monkeypatch, tmp_path):
    kernel = _Kernel()
    _install(monkeypatch, kernel)
    ws = _ws(str(tmp_path / "data"))
    try:
        await ws.nfs_ready()
        with pytest.raises(RuntimeError, match="add_nfs_mount"):
            ws.add_fuse_mount("/other", backend="nfs")
        with pytest.raises(RuntimeError, match="remove_nfs_mount"):
            ws.remove_fuse_mount("/data")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_colliding_mountpoint_is_refused(monkeypatch, tmp_path):
    kernel = _Kernel()
    _install(monkeypatch, kernel)
    point = str(tmp_path / "shared")
    ws = _ws(point)
    try:
        await ws.nfs_ready()
        with pytest.raises(ValueError, match="already used by prefix"):
            await ws.add_nfs_mount("/data/sub", point)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_auto_mount_failure_leaves_a_usable_workspace(
        monkeypatch, tmp_path):
    kernel = _Kernel()
    kernel.fail_setup = True
    _install(monkeypatch, kernel)
    ws = _ws(str(tmp_path / "data"))
    try:
        result = await ws.execute("echo hi > /data/x.txt")
        assert result.exit_code == 0
        assert ws.nfs_mountpoints == {}
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_explicit_mount_raises_instead_of_degrading(
        monkeypatch, tmp_path):
    kernel = _Kernel()
    kernel.fail_setup = True
    _install(monkeypatch, kernel)
    ws = Workspace({"/data": RAMResource()}, mode=MountMode.WRITE)
    try:
        with pytest.raises(RuntimeError, match="no kernel here"):
            await ws.add_nfs_mount("/data", str(tmp_path / "data"))
        assert ws.nfs_mountpoints == {}
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_scoped_mount_gets_its_own_server(monkeypatch, tmp_path):
    # A server serves one delegate, so narrowing to a session cannot
    # reuse the unscoped one: the two views need two servers.
    kernel = _Kernel()
    _install(monkeypatch, kernel)
    ws = _ws(str(tmp_path / "data"))
    try:
        await ws.nfs_ready()
        ws.create_session("agent")
        scoped = await ws.add_nfs_mount("/data",
                                        str(tmp_path / "agent"),
                                        session_id="agent")
        assert scoped == str(tmp_path / "agent")
        assert kernel.starts == 2
        assert kernel.sessions[0] is None
        assert kernel.sessions[1] is not None
        assert set(ws.nfs_mountpoints) == {"/data", "/data@agent"}
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_one_session_shares_one_server(monkeypatch, tmp_path):
    kernel = _Kernel()
    _install(monkeypatch, kernel)
    ws = _ws(str(tmp_path / "data"))
    try:
        await ws.nfs_ready()
        ws.create_session("agent")
        await ws.add_nfs_mount("/data",
                               str(tmp_path / "a"),
                               session_id="agent")
        await ws.add_nfs_mount("/data/sub",
                               str(tmp_path / "b"),
                               session_id="agent")
        # The unscoped one plus one for the session, not one per mount.
        assert kernel.starts == 2
        assert set(
            ws.nfs_mountpoints) == {"/data", "/data@agent", "/data/sub@agent"}
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_sessions_server_stops_with_its_last_mount(
        monkeypatch, tmp_path):
    # It exists to serve that session's view; past the view it is a
    # delegate nothing can reach.
    kernel = _Kernel()
    _install(monkeypatch, kernel)
    ws = _ws(str(tmp_path / "data"))
    try:
        await ws.nfs_ready()
        ws.create_session("agent")
        await ws.add_nfs_mount("/data",
                               str(tmp_path / "agent"),
                               session_id="agent")
        await ws.remove_nfs_mount("/data", session_id="agent")
        assert ws.nfs_mountpoints == {"/data": str(tmp_path / "data")}
        assert kernel.stopped == 1
        # The unscoped server is untouched by the scoped one going away.
        await ws.execute("echo still-served > /data/x.txt")
    finally:
        await ws.close()

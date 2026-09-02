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

import asyncio

import pytest

from mirage.nfs.config import NFSConfig
from mirage.workspace.nfs import NFSManager


class FakeHandle:

    def __init__(self) -> None:
        self.stopped = False

    def port(self) -> int:
        return 12345

    def stop(self) -> None:
        self.stopped = True


class FakeFS:

    def __init__(self) -> None:
        self.flushed = 0

    async def flush_all(self) -> None:
        self.flushed += 1


class Recorder:
    """Injected start/mount/unmount fns, recording every call."""

    def __init__(self) -> None:
        self.handle = FakeHandle()
        self.fs = FakeFS()
        self.starts: list[NFSConfig] = []
        self.sessions: list[object] = []
        self.mounts: list[tuple[str, int, str]] = []
        self.mount_configs: list[NFSConfig | None] = []
        self.unmounts: list[str] = []

    async def start(self, ops, config, session=None):
        self.starts.append(config)
        self.sessions.append(session)
        return self.fs, self.handle

    async def mount(self, mountpoint: str, port: int, export: str,
                    config: NFSConfig | None) -> None:
        self.mounts.append((mountpoint, port, export))
        self.mount_configs.append(config)

    async def unmount(self, mountpoint: str) -> None:
        self.unmounts.append(mountpoint)


def make() -> tuple[NFSManager, Recorder]:
    rec = Recorder()
    manager = NFSManager(start_fn=rec.start,
                         mount_fn=rec.mount,
                         unmount_fn=rec.unmount)
    return manager, rec


def test_one_server_serves_many_mounts(tmp_path):
    manager, rec = make()

    async def run():
        a = await manager.setup(None, "/", str(tmp_path / "a"))
        b = await manager.setup(None, "/docs", str(tmp_path / "b"))
        return a, b

    a, b = asyncio.run(run())
    assert len(rec.starts) == 1
    assert rec.mounts == [(a, 12345, "/"), (b, 12345, "/docs")]
    assert manager.mountpoints == {"/": a, "/docs": b}


def test_export_path_is_the_prefix(tmp_path):
    manager, rec = make()
    asyncio.run(manager.setup(None, "/deep/tree", str(tmp_path / "m")))
    assert rec.mounts[0][2] == "/deep/tree"


def test_mountpoint_collision_is_refused(tmp_path):
    manager, rec = make()
    target = str(tmp_path / "same")

    async def run():
        await manager.setup(None, "/", target)
        with pytest.raises(ValueError):
            await manager.setup(None, "/docs", target)

    asyncio.run(run())
    assert len(rec.mounts) == 1


def test_collision_is_detected_before_the_path_is_touched(
        tmp_path, monkeypatch):
    # A colliding mountpoint may be a LIVE mount served by this very
    # loop; prepare_mountpoint stats it (makedirs -> isdir), which is
    # the self-touch deadlock. The registry check must come first.
    manager, rec = make()
    target = str(tmp_path / "same")
    touched: list[str] = []

    def spy_prepare(mountpoint):
        touched.append(mountpoint)
        return mountpoint, False

    import mirage.workspace.nfs as module
    monkeypatch.setattr(module, "prepare_mountpoint", spy_prepare)

    async def run():
        await manager.setup(None, "/", target)
        touched.clear()
        with pytest.raises(ValueError):
            await manager.setup(None, "/docs", target)

    asyncio.run(run())
    assert touched == []


def test_a_failed_mount_leaves_no_registration(tmp_path):
    rec = Recorder()

    async def failing_mount(mountpoint: str, port: int, export: str,
                            config: NFSConfig | None) -> None:
        del config
        raise RuntimeError("mount refused")

    manager = NFSManager(start_fn=rec.start,
                         mount_fn=failing_mount,
                         unmount_fn=rec.unmount)
    with pytest.raises(RuntimeError):
        asyncio.run(manager.setup(None, "/", str(tmp_path / "m")))
    assert manager.mountpoints == {}


def test_unmount_removes_one_mount(tmp_path):
    manager, rec = make()

    async def run():
        await manager.setup(None, "/", str(tmp_path / "a"))
        await manager.setup(None, "/docs", str(tmp_path / "b"))
        await manager.unmount("/")

    asyncio.run(run())
    assert rec.unmounts == [str(tmp_path / "a")]
    assert list(manager.mountpoints) == ["/docs"]


def test_close_unmounts_flushes_then_stops(tmp_path):
    manager, rec = make()

    async def run():
        await manager.setup(None, "/", str(tmp_path / "a"))
        await manager.close()

    asyncio.run(run())
    assert rec.unmounts == [str(tmp_path / "a")]
    assert rec.fs.flushed == 1
    assert rec.handle.stopped is True
    assert manager.mountpoints == {}


def test_close_is_idempotent_and_safe_before_setup():
    manager, rec = make()
    asyncio.run(manager.close())
    asyncio.run(manager.close())
    assert rec.unmounts == []


def test_the_mount_options_come_from_the_server_config(tmp_path):
    # The mount command carries the resilience knobs, so the seam has to
    # hand the same config to the mount that started the server: a
    # second mountpoint answering to different timeouts than the first
    # is a mount the teardown cannot reason about.
    manager, rec = make()
    config = NFSConfig(timeo=11, retrans=2)
    asyncio.run(manager.setup(None, "/", str(tmp_path / "a"), config))
    asyncio.run(manager.setup(None, "/docs", str(tmp_path / "b")))
    assert rec.mount_configs == [config, config]


def test_the_session_is_handed_to_the_server(tmp_path):
    # One server serves one delegate, so the scoping happens where the
    # server is started, not per mount.
    manager, rec = make()
    session = object()
    asyncio.run(manager.setup(None, "/", str(tmp_path / "a"), None, session))
    assert rec.sessions == [session]


def test_a_second_session_on_one_server_is_refused(tmp_path):
    # Silently serving the first session's view under the second's name
    # is the failure this prevents.
    manager, _ = make()
    asyncio.run(manager.setup(None, "/", str(tmp_path / "a"), None, object()))
    with pytest.raises(ValueError, match="different session"):
        asyncio.run(
            manager.setup(None, "/docs", str(tmp_path / "b"), None, object()))


def test_the_same_session_reuses_the_server(tmp_path):
    manager, rec = make()
    session = object()
    asyncio.run(manager.setup(None, "/", str(tmp_path / "a"), None, session))
    asyncio.run(
        manager.setup(None, "/docs", str(tmp_path / "b"), None, session))
    assert len(rec.starts) == 1
    assert len(manager.mountpoints) == 2

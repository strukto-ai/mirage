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
import os

import pytest

from mirage import MountMode, Workspace
from mirage.errors.types import QuotaExceededError
from mirage.types import PathSpec
from mirage.vfs.disk import DiskVFS
from mirage.vfs.disk import disk as disk_module
from mirage.vfs.errors import VFSConfigError


@pytest.mark.parametrize("value", ["no", 1, None])
def test_folder_versions_must_be_a_boolean(tmp_path, value):
    root = tmp_path / "root"
    with pytest.raises(VFSConfigError) as exc:
        DiskVFS(str(root), folder_versions=value)
    assert str(exc.value) == "disk: folder_versions: must be a boolean"
    assert not root.exists()


def test_a_capacity_that_is_not_a_size_is_refused(tmp_path):
    with pytest.raises(VFSConfigError, match="disk: capacity must be a size"):
        DiskVFS(str(tmp_path), capacity="1.5MB")


@pytest.mark.asyncio
@pytest.mark.skipif(
    os.geteuid() == 0, reason="root can read chmod 000 folders"
)
@pytest.mark.parametrize("mode", [0, 0o400])
async def test_a_capped_root_counts_past_an_unreadable_folder(
    tmp_path, mode, caplog
):
    locked = tmp_path / "locked"
    locked.mkdir()
    (locked / "hidden").write_bytes(b"x" * 100)
    data = DiskVFS(str(tmp_path), capacity=4)
    ws = Workspace({"/d": (data, MountMode.WRITE)})
    caplog.set_level("DEBUG", logger="mirage.core.disk.capacity")
    try:
        locked.chmod(mode)
        written = await ws.shell("printf hi > /d/a")
        report = await ws.shell("df /d")
        assert (written.exit_code, report.exit_code) == (0, 0)
        assert await written.stderr_str() == ""
        assert await report.stderr_str() == ""
        assert str(tmp_path) not in await report.stdout_str()
        assert "skipped while counting" in caplog.text
        assert (tmp_path / "a").read_bytes() == b"hi"
        assert data.usage is not None and data.usage.used == 2
        assert (await ws.shell("printf abc > /d/b")).exit_code == 1
        unreadable = await ws.shell("du /d")
        assert unreadable.exit_code == 1
        assert "Permission denied" in await unreadable.stderr_str()
        assert str(tmp_path) not in await unreadable.stderr_str()
    finally:
        locked.chmod(0o755)
        await ws.close()


@pytest.mark.asyncio
async def test_a_capped_root_counts_what_it_holds_and_refuses_growth(tmp_path):
    (tmp_path / "pre").write_bytes(b"xx")
    data = DiskVFS(str(tmp_path), capacity=12)
    ws = Workspace({"/d": (data, MountMode.WRITE)})
    try:
        assert (await ws.shell("printf 12345678 > /d/a")).exit_code == 0
        refused = await ws.shell("printf 123 > /d/b")
        assert refused.exit_code == 1
        assert await refused.stderr_str() == "/d/b: Disk quota exceeded\n"
        assert (
            await ws.shell("rm /d/a; printf 1234567 > /d/b")
        ).exit_code == 0
        assert (await ws.shell("cp /d/b /d/c")).exit_code == 1
        assert (await ws.shell("mv /d/b /d/c")).exit_code == 0
        assert (await ws.shell("truncate -s 13 /d/c")).exit_code == 1
        assert data.usage is not None and data.usage.used == 9
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.skipif(
    os.geteuid() == 0, reason="root can list execute-only folders"
)
@pytest.mark.parametrize(
    ("mode", "command"),
    [
        (0o111, "printf x > /d/locked/known"),
        (0o333, "rm /d/locked/known"),
        (0o333, "mv /d/locked/known /d/locked/other"),
        (0o333, "mv /d/locked /d/renamed; printf x > /d/renamed/known"),
    ],
)
async def test_skipped_bytes_never_credit_other_writes(
    tmp_path, mode, command
):
    locked = tmp_path / "locked"
    locked.mkdir()
    (locked / "known").write_bytes(b"x" * 100)
    (tmp_path / "plain").write_bytes(b"123")
    data = DiskVFS(str(tmp_path), capacity=4)
    ws = Workspace({"/d": (data, MountMode.WRITE)})
    try:
        locked.chmod(mode)
        changed = await ws.shell(command)
        assert changed.exit_code == 0, await changed.stderr_str()
        assert data.usage is not None and data.usage.used == 3
        assert (await ws.shell("printf 12 > /d/new")).exit_code == 1
        assert not (tmp_path / "new").exists()
        assert (await ws.shell("printf 1 > /d/new")).exit_code == 0
        assert data.usage.used == 4
    finally:
        (locked if locked.exists() else tmp_path / "renamed").chmod(0o755)
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.skipif(
    os.geteuid() == 0, reason="root can list execute-only folders"
)
async def test_reusing_a_skipped_directory_name_does_not_exempt_new_files(
    tmp_path,
):
    locked = tmp_path / "locked"
    locked.mkdir()
    (locked / "known").write_bytes(b"x" * 100)
    (tmp_path / "plain").write_bytes(b"123")
    data = DiskVFS(str(tmp_path), capacity=4)
    ws = Workspace({"/d": (data, MountMode.WRITE)})
    try:
        locked.chmod(0o333)
        assert (
            await ws.shell("mv /d/locked /d/renamed; mkdir /d/locked")
        ).exit_code == 0
        assert (await ws.shell("printf 12 > /d/locked/new")).exit_code == 1
        assert not (locked / "new").exists()
        assert (await ws.shell("printf 1 > /d/locked/new")).exit_code == 0
        assert data.usage is not None and data.usage.used == 4
    finally:
        (
            tmp_path / "renamed" if (tmp_path / "renamed").exists() else locked
        ).chmod(0o755)
        await ws.close()


@pytest.mark.asyncio
async def test_parallel_writers_never_pass_the_disk_cap(tmp_path):
    data = DiskVFS(str(tmp_path), capacity=10)
    ws = Workspace({"/d": (data, MountMode.WRITE)})
    try:
        results = await asyncio.gather(
            *(ws.shell(f"printf 123 > /d/f{i}") for i in range(20))
        )
        assert sum(r.exit_code == 0 for r in results) == 3
        on_disk = sum(f.stat().st_size for f in tmp_path.iterdir())
        assert data.usage is not None
        assert (data.usage.used, data.usage.pending) == (on_disk, 0)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_write_past_mirage_is_counted_after_the_caches_drop(tmp_path):
    data = DiskVFS(str(tmp_path), capacity=10)
    ws = Workspace({"/d": (data, MountMode.WRITE)})
    try:
        assert (await ws.shell("printf 12345 > /d/a")).exit_code == 0
        (tmp_path / "native").write_bytes(b"x" * 5)
        data.accessor.forget()
        assert (await ws.shell("printf 1 > /d/b")).exit_code == 1
        assert (await data.capacity()).used == 10
    finally:
        await ws.close()


def test_get_state_saves_the_capacity_only_when_capped(tmp_path):
    assert "capacity" not in DiskVFS(str(tmp_path)).get_state()["config"]
    state = DiskVFS(str(tmp_path), capacity=10).get_state()
    assert state["config"]["capacity"] == 10


@pytest.mark.asyncio
async def test_a_copy_past_what_it_reserved_is_cut_back(tmp_path, monkeypatch):
    (tmp_path / "src").write_bytes(b"x")
    data = DiskVFS(str(tmp_path), capacity=10)
    copy = disk_module._copy

    async def grown(accessor, src, dst):
        (tmp_path / "src").write_bytes(b"y" * 12)
        await copy(accessor, src, dst)

    monkeypatch.setattr(disk_module, "_copy", grown)
    with pytest.raises(QuotaExceededError):
        await data.copy(
            PathSpec.from_str_path("/src"), PathSpec.from_str_path("/dst")
        )
    assert (tmp_path / "dst").read_bytes() == b"y"


@pytest.mark.asyncio
async def test_a_contended_copy_with_room_keeps_its_bytes(
    tmp_path, monkeypatch
):
    (tmp_path / "src").write_bytes(b"y" * 4)
    (tmp_path / "dst").write_bytes(b"x" * 5)
    data = DiskVFS(str(tmp_path), capacity=100)
    copy = disk_module._copy

    async def contended(accessor, src, dst):
        assert data.usage is not None
        for held in data.usage.active:
            held.contended = True
        await copy(accessor, src, dst)

    monkeypatch.setattr(disk_module, "_copy", contended)
    await data.copy(
        PathSpec.from_str_path("/src"), PathSpec.from_str_path("/dst")
    )
    assert (tmp_path / "dst").read_bytes() == b"y" * 4

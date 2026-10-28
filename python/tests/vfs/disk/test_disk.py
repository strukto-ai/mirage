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

from mirage import MountMode, Workspace
from mirage.vfs.disk import DiskVFS
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

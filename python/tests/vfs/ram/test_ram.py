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
from mirage.types import CapacityResult, CapacityState, MountBackend
from mirage.vfs.dev import DevVFS
from mirage.vfs.errors import VFSConfigError
from mirage.vfs.ram import RAMVFS
from mirage.vfs.registry import build_vfs


@pytest.mark.asyncio
async def test_an_uncapped_ram_store_reports_no_capacity():
    assert RAMVFS().usage is None
    assert await RAMVFS().capacity() == CapacityResult(
        state=CapacityState.UNKNOWN
    )
    assert await DevVFS().capacity() == CapacityResult(
        state=CapacityState.UNKNOWN
    )


@pytest.mark.asyncio
async def test_a_capped_ram_store_counts_and_reports_its_quota():
    vfs = RAMVFS(capacity="1K")
    vfs.accessor.store.files["/a"] = b"1234"
    assert await vfs.capacity() == CapacityResult(
        state=CapacityState.QUOTA, total=1024, used=4, available=1020
    )
    del vfs.accessor.store.files["/a"]
    assert vfs.usage is not None and vfs.usage.used == 0


def test_a_capacity_that_is_not_a_size_is_refused_with_the_backend_name():
    with pytest.raises(VFSConfigError) as err:
        RAMVFS(capacity="1.5MB")
    assert str(err.value) == (
        'ram: capacity must be a size like 100MB, got "1.5MB"'
    )


def test_build_vfs_takes_capacity_from_the_ram_config():
    vfs = build_vfs("ram", {"capacity": "2K"})
    assert isinstance(vfs, RAMVFS)
    assert vfs.usage is not None and vfs.usage.limit == 2048


@pytest.mark.asyncio
async def test_load_state_recounts_the_store():
    vfs = RAMVFS(capacity=10)
    vfs.accessor.store.files["/old"] = b"12345678"
    vfs.load_state({"files": {"/a": b"123"}, "dirs": ["/"]})
    assert (await vfs.capacity()).used == 3


def test_get_state_saves_the_capacity_only_when_capped():
    assert "config" not in RAMVFS().get_state()
    assert RAMVFS(capacity=10).get_state()["config"] == {"capacity": 10}


async def _run(ws: Workspace, line: str) -> tuple[int, str]:
    result = await ws.shell(line)
    return result.exit_code, (await result.stderr_str())


@pytest.mark.asyncio
async def test_a_capped_store_refuses_growth_past_its_cap():
    data = RAMVFS(capacity=10)
    ws = Workspace({"/a": (data, MountMode.WRITE)})
    try:
        assert (await _run(ws, "printf 12345678 > /a/f"))[0] == 0
        code, err = await _run(ws, "printf 123 > /a/g")
        assert (code, err) == (1, "/a/g: Disk quota exceeded\n")
        assert data.usage is not None
        assert (data.usage.limit, data.usage.used) == (10, 8)
        assert (await _run(ws, "printf 12 > /a/g"))[0] == 0
        assert (await _run(ws, "printf 1 > /a/h"))[0] == 1
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_two_workspaces_on_one_store_share_its_cap():
    data = RAMVFS(capacity=4)
    first = Workspace({"/a": (data, MountMode.WRITE)})
    second = Workspace({"/x": (data, MountMode.WRITE)})
    try:
        assert (await _run(first, "printf 123 > /a/f"))[0] == 0
        await first.close()
        assert (await _run(second, "printf 12 > /x/g"))[0] == 1
        assert (await _run(second, "printf 1 > /x/g"))[0] == 0
    finally:
        await second.close()


@pytest.mark.asyncio
async def test_parallel_writers_never_pass_the_cap():
    data = RAMVFS(capacity=10)
    ws = Workspace({"/d": (data, MountMode.WRITE)})
    try:
        results = await asyncio.gather(
            *(ws.shell(f"printf 123 > /d/f{i}") for i in range(20)),
            ws.shell("seq 1 1000 > /d/s"),
        )
        landed = sum(r.exit_code == 0 for r in results[:20])
        assert landed <= 3
        files = data.accessor.store.files
        held = sum(len(files[key]) for key in files)
        assert data.usage is not None
        assert data.usage.used == held <= 10
        assert data.usage.pending == 0
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_store_over_its_cap_keeps_its_data_and_only_refuses_growth():
    data = RAMVFS(capacity=10)
    data.load_state({"files": {"/big": b"x" * 20}, "dirs": ["/"]})
    ws = Workspace({"/d": (data, MountMode.WRITE)})
    try:
        assert await _run(ws, "wc -c < /d/big") == (0, "")
        assert (await _run(ws, "printf 1 > /d/new"))[0] == 1
        assert (await _run(ws, "truncate -s 5 /d/big"))[0] == 0
        assert (await _run(ws, "printf 1234 > /d/new"))[0] == 0
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_nested_store_keeps_its_own_cap():
    ws = Workspace(
        {
            "/data": (RAMVFS(capacity=100), MountMode.WRITE),
            "/data/inner": (RAMVFS(capacity=4), MountMode.WRITE),
        }
    )
    try:
        assert (await _run(ws, "printf 12345 > /data/inner/f"))[0] == 1
        assert (await _run(ws, "printf 12345 > /data/f"))[0] == 0
    finally:
        await ws.close()


def test_a_backend_that_cannot_count_refuses_a_capacity():
    with pytest.raises(VFSConfigError, match="capacity"):
        build_vfs("s3", {"bucket": "b", "capacity": "1K"})


def test_a_capped_store_is_not_served_over_fuse_yet():
    ws = Workspace({"/d": (RAMVFS(capacity=10), MountMode.WRITE)})
    with pytest.raises(ValueError, match="cannot be served over fuse yet"):
        ws.add_fuse_mount("/d")
    with pytest.raises(ValueError, match="cannot be served over fskit yet"):
        ws.add_fuse_mount("/", backend="fskit")


def test_a_capped_store_added_under_a_fuse_mount_is_refused():
    ws = Workspace({"/d": (RAMVFS(), MountMode.WRITE)})
    ws._kernel_mounts._writable["/"] = ("/", MountBackend.FUSE)
    with pytest.raises(ValueError, match="cannot be served over fuse yet"):
        ws.add_mount("/e", RAMVFS(capacity=10), MountMode.WRITE)
    ws.add_mount("/f", RAMVFS(), MountMode.WRITE)

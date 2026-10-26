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
import threading
import time
from itertools import count
from pathlib import Path

import aiofiles.os
import pytest

import mirage.workspace.record.disk as disk
from mirage.workspace.record.disk import DiskRecordClient


@pytest.mark.asyncio
async def test_three_prefixes_under_one_root_do_not_collide(tmp_path: Path):
    # The whole reason this is its own tier: sessions, the namespace node
    # table and workspace metadata are three tables persisted the same
    # way, and they share a root. A record named "a" in one must not be
    # the record named "a" in another.
    sessions = DiskRecordClient(str(tmp_path), "sessions/")
    meta = DiskRecordClient(str(tmp_path), "workspaces/")
    nodes = DiskRecordClient(str(tmp_path), "")
    await sessions.put("a", {"who": "session"})
    await meta.put("a", {"who": "meta"})
    await nodes.put("a", {"who": "node"})
    assert (await sessions.get("a"))[0] == {"who": "session"}
    assert (await meta.get("a"))[0] == {"who": "meta"}
    assert (await nodes.get("a"))[0] == {"who": "node"}


@pytest.mark.asyncio
async def test_a_name_that_is_not_a_filename_round_trips(tmp_path: Path):
    # A record name is a key, not a path: the namespace table keys on
    # virtual paths, so slashes have to survive a round trip through a
    # filename rather than opening a directory.
    client = DiskRecordClient(str(tmp_path), "")
    await client.put("/ram/a b.txt", {"target": "x"})
    assert (await client.get("/ram/a b.txt"))[0] == {"target": "x"}
    assert await client.list_names() == ["/ram/a b.txt"]


@pytest.mark.asyncio
async def test_cas_put_refuses_a_stale_generation(tmp_path: Path):
    client = DiskRecordClient(str(tmp_path), "")
    assert await client.cas_put("k", {"generation": 1}, 0)
    assert not await client.cas_put("k", {"generation": 1}, 0)
    assert await client.cas_put("k", {"generation": 2}, 1)


@pytest.mark.asyncio
async def test_concurrent_writers_lose_nothing(tmp_path: Path):
    # The lockfile is a filesystem-atomic mutex, so a lost update here
    # would silently drop one worker's write.
    client = DiskRecordClient(str(tmp_path), "")
    await client.put("k", {"generation": 0, "hits": []})

    async def bump(worker: str) -> None:
        for _ in range(5):
            while True:
                current, _ = await client.get("k")
                current = current or {"generation": 0, "hits": []}
                nxt = {
                    "generation": current["generation"] + 1,
                    "hits": [*current["hits"], worker],
                }
                if await client.cas_put("k", nxt, current["generation"]):
                    break

    await asyncio.gather(bump("a"), bump("b"))
    stored, _ = await client.get("k")
    assert stored["generation"] == 10
    assert sorted(stored["hits"]) == ["a"] * 5 + ["b"] * 5


@pytest.mark.asyncio
@pytest.mark.parametrize("cas", [False, True])
async def test_cancel_during_acquisition_releases_lock(
    tmp_path, monkeypatch, cas
):
    entered = threading.Event()
    release = threading.Event()
    fds = []
    original = disk._acquire_lock

    def acquire(path):
        fd = original(path)
        fds.append(fd)
        entered.set()
        assert release.wait(5)
        return fd

    monkeypatch.setattr(disk, "_acquire_lock", acquire)
    client = DiskRecordClient(str(tmp_path), "")
    work = (
        client.cas_put("k", {"generation": 1}, 0) if cas else client.lock("k")
    )
    task = asyncio.create_task(work)
    try:
        assert await asyncio.to_thread(entered.wait, 5)
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
    finally:
        release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert not Path(client.path("k") + ".lock").exists()
    with pytest.raises(OSError):
        os.fstat(fds[0])
    monkeypatch.setattr(disk, "_acquire_lock", original)
    assert await client.cas_put("k", {"generation": 1}, 0)


LATE_STEPS = pytest.mark.parametrize(
    "late_step", ["unlink", "open"], ids=["together", "after"]
)


def _race_two_reclaimers(monkeypatch, lock_path: str, late_step: str) -> None:
    """Hold the first two stats of ``lock_path`` until both have run, then
    delay the later waiter's ``late_step``: its unlink of the lock (both
    reclaim at once) or its open of the reclaim guard (it reclaims after
    the earlier waiter has taken a new lock).

    Args:
        monkeypatch (pytest.MonkeyPatch): the test's patcher.
        lock_path (str): the lockfile both waiters contend for.
        late_step (str): ``"unlink"`` or ``"open"``, the os call delayed.
    """
    both_saw_it = threading.Barrier(2)
    stats = count()
    late_calls = count()
    late_path = lock_path if late_step == "unlink" else f"{lock_path}.reclaim"
    real_stat = os.stat
    real_late = getattr(os, late_step)

    def stat(path, *args, **kwargs):
        result = real_stat(path, *args, **kwargs)
        if path == lock_path and next(stats) < 2:
            both_saw_it.wait(5)
        return result

    def late(path, *args, **kwargs):
        if path == late_path and next(late_calls) == 1:
            time.sleep(0.2)
        return real_late(path, *args, **kwargs)

    monkeypatch.setattr(os, "stat", stat)
    monkeypatch.setattr(os, late_step, late)


def _stale_lock(client: DiskRecordClient, name: str) -> str:
    lock_path = client.path(name) + ".lock"
    Path(lock_path).write_text("424242")
    os.utime(lock_path, (0, 0))
    return lock_path


@pytest.mark.asyncio
@LATE_STEPS
async def test_two_reclaimers_of_one_stale_lock_never_both_hold_it(
    tmp_path, monkeypatch, late_step
):
    client = DiskRecordClient(str(tmp_path), "")
    _race_two_reclaimers(monkeypatch, _stale_lock(client, "k"), late_step)
    inside = 0
    most = 0

    async def hold() -> None:
        nonlocal inside, most
        fd = await client.lock("k")
        inside += 1
        most = max(most, inside)
        await asyncio.sleep(0.3)
        inside -= 1
        await client.unlock("k", fd)

    await asyncio.gather(hold(), hold())
    assert most == 1
    assert os.listdir(tmp_path) == []


@pytest.mark.asyncio
@LATE_STEPS
async def test_two_claims_over_one_stale_lock_have_one_winner(
    tmp_path, monkeypatch, late_step
):
    client = DiskRecordClient(str(tmp_path), "")
    await client.put("ws", {"generation": 0, "owner": None})
    _race_two_reclaimers(monkeypatch, _stale_lock(client, "ws"), late_step)
    read = client.get

    async def slow_get(name: str):
        found = await read(name)
        await asyncio.sleep(0.3)
        return found

    monkeypatch.setattr(client, "get", slow_get)
    won = await asyncio.gather(
        client.cas_put("ws", {"generation": 1, "owner": "alice"}, 0),
        client.cas_put("ws", {"generation": 1, "owner": "bob"}, 0),
    )
    assert sorted(won) == [False, True]
    assert sorted(os.listdir(tmp_path)) == ["ws.json"]


@pytest.mark.asyncio
async def test_release_leaves_a_lock_another_writer_took(tmp_path):
    client = DiskRecordClient(str(tmp_path), "")
    mine = await client.lock("k")
    lock_path = client.path("k") + ".lock"
    os.unlink(lock_path)
    theirs = await client.lock("k")
    await client.unlock("k", mine)
    assert os.path.exists(lock_path)
    await client.unlock("k", theirs)
    assert not os.path.exists(lock_path)


@pytest.mark.asyncio
async def test_a_record_reaches_the_disk_before_it_is_renamed_in(
    tmp_path, monkeypatch
):
    steps: list[tuple[str, int]] = []
    real_fsync = os.fsync
    real_replace = aiofiles.os.replace

    def fsync(fd: int) -> None:
        steps.append(("fsync", os.fstat(fd).st_ino))
        real_fsync(fd)

    async def replace(src: str, dst: str) -> None:
        steps.append(("replace", os.stat(src).st_ino))
        await real_replace(src, dst)

    monkeypatch.setattr(os, "fsync", fsync)
    monkeypatch.setattr(aiofiles.os, "replace", replace)
    client = DiskRecordClient(str(tmp_path), "")
    await client.put("k", {"generation": 0})
    record = os.stat(client.path("k")).st_ino
    assert steps == [("fsync", record), ("replace", record)]

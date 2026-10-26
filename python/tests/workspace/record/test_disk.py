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
import errno
import json
import os
import threading
import time
from itertools import count
from pathlib import Path
from types import SimpleNamespace
from typing import Literal

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


def _race_two_reclaimers(
    monkeypatch, lock_path: str, late_step: Literal["unlink", "open"]
) -> None:
    """Hold the first two stats of ``lock_path`` until both have run, then
    delay the later waiter's ``late_step``: its unlink of the lock (both
    reclaim at once) or its open of the reclaim guard (it reclaims after
    the earlier waiter has taken a new lock).

    Args:
        monkeypatch (pytest.MonkeyPatch): the test's patcher.
        lock_path (str): the lockfile both waiters contend for.
        late_step (Literal["unlink", "open"]): the os call delayed.
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


def _stale_lock(
    client: DiskRecordClient, name: str, suffix: str = ".lock"
) -> str:
    lock_path = client.path(name) + suffix
    Path(lock_path).write_text("424242")
    old = time.time() - 100
    os.utime(lock_path, (old, old))
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
async def test_a_stale_guard_does_not_cost_the_next_claim(tmp_path):
    client = DiskRecordClient(str(tmp_path), "")
    _stale_lock(client, "k")
    _stale_lock(client, "k", ".lock.reclaim")
    assert await client.cas_put("k", {"generation": 1}, 0)
    assert os.listdir(tmp_path) == ["k.json"]


@pytest.mark.asyncio
async def test_a_guard_reclaimed_mid_reclaim_still_lets_the_claim_win(
    tmp_path, monkeypatch
):
    client = DiskRecordClient(str(tmp_path), "")
    lock_path = _stale_lock(client, "k")
    stats = count()
    real_stat = os.stat

    def stat(path, *args, **kwargs):
        if path == lock_path and next(stats) == 1:
            os.unlink(f"{lock_path}.reclaim")
        return real_stat(path, *args, **kwargs)

    monkeypatch.setattr(os, "stat", stat)
    assert await client.cas_put("k", {"generation": 1}, 0)
    assert os.listdir(tmp_path) == ["k.json"]


@pytest.mark.asyncio
async def test_a_reclaimer_that_loses_the_guard_leaves_the_lock(
    tmp_path, monkeypatch
):
    client = DiskRecordClient(str(tmp_path), "")
    lock_path = _stale_lock(client, "k")
    guard = _stale_lock(client, "k", ".lock.reclaim")
    opens = count()
    real_open = os.open

    def open_(path, *args, **kwargs):
        if path == guard and next(opens) == 1:
            raise FileExistsError(guard)
        return real_open(path, *args, **kwargs)

    monkeypatch.setattr(os, "open", open_)
    assert not disk._reclaim_stale_lock(lock_path)
    assert os.listdir(tmp_path) == ["k.json.lock"]


@pytest.mark.asyncio
async def test_release_leaves_a_lock_another_writer_took(tmp_path):
    client = DiskRecordClient(str(tmp_path), "")
    mine = await client.lock("k")
    lock_path = client.path("k") + ".lock"
    os.unlink(lock_path)
    theirs = await client.lock("k")
    await client.unlock("k", mine)
    assert os.listdir(tmp_path) == ["k.json.lock"]
    await client.unlock("k", theirs)
    assert os.listdir(tmp_path) == []


def _refuse_full_sync(fd: int, cmd: int) -> None:
    raise OSError(errno.ENOTSUP, "full sync not supported")


@pytest.mark.asyncio
@pytest.mark.parametrize("platform", ["darwin", "linux"])
async def test_a_record_reaches_the_disk_before_it_is_renamed_in(
    tmp_path, monkeypatch, platform
):
    steps: list[tuple[str, int, int]] = []
    real_fsync = os.fsync
    real_replace = aiofiles.os.replace

    def synced(fd: int, how: str) -> None:
        held = os.fstat(fd)
        steps.append((how, held.st_size, held.st_ino))

    def full_sync(fd: int, cmd: int) -> None:
        synced(fd, "full sync")

    def fsync(fd: int) -> None:
        synced(fd, "fsync")
        real_fsync(fd)

    async def replace(src: str, dst: str) -> None:
        moved = os.stat(src)
        steps.append(("replace", moved.st_size, moved.st_ino))
        await real_replace(src, dst)

    fake = SimpleNamespace(F_FULLFSYNC=51, fcntl=full_sync)
    monkeypatch.setattr(disk.sys, "platform", platform)
    monkeypatch.setattr(disk, "fcntl", fake, raising=False)
    monkeypatch.setattr(os, "fsync", fsync)
    monkeypatch.setattr(aiofiles.os, "replace", replace)
    client = DiskRecordClient(str(tmp_path), "")
    await client.put("k", {"generation": 0})
    body = len(json.dumps({"generation": 0}))
    record = os.stat(client.path("k")).st_ino
    how = "full sync" if platform == "darwin" else "fsync"
    assert steps == [(how, body, record), ("replace", body, record)]


@pytest.mark.asyncio
async def test_a_volume_without_full_sync_falls_back_to_fsync(
    tmp_path, monkeypatch
):
    sizes: list[int] = []
    real_fsync = os.fsync

    def fsync(fd: int) -> None:
        sizes.append(os.fstat(fd).st_size)
        real_fsync(fd)

    fake = SimpleNamespace(F_FULLFSYNC=51, fcntl=_refuse_full_sync)
    monkeypatch.setattr(disk.sys, "platform", "darwin")
    monkeypatch.setattr(disk, "fcntl", fake, raising=False)
    monkeypatch.setattr(os, "fsync", fsync)
    client = DiskRecordClient(str(tmp_path), "")
    await client.put("k", {"generation": 0})
    assert sizes == [len(json.dumps({"generation": 0}))]


@pytest.mark.asyncio
async def test_release_closes_the_lock_before_unlinking_it(
    tmp_path, monkeypatch
):
    client = DiskRecordClient(str(tmp_path), "")
    fd = await client.lock("k")
    lock_path = client.path("k") + ".lock"
    steps: list[str] = []
    real_close = os.close
    real_unlink = os.unlink

    def close(target: int) -> None:
        if target == fd:
            steps.append("close")
        real_close(target)

    def unlink(path, *args, **kwargs):
        if path == lock_path:
            steps.append("unlink")
        return real_unlink(path, *args, **kwargs)

    monkeypatch.setattr(os, "close", close)
    monkeypatch.setattr(os, "unlink", unlink)
    await client.unlock("k", fd)
    assert steps == ["close", "unlink"]


@pytest.mark.asyncio
@pytest.mark.parametrize("after_check", [False, True], ids=["before", "after"])
async def test_release_survives_its_lock_vanishing(
    tmp_path, monkeypatch, after_check
):
    client = DiskRecordClient(str(tmp_path), "")
    fd = await client.lock("k")
    lock_path = client.path("k") + ".lock"
    real_stat = os.stat

    def stat(path, *args, **kwargs):
        found = real_stat(path, *args, **kwargs)
        if path == lock_path:
            os.unlink(path)
        return found

    if after_check:
        monkeypatch.setattr(os, "stat", stat)
    else:
        os.unlink(lock_path)
    await client.unlock("k", fd)
    assert os.listdir(tmp_path) == []

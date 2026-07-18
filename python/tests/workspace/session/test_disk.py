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
import json
import os
import sys

import pytest

from mirage.workspace.session.disk import DiskSessionStore

CHILD_SCRIPT = """
import asyncio
import sys

from mirage.workspace.session.disk import DiskSessionStore


async def main(root, worker):
    store = DiskSessionStore(root)
    for _ in range(5):
        for _ in range(500):
            record = (await store.load()).get("hot", {
                "session_id": "hot",
                "env": {},
            })
            env = dict(record.get("env", {}))
            env[worker] = str(int(env.get(worker, "0")) + 1)
            expected = int(record.get("generation", 0))
            fields = dict(record)
            fields["env"] = env
            fields["generation"] = expected + 1
            if await store.cas_set("hot", fields, expected):
                break
            await asyncio.sleep(0.001)
        else:
            raise SystemExit(2)
    await store.close()


asyncio.run(main(sys.argv[1], sys.argv[2]))
"""


async def cas_increment(store: DiskSessionStore, worker: str,
                        rounds: int) -> None:
    """Read-modify-CAS one counter, retrying until each round lands."""
    for _ in range(rounds):
        for _ in range(200):
            record = (await store.load()).get("hot", {
                "session_id": "hot",
                "env": {},
            })
            env = dict(record.get("env", {}))
            env[worker] = str(int(env.get(worker, "0")) + 1)
            expected = int(record.get("generation", 0))
            fields = dict(record)
            fields["env"] = env
            fields["generation"] = expected + 1
            if await store.cas_set("hot", fields, expected):
                break
            await asyncio.sleep(0)
        else:
            raise AssertionError("cas retry budget exhausted")


@pytest.mark.asyncio
async def test_set_load_roundtrip(tmp_path):
    store = DiskSessionStore(str(tmp_path))
    await store.set("s1", {"session_id": "s1", "cwd": "/a", "env": {}})
    await store.set(
        "s2", {
            "session_id": "s2",
            "cwd": "/",
            "env": {
                "K": "v"
            },
            "mount_modes": {
                "/data": "read"
            }
        })
    entries = await store.load()
    await store.close()
    assert entries["s1"]["cwd"] == "/a"
    assert entries["s2"]["mount_modes"] == {"/data": "read"}
    assert (tmp_path / "sessions" / "s1.json").is_file()


@pytest.mark.asyncio
async def test_delete_and_replace_all(tmp_path):
    store = DiskSessionStore(str(tmp_path))
    await store.set("a", {"session_id": "a"})
    await store.set("b", {"session_id": "b"})
    await store.delete(["a", "missing"])
    assert set(await store.load()) == {"b"}
    await store.replace_all({"c": {"session_id": "c"}})
    assert set(await store.load()) == {"c"}
    await store.clear()
    assert await store.load() == {}
    await store.close()


@pytest.mark.asyncio
async def test_cas_create_only_once(tmp_path):
    store = DiskSessionStore(str(tmp_path))
    first = {"session_id": "s", "generation": 1}
    assert await store.cas_set("s", first, 0) is True
    assert await store.cas_set("s", {
        "session_id": "s",
        "generation": 1
    }, 0) is False
    await store.close()
    stored = json.loads((tmp_path / "sessions" / "s.json").read_bytes())
    assert stored == first


@pytest.mark.asyncio
async def test_cas_stale_generation_rejected(tmp_path):
    store = DiskSessionStore(str(tmp_path))
    await store.set("s", {"session_id": "s", "generation": 2})
    assert await store.cas_set("s", {
        "session_id": "s",
        "generation": 2
    }, 1) is False
    assert await store.cas_set("s", {
        "session_id": "s",
        "cwd": "/x",
        "generation": 3
    }, 2) is True
    entries = await store.load()
    await store.close()
    assert entries["s"]["cwd"] == "/x"


@pytest.mark.asyncio
async def test_cas_legacy_record_counts_as_generation_zero(tmp_path):
    store = DiskSessionStore(str(tmp_path))
    await store.set("s", {"session_id": "s"})
    assert await store.cas_set("s", {
        "session_id": "s",
        "generation": 1
    }, 0) is True
    await store.close()


@pytest.mark.asyncio
async def test_cas_lock_held_by_live_writer_loses(tmp_path):
    store = DiskSessionStore(str(tmp_path))
    await store.set("s", {"session_id": "s", "generation": 1})
    lock = tmp_path / "sessions" / "s.json.lock"
    lock.write_bytes(b"9999999")
    assert await store.cas_set("s", {
        "session_id": "s",
        "generation": 2
    }, 1) is False
    lock.unlink()
    assert await store.cas_set("s", {
        "session_id": "s",
        "generation": 2
    }, 1) is True
    await store.close()


@pytest.mark.asyncio
async def test_cas_stale_lock_reclaimed(tmp_path):
    store = DiskSessionStore(str(tmp_path))
    await store.set("s", {"session_id": "s", "generation": 1})
    lock = tmp_path / "sessions" / "s.json.lock"
    lock.write_bytes(b"424242")
    stale = 100.0
    os.utime(lock,
             (lock.stat().st_atime - stale, lock.stat().st_mtime - stale))
    assert await store.cas_set("s", {
        "session_id": "s",
        "generation": 2
    }, 1) is True
    assert not lock.exists()
    await store.close()


@pytest.mark.asyncio
async def test_session_id_with_slash_stays_one_file(tmp_path):
    store = DiskSessionStore(str(tmp_path))
    await store.set("a/b", {"session_id": "a/b"})
    assert set(await store.load()) == {"a/b"}
    files = [p.name for p in (tmp_path / "sessions").iterdir()]
    assert files == ["a%2Fb.json"]
    await store.close()


@pytest.mark.asyncio
async def test_no_tmp_or_lock_leftovers(tmp_path):
    store = DiskSessionStore(str(tmp_path))
    await store.set("s", {"session_id": "s"})
    assert await store.cas_set("s", {"session_id": "s", "generation": 1}, 0)
    assert not await store.cas_set("s", {
        "session_id": "s",
        "generation": 1
    }, 0)
    await store.close()
    leftovers = [
        p.name for p in (tmp_path / "sessions").iterdir()
        if not p.name.endswith(".json")
    ]
    assert leftovers == []


@pytest.mark.asyncio
async def test_concurrent_cas_writers_lose_nothing(tmp_path):
    store = DiskSessionStore(str(tmp_path))
    workers = [f"w{i}" for i in range(5)]
    await asyncio.gather(*(cas_increment(store, worker, 5)
                           for worker in workers))
    record = (await store.load())["hot"]
    await store.close()
    assert record["generation"] == 25
    assert all(record["env"][worker] == "5" for worker in workers)


@pytest.mark.asyncio
async def test_cross_process_cas_writers_lose_nothing(tmp_path):
    """The lockfile protocol's whole point: separate OS processes CAS
    the same record without losing an update."""
    procs = [
        await
        asyncio.create_subprocess_exec(sys.executable, "-c", CHILD_SCRIPT,
                                       str(tmp_path), f"p{i}")
        for i in range(3)
    ]
    codes = await asyncio.gather(*(p.wait() for p in procs))
    assert codes == [0, 0, 0]
    store = DiskSessionStore(str(tmp_path))
    record = (await store.load())["hot"]
    await store.close()
    assert record["generation"] == 15
    assert all(record["env"][f"p{i}"] == "5" for i in range(3))

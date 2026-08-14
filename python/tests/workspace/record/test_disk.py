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
from pathlib import Path

import pytest

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

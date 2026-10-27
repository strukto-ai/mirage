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
import threading

import pytest

from mirage.shell.console import Channel
from mirage.shell.job_table.ram import RAMJobStore
from mirage.workspace.record.types import generation_of


def _list(*names: str, generation: int = 1) -> dict:
    return {
        "next": len(names) + 1,
        "jobs": {str(i + 1): {"console": n} for i, n in enumerate(names)},
        "generation": generation,
    }


@pytest.mark.asyncio
async def test_a_list_is_written_under_its_generation():
    store = RAMJobStore()
    assert await store.load("s") is None
    assert await store.cas_set("s", _list("a"), 0)
    assert not await store.cas_set("s", _list("a", "b"), 0)
    assert await store.cas_set("s", _list("a", "b", generation=2), 1)
    stored = await store.load("s")
    assert stored is not None
    assert list(stored["jobs"]) == ["1", "2"]
    assert not await store.delete("s", 1)
    assert await store.load("s") is not None
    assert await store.delete("s", 2)
    assert await store.load("s") is None


@pytest.mark.asyncio
async def test_a_loaded_list_is_a_copy():
    store = RAMJobStore()
    await store.cas_set("s", _list("a"), 0)
    loaded = await store.load("s")
    assert loaded is not None
    loaded["jobs"].clear()
    stored = await store.load("s")
    assert stored is not None
    assert list(stored["jobs"]) == ["1"]


@pytest.mark.asyncio
async def test_a_console_is_dropped_once_no_list_names_it():
    store = RAMJobStore()
    await store.cas_set("s", _list("a"), 0)
    held = store.console("a")
    await held.append(Channel.STDOUT, b"kept")
    assert store.console("a") is held
    await store.cas_set("s", _list(generation=2), 1)
    assert store.console("a") is not held
    chunks, _, _ = await held.read_from(0)
    assert [c.data for c in chunks] == [b"kept"]


@pytest.mark.asyncio
async def test_owners_never_lapse_without_a_lease():
    store = RAMJobStore()
    assert await store.alive("never-renewed")


@pytest.mark.asyncio
async def test_an_owner_lives_while_its_lease_holds():
    store = RAMJobStore(lease_seconds=0.05)
    assert not await store.alive("o")
    await store.renew("o")
    assert await store.alive("o")
    await asyncio.sleep(0.1)
    assert not await store.alive("o")


@pytest.mark.asyncio
async def test_an_owners_processes_are_published_and_dropped():
    store = RAMJobStore()
    record = {"pid": 2, "command": "sleep 30", "runs": []}
    await store.publish("a", {"2": record})
    await store.publish("b", {"5": {"pid": 5, "runs": []}})
    found = await store.processes()
    assert found == {"a": {"2": record}, "b": {"5": {"pid": 5, "runs": []}}}
    found["a"]["2"]["pid"] = 9
    assert (await store.processes())["a"]["2"]["pid"] == 2
    await store.publish("a", {})
    assert list(await store.processes()) == ["b"]


@pytest.mark.asyncio
async def test_stops_asked_of_an_owner_are_taken_once():
    store = RAMJobStore()
    await store.request_stop("a", 2, 15)
    await store.request_stop("a", 3, 9)
    await store.request_stop("b", 4, 9)
    assert await store.take_stops("a") == [(2, 15), (3, 9)]
    assert await store.take_stops("a") == []
    assert await store.take_stops("b") == [(4, 9)]


def test_lists_written_from_many_threads_lose_no_write():
    store = RAMJobStore()

    async def bump(times: int) -> None:
        for _ in range(times):
            while True:
                fields = await store.load("s")
                count = fields["count"] if fields else 0
                generation = generation_of(fields)
                written = {"count": count + 1, "generation": generation + 1}
                if await store.cas_set("s", written, generation):
                    break

    threads = [
        threading.Thread(target=asyncio.run, args=(bump(200),))
        for _ in range(4)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    stored = asyncio.run(store.load("s"))
    assert stored is not None
    assert stored["count"] == 800

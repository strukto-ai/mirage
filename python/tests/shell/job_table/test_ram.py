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

from mirage.shell.console import Channel
from mirage.shell.job_table.ram import RAMJobStore


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

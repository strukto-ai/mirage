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

from mirage.resources.errors import ResourceError
from mirage.resources.memory import MemoryRecords, MemorySealer
from mirage.resources.store import RecordResourceStore
from mirage.resources.types import EntryInput, Fields, TemplateInput

GITHUB = EntryInput("github", "github", {"owner": "x"}, {"token": "t1"})


class SlowRecords(MemoryRecords):
    def __init__(self) -> None:
        super().__init__()
        self.started = asyncio.Event()

    async def write(self, folder: str, name: str, record: Fields) -> None:
        self.started.set()
        await asyncio.sleep(0.05)
        await super().write(folder, name, record)


class SlowSealer(MemorySealer):
    def __init__(self) -> None:
        super().__init__()
        self.started = asyncio.Event()

    async def wipe(self, kind: str, name: str) -> None:
        self.started.set()
        await asyncio.sleep(0.05)
        await super().wipe(kind, name)


class FailingRecords(MemoryRecords):
    def __init__(self) -> None:
        super().__init__()
        self.fail = False

    async def write(self, folder: str, name: str, record: Fields) -> None:
        if self.fail:
            raise OSError("disk full")
        await super().write(folder, name, record)


@pytest.mark.asyncio
async def test_a_put_keeps_drops_and_replaces_sealed_fields():
    store = RecordResourceStore("t", MemoryRecords(), MemorySealer())
    await store.put_entry("vfs", GITHUB)
    kept = await store.put_entry("vfs", EntryInput("github", "github", {}))
    assert kept.sealed == ["token"]
    pointer = {"token": {"from": "aws", "ref": "r", "key": "k"}}
    moved = await store.put_entry(
        "vfs", EntryInput("github", "github", pointer)
    )
    assert moved.sealed == []
    await store.put_entry(
        "vfs", EntryInput("github", "github", {}, {"token": "t2", "k": "v"})
    )
    dropped = await store.put_entry(
        "vfs", EntryInput("github", "github", {}, {"k": None})
    )
    assert dropped.sealed == ["token"]
    assert (await store.reveal_entry("vfs", "github")).sealed == {
        "token": "t2"
    }


@pytest.mark.asyncio
async def test_a_deleted_entry_comes_back_without_its_secret():
    store = RecordResourceStore("t", MemoryRecords(), MemorySealer())
    await store.put_entry("vfs", GITHUB)
    await store.delete_entry("vfs", "github")
    with pytest.raises(ResourceError) as gone:
        await store.reveal_entry("vfs", "github")
    assert gone.value.code == "not_found"
    again = await store.put_entry("vfs", EntryInput("github", "github", {}))
    assert again.sealed == []


@pytest.mark.asyncio
async def test_a_failed_record_write_keeps_the_old_secret():
    records = FailingRecords()
    store = RecordResourceStore("t", records, MemorySealer())
    await store.put_entry("vfs", GITHUB)
    records.fail = True
    with pytest.raises(OSError):
        await store.put_entry(
            "vfs", EntryInput("github", "github", {"token": {"from": "aws"}})
        )
    assert (await store.reveal_entry("vfs", "github")).sealed == {
        "token": "t1"
    }


@pytest.mark.asyncio
async def test_an_entry_name_is_one_across_kinds():
    store = RecordResourceStore("t", MemoryRecords(), MemorySealer())
    await store.put_entry("vfs", GITHUB)
    with pytest.raises(ResourceError) as taken:
        await store.put_entry("cli", EntryInput("github", "gh", {}))
    assert taken.value.code == "conflict"


@pytest.mark.parametrize("name", ["../x", "Upper", "", "a" * 64])
@pytest.mark.asyncio
async def test_every_call_refuses_a_name_outside_the_rule(name):
    store = RecordResourceStore("t", MemoryRecords(), MemorySealer())
    for call in (
        store.get_entry("vfs", name),
        store.delete_entry("vfs", name),
        store.delete_policy(name),
        store.restore_template(name),
    ):
        with pytest.raises(ResourceError) as refused:
            await call
        assert refused.value.code == "invalid"


@pytest.mark.asyncio
async def test_a_cancelled_put_saves_record_and_secret_together():
    records = SlowRecords()
    store = RecordResourceStore("t", records, MemorySealer())
    put = asyncio.ensure_future(store.put_entry("vfs", GITHUB))
    await records.started.wait()
    put.cancel()
    with pytest.raises(asyncio.CancelledError):
        await put
    saved = await store.reveal_entry("vfs", "github")
    assert (saved.fields, saved.sealed) == ({"owner": "x"}, {"token": "t1"})


@pytest.mark.asyncio
async def test_a_cancelled_delete_removes_record_and_secret_together():
    sealer = SlowSealer()
    store = RecordResourceStore("t", MemoryRecords(), sealer)
    await store.put_entry("vfs", GITHUB)
    delete = asyncio.ensure_future(store.delete_entry("vfs", "github"))
    await sealer.started.wait()
    delete.cancel()
    with pytest.raises(asyncio.CancelledError):
        await delete
    assert await store.list_entries("vfs") == []


@pytest.mark.asyncio
async def test_two_creates_of_one_template_save_one():
    store = RecordResourceStore("t", MemoryRecords(), MemorySealer())
    results = await asyncio.gather(
        store.create_template(TemplateInput(name="t", config={"a": 1})),
        store.create_template(TemplateInput(name="t", config={"a": 2})),
        return_exceptions=True,
    )
    refused = [r for r in results if isinstance(r, ResourceError)]
    assert [r.code for r in refused] == ["conflict"]
    assert (await store.get_template("t")).config == {"a": 1}

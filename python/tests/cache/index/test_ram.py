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

from datetime import datetime, timedelta, timezone

import pytest

from mirage.cache.index import RAMIndexCacheStore
from mirage.cache.index.config import Evicted, LookupStatus
from mirage.cache.index.ram import ListingCheckStore
from mirage.types import FileStat, FileType
from mirage.utils.clock import ManualClock


@pytest.fixture
def store():
    return RAMIndexCacheStore(ttl=60)


@pytest.mark.asyncio
async def test_entries_stored_in_dict(store):
    entry = FileStat(name="f", type=FileType.FILE, fingerprint="1")
    await store.put("/f.txt", entry)
    assert "/f.txt" in store._entries


@pytest.mark.asyncio
async def test_children_stored_in_dict(store):
    entry = FileStat(name="f", type=FileType.FILE, fingerprint="1")
    await store.set_dir("/dir", [("f.txt", entry)])
    assert "/dir" in store._children
    assert store._children["/dir"] == ["/dir/f.txt"]


@pytest.mark.asyncio
async def test_expiry_stored_in_dict(store):
    entry = FileStat(name="f", type=FileType.FILE, fingerprint="1")
    await store.set_dir("/dir", [("f.txt", entry)])
    assert "/dir" in store._expiry
    assert isinstance(store._expiry["/dir"], datetime)


@pytest.mark.asyncio
async def test_invalidate_dir_evicts_child_entries(store):
    entry = FileStat(name="f", type=FileType.FILE, fingerprint="1")
    await store.set_dir("/dir", [("f.txt", entry)])
    assert (await store.get("/dir/f.txt")).entry is not None
    await store.invalidate_dir("/dir")
    assert (await store.get("/dir/f.txt")).entry is None
    assert "/dir" not in store._children
    assert "/dir" not in store._expiry


# The distinction the whole github invalidation rests on: `clear` leaves a
# store that reads exactly like one that was never filled, so a backend
# whose index *is* its listing reports an empty repository. `invalidate`
# keeps the rows and only expires them, so the lookup says EXPIRED and the
# backend knows to refetch.
@pytest.mark.asyncio
async def test_invalidate_expires_without_discarding(store):
    entry = FileStat(name="f", type=FileType.FILE, fingerprint="1")
    await store.set_dir("/dir", [("f.txt", entry)])
    await store.invalidate()
    assert (await store.list_dir("/dir")).status == LookupStatus.EXPIRED
    assert store._children["/dir"] == ["/dir/f.txt"]
    await store.clear()
    assert (await store.list_dir("/dir")).status == LookupStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_invalidate_expires_every_directory(store):
    entry = FileStat(name="f", type=FileType.FILE, fingerprint="1")
    await store.set_dir("/a", [("f.txt", entry)])
    await store.set_dir("/b", [("g.txt", entry)])
    await store.invalidate()
    assert (await store.list_dir("/a")).status == LookupStatus.EXPIRED
    assert (await store.list_dir("/b")).status == LookupStatus.EXPIRED


# An empty store has nothing to expire, and must not grow a row that makes
# a never-listed directory answer EXPIRED instead of NOT_FOUND.
@pytest.mark.asyncio
async def test_invalidate_leaves_an_unlisted_directory_absent(store):
    await store.invalidate()
    assert (await store.list_dir("/dir")).status == LookupStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_clear_empties_all_dicts(store):
    entry = FileStat(name="f", type=FileType.FILE, fingerprint="1")
    await store.put("/f.txt", entry)
    await store.set_dir("/dir", [("f.txt", entry)])
    await store.clear()
    assert len(store._entries) == 0
    assert len(store._children) == 0
    assert len(store._expiry) == 0


@pytest.mark.asyncio
async def test_locks_cleaned_after_clear(store):
    entry = FileStat(name="f", type=FileType.FILE, fingerprint="1")
    await store.put("/a", entry)
    await store.put("/b", entry)
    await store.clear()
    assert len(store._key_locks) == 0


@pytest.mark.asyncio
async def test_invalidate_prefix_drops_nested_listings(store):
    entry = FileStat(name="f", type=FileType.FILE, fingerprint="1")
    await store.set_dir("/chan/2026-08-15", [("chat.jsonl", entry)])
    await store.set_dir("/chan/2026-08-15/files", [("a.png", entry)])
    await store.invalidate_prefix("/chan/2026-08-15")
    assert "/chan/2026-08-15" not in store._children
    assert "/chan/2026-08-15/files" not in store._children
    assert "/chan/2026-08-15/files/a.png" not in store._entries


@pytest.mark.asyncio
async def test_invalidate_dir_leaves_nested_listing(store):
    entry = FileStat(name="f", type=FileType.FILE, fingerprint="1")
    await store.set_dir("/chan/2026-08-15", [("chat.jsonl", entry)])
    await store.set_dir("/chan/2026-08-15/files", [("a.png", entry)])
    await store.invalidate_dir("/chan/2026-08-15")
    assert "/chan/2026-08-15/files" in store._children


@pytest.mark.asyncio
async def test_invalidate_prefix_respects_path_boundary(store):
    entry = FileStat(name="f", type=FileType.FILE, fingerprint="1")
    await store.set_dir("/chan/day", [("a", entry)])
    await store.set_dir("/chan/daytime", [("b", entry)])
    await store.invalidate_prefix("/chan/day")
    assert "/chan/day" not in store._children
    assert "/chan/daytime" in store._children
    assert "/chan/daytime/b" in store._entries


def _row(name: str = "c.txt") -> FileStat:
    return FileStat(name=name, type=FileType.FILE, fingerprint="F1")


@pytest.mark.asyncio
async def test_a_scratch_store_hints_the_row_its_source_holds():
    src = RAMIndexCacheStore()
    await src.set_dir("/m/a", [("c.txt", _row())])
    scratch = ListingCheckStore(hints=src)
    assert (
        await scratch.hint("/m/a/c.txt") == (await src.get("/m/a/c.txt")).entry
    )
    assert await scratch.hint("/m/a/missing.txt") is None


@pytest.mark.asyncio
async def test_a_hint_is_never_an_answer():
    # Seeding the scratch store with the mount's rows would hand every
    # backend cached metadata as truth -- the #1040 bug.
    src = RAMIndexCacheStore()
    await src.set_dir("/m/a", [("c.txt", _row())])
    scratch = ListingCheckStore(hints=src)
    assert (await scratch.get("/m/a/c.txt")).entry is None
    assert (await scratch.list_dir("/m/a")).entries is None
    assert await scratch.hint("/m/a/c.txt") is not None


def test_hints_outside_a_freshness_check_are_refused():
    with pytest.raises(TypeError, match="hints"):
        RAMIndexCacheStore(hints=RAMIndexCacheStore())


@pytest.mark.asyncio
async def test_an_expired_row_still_hints():
    # The id is confirmed by the backend before anything trusts it, so an
    # expired listing is still a usable address.
    src = RAMIndexCacheStore(ttl=60)
    await src.set_dir("/m/a", [("c.txt", _row())])
    src._expiry["/m/a"] = datetime(2000, 1, 1, tzinfo=timezone.utc)
    scratch = ListingCheckStore(hints=src)
    assert await scratch.hint("/m/a/c.txt") is not None


@pytest.mark.asyncio
async def test_narrow_invalidation_preserves_exact_deadline():
    store = RAMIndexCacheStore()
    deadline = datetime.now(timezone.utc) + timedelta(seconds=3600)
    await store.set_dir(
        "/repo", [("a", FileStat(name="a", type=FileType.FILE))], deadline
    )
    await store.invalidate_entry("/repo/a")
    assert store._expiry["/repo"] == deadline


@pytest.mark.asyncio
async def test_a_check_store_ages_on_its_hints_clock():
    clock = ManualClock(start=1000.0)
    scratch = ListingCheckStore(hints=RAMIndexCacheStore(clock=clock))
    await scratch.set_dir("/d", [])
    clock.advance(scratch.ttl)
    assert (await scratch.list_dir("/d")).status == LookupStatus.EXPIRED


# Once an invalidation has buried a folder's children, the next one buries
# only what changed since, and a re-list still finds every child gone that
# burying them all would have remembered, in the folder's order.
@pytest.mark.asyncio
async def test_an_invalidation_after_a_bury_remembers_what_changed(store):
    def stat(name: str, kind: FileType = FileType.FILE) -> FileStat:
        return FileStat(name=name, type=kind)

    await store.set_dir("/d", [("a", stat("a")), ("b", stat("b"))])
    await store.invalidate_entry("/d/a")
    await store.add_entry("/d/z", stat("z"))
    await store.add_entry("/d/m", stat("m"))
    await store.put("/d/b", stat("b", FileType.DIRECTORY))
    await store.invalidate_entry("/d/x")
    await store.invalidate_prefix("/d")
    assert await store.set_dir("/d", []) == [
        Evicted("/d/a", folder=False),
        Evicted("/d/b", folder=True),
        Evicted("/d/m", folder=False),
        Evicted("/d/z", folder=False),
    ]


@pytest.mark.asyncio
async def test_writes_into_a_large_folder_bury_only_what_they_change(
    store, monkeypatch
):
    rows = [
        (f"f{i}", FileStat(name=f"f{i}", type=FileType.FILE))
        for i in range(200)
    ]
    await store.set_dir("/d", rows)
    await store.invalidate_entry("/d/f0")
    sizes = []
    bury = store._bury

    def counted(folder, paths):
        sizes.append(len(paths))
        bury(folder, paths)

    monkeypatch.setattr(store, "_bury", counted)
    listed = store._children["/d"]
    for i in range(1, 100):
        await store.invalidate_entry(f"/d/f{i}")
    assert max(sizes) <= 1
    assert store._children["/d"] is listed
    assert (await store.list_dir("/d")).partial_entries == [
        f"/d/f{i}" for i in range(100, 200)
    ]


@pytest.mark.asyncio
async def test_a_folder_refreshed_again_is_queued_once(store):
    sub = FileStat(name="sub", type=FileType.DIRECTORY)
    await store.set_dir(
        "/d", [("a", FileStat(name="a", type=FileType.FILE)), ("sub", sub)]
    )
    await store.invalidate_entry("/d/a")
    for _ in range(50):
        await store.put("/d/sub", sub)
    assert store._fresh["/d"] == {"/d/sub": None}

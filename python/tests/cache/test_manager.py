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

from mirage.cache.file.io import mutation_lock
from mirage.cache.file.ram import RAMFileCacheStore
from mirage.cache.index import NULL_INDEX
from mirage.cache.index.config import IndexEntry
from mirage.cache.index.constants import LISTING_TRUST_WINDOW
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.cache.index.scope import command_scope
from mirage.cache.index.view import IndexView
from mirage.cache.manager import CacheManager
from mirage.cache.types import WriteReceipt
from mirage.types import FileStat, FileType, PathSpec, ReadPolicy
from mirage.utils.key_prefix import mount_key


def _owns_all(_key: str) -> bool:
    return True


def _run(coro):
    return asyncio.run(coro)


def _stores() -> tuple[RAMFileCacheStore, RAMIndexCacheStore]:
    return RAMFileCacheStore(), RAMIndexCacheStore(ttl=600)


async def _seed(cache: RAMFileCacheStore, index: RAMIndexCacheStore) -> None:
    await cache.set("/data/arch/h.txt", b"two\n")
    await index.set_dir(
        "/data/arch",
        [
            ("h.txt", IndexEntry(id="h", name="h.txt", resource_type="file")),
        ],
    )


async def _write_case() -> tuple[bool, bool]:
    cache, index = _stores()
    await _seed(cache, index)
    manager = CacheManager(cache, index, "/data/", True)
    await manager.invalidate_after_write(PathSpec.from_str_path("/arch/h.txt"))
    cached = await cache.exists("/data/arch/h.txt")
    listing = await index.list_dir("/data/arch")
    return cached, listing.entries is not None


def test_write_evicts_file_and_parent_listing():
    cached, listed = _run(_write_case())
    assert cached is False
    assert listed is False


async def _unlink_case() -> tuple[bool, bool, IndexEntry | None]:
    cache, index = _stores()
    await _seed(cache, index)
    manager = CacheManager(cache, index, "/data/", True)
    await manager.invalidate_after_unlink(
        PathSpec.from_str_path("/arch/h.txt")
    )
    cached = await cache.exists("/data/arch/h.txt")
    listing = await index.list_dir("/data/arch")
    entry = await index.get("/data/arch/h.txt")
    return cached, listing.entries is not None, entry.entry


def test_unlink_evicts_file_listing_and_entry():
    cached, listed, entry = _run(_unlink_case())
    assert cached is False
    assert listed is False
    assert entry is None


async def _local_case() -> tuple[bool, bool]:
    cache, index = _stores()
    await _seed(cache, index)
    manager = CacheManager(cache, index, "/data/", False)
    await manager.invalidate_after_write(PathSpec.from_str_path("/arch/h.txt"))
    cached = await cache.exists("/data/arch/h.txt")
    listing = await index.list_dir("/data/arch")
    return cached, listing.entries is not None


def test_local_mount_keeps_file_cache_but_invalidates_index():
    cached, listed = _run(_local_case())
    assert cached is True
    assert listed is False


async def _pathspec_case() -> bool:
    cache, index = _stores()
    await _seed(cache, index)
    manager = CacheManager(cache, index, "/data/", True)
    spec = PathSpec(
        vfs_path=mount_key("/data/arch/h.txt", "/data/"),
        virtual="/data/arch/h.txt",
        directory="/data/arch",
    )
    await manager.invalidate_after_write(spec)
    return await cache.exists("/data/arch/h.txt")


def test_pathspec_input_maps_to_virtual_key():
    assert _run(_pathspec_case()) is False


async def _cached_hit_case() -> bytes | None:
    cache, index = _stores()
    await cache.set("/data/x.txt", b"cached")
    manager = CacheManager(cache, index, "/data/", True)
    spec = PathSpec(
        vfs_path=mount_key("/data/x.txt", "/data/"),
        virtual="/data/x.txt",
        directory="/data/",
    )
    return await manager.cached_bytes(spec)


def test_cached_bytes_returns_cached_value():
    assert _run(_cached_hit_case()) == b"cached"


async def _cached_miss_case() -> bytes | None:
    cache, index = _stores()
    manager = CacheManager(cache, index, "/data/", True)
    spec = PathSpec(
        vfs_path=mount_key("/data/x.txt", "/data/"),
        virtual="/data/x.txt",
        directory="/data/",
    )
    return await manager.cached_bytes(spec)


def test_cached_bytes_miss_returns_none():
    assert _run(_cached_miss_case()) is None


async def _cached_local_case() -> bytes | None:
    cache, index = _stores()
    await cache.set("/data/x.txt", b"cached")
    manager = CacheManager(cache, index, "/data/", False)
    spec = PathSpec(
        vfs_path=mount_key("/data/x.txt", "/data/"),
        virtual="/data/x.txt",
        directory="/data/",
    )
    return await manager.cached_bytes(spec)


def test_cached_bytes_local_mount_returns_none():
    assert _run(_cached_local_case()) is None


def _spec(path: str = "/data/x.txt") -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(path, "/data/"), virtual=path, directory="/data/"
    )


async def _gate_refuses_case() -> tuple[bytes | None, list[str]]:
    cache, index = _stores()
    await cache.set("/data/x.txt", b"cached")
    asked: list[str] = []

    async def gate(key: str) -> bool:
        asked.append(key)
        return False

    manager = CacheManager(cache, index, "/data/", True, _owns_all, gate)
    return await manager.cached_bytes(_spec()), asked


def test_gate_refusal_withholds_the_cached_bytes():
    served, asked = _run(_gate_refuses_case())
    assert served is None
    assert asked == ["/data/x.txt"]


async def _gate_skipped_on_miss_case() -> list[str]:
    cache, index = _stores()
    asked: list[str] = []

    async def gate(key: str) -> bool:
        asked.append(key)
        return True

    manager = CacheManager(cache, index, "/data/", True, _owns_all, gate)
    await manager.cached_bytes(_spec())
    return asked


def test_gate_is_not_asked_for_a_path_the_cache_does_not_hold():
    assert _run(_gate_skipped_on_miss_case()) == [], (
        "a cold read must cost no revalidation"
    )


async def _gate_skipped_on_local_case() -> list[str]:
    cache, index = _stores()
    await cache.set("/data/x.txt", b"cached")
    asked: list[str] = []

    async def gate(key: str) -> bool:
        asked.append(key)
        return True

    manager = CacheManager(cache, index, "/data/", False, _owns_all, gate)
    await manager.cached_bytes(_spec())
    return asked


def test_gate_is_not_asked_for_a_non_caching_mount():
    assert _run(_gate_skipped_on_local_case()) == []


async def _gate_skipped_when_unowned_case() -> list[str]:
    cache, index = _stores()
    await cache.set("/data/x.txt", b"cached")
    asked: list[str] = []

    async def gate(key: str) -> bool:
        asked.append(key)
        return True

    manager = CacheManager(cache, index, "/data/", True, lambda _: False, gate)
    await manager.cached_bytes(_spec())
    return asked


def test_gate_is_not_asked_for_a_key_the_mount_no_longer_owns():
    assert _run(_gate_skipped_when_unowned_case()) == [], (
        "ownership is checked first, so a retiring mount is never probed"
    )


async def _gate_raises_case() -> bytes | None:
    cache, index = _stores()
    await cache.set("/data/x.txt", b"cached")

    async def gate(_key: str) -> bool:
        raise FileNotFoundError("/data/x.txt")

    manager = CacheManager(cache, index, "/data/", True, _owns_all, gate)
    return await manager.cached_bytes(_spec())


def test_gate_reporting_the_object_gone_propagates():
    with pytest.raises(FileNotFoundError):
        _run(_gate_raises_case())


async def _cached_size_case(data: bytes) -> tuple[int | None, list[str]]:
    cache, index = _stores()
    await cache.set("/data/x.txt", data)
    asked: list[str] = []

    async def gate(key: str) -> bool:
        asked.append(key)
        return False

    manager = CacheManager(cache, index, "/data/", True, _owns_all, gate)
    return await manager.cached_size(_spec()), asked


def test_cached_size_reports_the_length_without_revalidating():
    size, asked = _run(_cached_size_case(b"cached"))
    assert size == 6
    assert asked == [], (
        "the stat size backfill runs on the backends that report no size, "
        "so gating it would turn a stat into a backend stat"
    )


def test_cached_size_of_an_empty_render_is_zero_not_none():
    size, _ = _run(_cached_size_case(b""))
    assert size == 0, (
        "an empty cached render has a known size; None would read as "
        "unknown and reach ls -l and stat as a missing size"
    )


async def _cached_size_miss_case() -> int | None:
    cache, index = _stores()
    manager = CacheManager(cache, index, "/data/", True)
    return await manager.cached_size(_spec())


def test_cached_size_miss_returns_none():
    assert _run(_cached_size_miss_case()) is None


async def _no_index_case() -> bool:
    cache, _ = _stores()
    await cache.set("/data/a.txt", b"x")
    manager = CacheManager(cache, NULL_INDEX, "/data/", True)
    await manager.invalidate_after_write(PathSpec.from_str_path("/a.txt"))
    return await cache.exists("/data/a.txt")


def test_null_index_is_tolerated():
    assert _run(_no_index_case()) is False


async def _drop_prefix_case() -> tuple[bool, bool, bool]:
    cache, index = _stores()
    await _seed(cache, index)
    await cache.set("/other/keep.txt", b"safe\n")
    manager = CacheManager(cache, index, "/data/", True)
    await manager.drop_prefix()
    return (
        await cache.exists("/data/arch/h.txt"),
        await cache.exists("/other/keep.txt"),
        manager._caches_reads,
    )


def test_drop_prefix_evicts_this_mount_only():
    """A path-unknown mutation drops the mount's bodies without reaching
    into a neighbouring mount's keyspace."""
    dropped, kept, _ = _run(_drop_prefix_case())
    assert dropped is False
    assert kept is True


async def _drop_prefix_local_case() -> bool:
    cache, index = _stores()
    await _seed(cache, index)
    manager = CacheManager(cache, index, "/data/", False)
    await manager.drop_prefix()
    return await cache.exists("/data/arch/h.txt")


def test_drop_prefix_leaves_a_non_caching_mount_alone():
    """A mount that does not cache reads owns no entries here, so the
    keys under its prefix belong to whoever put them there."""
    assert _run(_drop_prefix_local_case()) is True


async def _drop_prefix_root_case() -> tuple[str, bool, bool]:
    cache, index = _stores()
    await cache.set("/a.txt", b"x")
    await cache.set("/sub/b.txt", b"y")
    manager = CacheManager(cache, index, "/", True)
    await manager.drop_prefix()
    return (
        manager._prefix,
        await cache.exists("/a.txt"),
        await cache.exists("/sub/b.txt"),
    )


def test_drop_prefix_reaches_every_key_on_a_root_mount():
    """A root mount strips to the empty prefix, so the eviction argument
    is "/" and matches every key rather than nothing."""
    prefix, a, b = _run(_drop_prefix_root_case())
    assert prefix == ""
    assert a is False
    assert b is False


async def _ancestors_case() -> tuple[bool, bool, bool]:
    cache, index = _stores()
    for directory in ("/data", "/data/a", "/data/a/b"):
        await index.set_dir(directory, [])
    manager = CacheManager(cache, index, "/data/", True)
    await manager.invalidate_ancestors(PathSpec.from_str_path("/a/b/c.txt"))
    return (
        (await index.list_dir("/data")).entries is not None,
        (await index.list_dir("/data/a")).entries is not None,
        (await index.list_dir("/data/a/b")).entries is not None,
    )


def test_invalidate_ancestors_walks_up_to_the_mount_root():
    """One put materializes every missing level of the key, so every
    listing above the written file gained an entry."""
    root, a, ab = _run(_ancestors_case())
    assert root is False
    assert a is False
    # The immediate parent is invalidate_after_write's job, not this one.
    assert ab is True


async def _ancestors_root_mount_case() -> tuple[bool, bool]:
    cache, index = _stores()
    for directory in ("/", "/a"):
        await index.set_dir(directory, [])
    manager = CacheManager(cache, index, "/", True)
    await manager.invalidate_ancestors(PathSpec.from_str_path("/a/b/c.txt"))
    return (
        (await index.list_dir("/")).entries is not None,
        (await index.list_dir("/a")).entries is not None,
    )


def test_invalidate_ancestors_reaches_the_root_listing():
    root, a = _run(_ancestors_root_mount_case())
    assert root is False
    assert a is False


async def _subtree_case() -> tuple[bool, bool, bool, bool]:
    cache, index = _stores()
    await cache.set("/data/chan/day/chat.jsonl", b"one\n")
    await cache.set("/data/chan/day/files/a.png", b"png")
    entry = IndexEntry(id="1", name="f", resource_type="file")
    await index.set_dir("/data/chan/day", [("chat.jsonl", entry)])
    await index.set_dir("/data/chan/day/files", [("a.png", entry)])
    await index.set_dir("/data/chan", [("day", entry)])
    manager = CacheManager(cache, index, "/data/", True)
    await manager.invalidate_subtree(PathSpec.from_str_path("/chan/day"))
    return (
        await cache.exists("/data/chan/day/files/a.png"),
        (await index.list_dir("/data/chan/day")).entries is not None,
        (await index.list_dir("/data/chan/day/files")).entries is not None,
        (await index.list_dir("/data/chan")).entries is not None,
    )


def test_invalidate_subtree_drops_nested_bodies_and_listings():
    body, own, nested, parent = _run(_subtree_case())
    assert body is False
    assert own is False
    assert nested is False
    assert parent is False


async def _write_leaves_subtree_case() -> bool:
    cache, index = _stores()
    entry = IndexEntry(id="1", name="f", resource_type="file")
    await index.set_dir("/data/chan/day/files", [("a.png", entry)])
    manager = CacheManager(cache, index, "/data/", True)
    await manager.invalidate_after_write(PathSpec.from_str_path("/chan/day"))
    return (await index.list_dir("/data/chan/day/files")).entries is not None


def test_write_does_not_reach_into_the_subtree():
    assert _run(_write_leaves_subtree_case()) is True


async def _prefix_lookalike_case() -> bool:
    cache, index = _stores()
    entry = IndexEntry(id="1", name="f", resource_type="file")
    await index.set_dir("/d/day", [("chat.jsonl", entry)])
    manager = CacheManager(cache, index, "/d/", True)
    await manager.invalidate_after_unlink(PathSpec.from_str_path("/day"))
    return (await index.list_dir("/d/day")).entries is not None


def test_a_relative_path_that_looks_prefixed_is_still_prefixed():
    # "/day" starts with the "/d" prefix as characters while naming
    # something else; reading it as absolute evicted "/day" and left
    # "/d/day" cached, which is an eviction that hits no key.
    assert _run(_prefix_lookalike_case()) is False


def _entry(name: str = "a") -> IndexEntry:
    return IndexEntry(id=name, name=name, resource_type="file")


async def _waits_for_the_lock(cache: RAMFileCacheStore, view) -> bool:
    lock = mutation_lock(cache)
    await lock.acquire()
    call = asyncio.ensure_future(view.list_dir("/data"))
    try:
        await asyncio.sleep(0.02)
        waited = not call.done()
        lock.release()
        await asyncio.wait_for(call, 1)
        return waited
    finally:
        if lock.locked():
            lock.release()
        await asyncio.gather(call, return_exceptions=True)


@pytest.mark.asyncio
async def test_scope_index_is_one_view_per_store():
    cache, index = _stores()
    manager = CacheManager(cache, index, "/data/", True)
    assert manager.scope_index(index) is manager.scope_index(index)


@pytest.mark.asyncio
async def test_scope_index_follows_a_replaced_store():
    cache, index = _stores()
    replaced = RAMIndexCacheStore(ttl=600)
    manager = CacheManager(cache, index, "/data/", True)
    first = manager.scope_index(index)
    second = manager.scope_index(replaced)
    await second.set_dir("/data", [("a", _entry())])
    assert second is not first
    assert (await replaced.list_dir("/data")).entries == ["/data/a"]
    assert (await index.list_dir("/data")).entries is None


@pytest.mark.asyncio
async def test_scope_index_hands_back_a_view_even_while_it_holds_another():
    cache, index = _stores()
    manager = CacheManager(cache, index, "/data/", True)
    manager.scope_index(index)
    view = IndexView(RAMIndexCacheStore(), cache, "/data", _owns_all)
    assert manager.scope_index(view) is view


@pytest.mark.asyncio
async def test_scope_index_without_a_file_cache_is_the_raw_store():
    _, index = _stores()
    manager = CacheManager(None, index, "/data/", True)
    assert manager.scope_index(index) is index
    assert manager.scope_index(index) is index


@pytest.mark.asyncio
async def test_scope_index_locked_refuses_a_view():
    cache, index = _stores()
    manager = CacheManager(cache, index, "/data/", True)
    view = IndexView(index, cache, "/data", _owns_all)
    with pytest.raises(ValueError):
        manager.scope_index_locked(view)


@pytest.mark.asyncio
async def test_scope_index_locked_without_a_file_cache_is_the_raw_store():
    _, index = _stores()
    manager = CacheManager(None, index, "/data/", True)
    assert manager.scope_index_locked(index) is index


@pytest.mark.asyncio
async def test_scope_index_locked_is_never_memoized_nor_shared():
    cache, index = _stores()
    manager = CacheManager(cache, index, "/data/", True)
    locked = manager.scope_index_locked(index)
    assert isinstance(locked, IndexView)
    assert locked is not manager.scope_index_locked(index)
    assert locked is not manager.scope_index(index)
    assert await _waits_for_the_lock(cache, manager.scope_index(index))


@pytest.mark.asyncio
async def test_a_write_through_the_locked_view_counts_for_the_shared_one():
    # A glob writes through its own locked view; the command's later ls
    # through the shared view must trust that same write.
    cache, index = _stores()
    manager = CacheManager(cache, index, "/data/", True)
    async with command_scope():
        await manager.scope_index_locked(index).set_dir("/data", [])
        assert manager.listing_trusted("/data") is True
        assert manager.listing_trusted("/data/other") is False


@pytest.mark.asyncio
async def test_a_write_before_the_command_does_not_count():
    cache, index = _stores()
    manager = CacheManager(cache, index, "/data/", True)
    await manager.scope_index(index).set_dir("/data", [])
    async with command_scope():
        assert manager.listing_trusted("/data") is False


@pytest.mark.asyncio
async def test_a_replaced_store_forgets_what_the_old_one_was_written():
    cache, index = _stores()
    manager = CacheManager(cache, index, "/data/", True)
    async with command_scope():
        await manager.scope_index(index).set_dir("/data", [])
        manager.scope_index(RAMIndexCacheStore(ttl=600))
        assert manager.listing_trusted("/data") is False


class _Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock(monkeypatch) -> _Clock:
    fake = _Clock()
    monkeypatch.setattr("mirage.cache.manager._now", fake)
    return fake


@pytest.mark.asyncio
async def test_outside_a_command_a_listing_is_trusted_for_the_window(clock):
    cache, index = _stores()
    manager = CacheManager(cache, index, "/data/", True)
    await manager.scope_index(index).set_dir("/data", [])
    clock.now += LISTING_TRUST_WINDOW - 0.01
    assert manager.listing_trusted("/data") is True
    assert manager.listing_trusted("/data/other") is False
    clock.now += 0.02
    assert manager.listing_trusted("/data") is False


@pytest.mark.asyncio
async def test_inside_a_command_the_window_does_not_apply(clock):
    # A listing the previous command wrote a moment ago is still re-listed by
    # the next one: the window is only for reads that belong to no command.
    cache, index = _stores()
    manager = CacheManager(cache, index, "/data/", True)
    await manager.scope_index(index).set_dir("/data", [])
    clock.now += 0.01
    async with command_scope():
        assert manager.listing_trusted("/data") is False
        await manager.scope_index(index).set_dir("/data", [])
        clock.now += LISTING_TRUST_WINDOW * 10
        assert manager.listing_trusted("/data") is True


@pytest.mark.asyncio
async def test_version_checks_out_of_their_window_are_dropped_past_the_bound(
    clock, monkeypatch
):
    # A check serves only a caller inside its window, so once the map is
    # full the stale entries are dead weight; dropping one costs at most
    # another check, never a stale listing.
    monkeypatch.setattr("mirage.cache.manager.CHECKED_LIMIT", 4, raising=False)
    cache, index = _stores()
    manager = CacheManager(cache, index, "/data/", True)

    async def check() -> str:
        return "V"

    for n in range(4):
        assert (
            await manager.checked_version(f"/data/old{n}", "V", check) == "V"
        )
    clock.now += LISTING_TRUST_WINDOW + 0.01
    assert await manager.checked_version("/data/new", "V", check) == "V"
    assert list(manager._checked) == ["/data/new"]


@pytest.mark.asyncio
async def test_a_late_older_check_never_replaces_a_newer_memo(clock):
    # Check A is sent and stalls; once it is out of the window a caller
    # sends check B, which answers V2 first. A then lands with V1, the
    # head it saw before the move. Recording A would put the memo back to
    # V1: a listing stored at V2 would be re-checked, and one stored at V1
    # served as current.
    cache, index = _stores()
    manager = CacheManager(cache, index, "/data/", True)
    release = asyncio.Event()
    asked: list[str] = []

    async def check_a() -> str:
        await release.wait()
        return "V1"

    def answer(version: str):

        async def check() -> str:
            asked.append(version)
            return version

        return check

    first = asyncio.create_task(
        manager.checked_version("/data", "V0", check_a)
    )
    await asyncio.sleep(0)
    clock.now += LISTING_TRUST_WINDOW + 0.01
    assert await manager.checked_version("/data", "V0", answer("V2")) == "V2"
    release.set()
    assert await first == "V1"
    asked.clear()
    assert await manager.checked_version("/data", "V2", answer("V3")) == "V2"
    assert asked == []
    assert await manager.checked_version("/data", "V1", answer("V4")) == "V4"
    assert asked == ["V4"]


def _probed() -> FileStat:
    return FileStat(name="h.txt", size=4, type=FileType.FILE)


@pytest.mark.asyncio
async def test_a_probed_stat_is_served_for_the_rest_of_its_command_only():
    cache, index = _stores()
    manager = CacheManager(cache, index, "/data/", True)
    path = PathSpec.from_str_path("/data/arch/h.txt")
    stat = _probed()
    async with command_scope():
        manager.note_probed(path, stat)
        assert manager.probed_stat(path) is stat
        assert (
            manager.probed_stat(PathSpec.from_str_path("/data/arch/other"))
            is None
        )
    assert manager.probed_stat(path) is None
    async with command_scope():
        assert manager.probed_stat(path) is None


@pytest.mark.asyncio
async def test_a_probe_outside_a_command_is_never_served():
    cache, index = _stores()
    manager = CacheManager(cache, index, "/data/", True)
    path = PathSpec.from_str_path("/data/arch/h.txt")
    manager.note_probed(path, _probed())
    assert manager.probed_stat(path) is None


async def _write(manager: CacheManager, index) -> None:
    await manager.invalidate_after_write(
        PathSpec.from_str_path("/data/elsewhere")
    )


async def _unlink(manager: CacheManager, index) -> None:
    await manager.invalidate_after_unlink(
        PathSpec.from_str_path("/data/elsewhere")
    )


async def _subtree(manager: CacheManager, index) -> None:
    await manager.invalidate_subtree(PathSpec.from_str_path("/data/elsewhere"))


async def _external(manager: CacheManager, index) -> None:
    await manager.clear_index(index)


async def _prefix(manager: CacheManager, index) -> None:
    await manager.drop_prefix()


async def _relisted_gone(manager: CacheManager, index) -> None:
    view = manager.scope_index(index)
    await view.set_dir(
        "/data/arch",
        [
            ("h.txt", IndexEntry(id="h", name="h.txt", resource_type="file")),
        ],
    )
    await view.set_dir("/data/arch", [])


# Every door that drops cached state: a write the command makes, a clear
# after native code ran (an external program, a remote runtime line), a
# path-less CLI mutation, and a re-list that found the file gone. Each one
# means the backend may no longer match what the probe saw.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "drop", [_write, _unlink, _subtree, _external, _prefix, _relisted_gone]
)
async def test_every_cache_drop_in_the_command_retires_its_probed_stats(drop):
    cache, index = _stores()
    manager = CacheManager(cache, index, "/data/", True, on_gone=_ignore_gone)
    path = PathSpec.from_str_path("/data/arch/h.txt")
    async with command_scope():
        manager.note_probed(path, _probed())
        assert manager.probed_stat(path) is not None
        await drop(manager, index)
        assert manager.probed_stat(path) is None


async def _ignore_gone(_gone) -> None:
    return None


@pytest.mark.asyncio
async def test_probed_stats_of_finished_commands_are_dropped_past_the_bound(
    monkeypatch,
):
    # Only the probing command can be served an answer, so once the map is
    # full the other commands' entries are dead weight; dropping one costs at
    # most a backend stat, never a wrong answer.
    monkeypatch.setattr("mirage.cache.manager.PROBED_LIMIT", 4)
    cache, index = _stores()
    manager = CacheManager(cache, index, "/data/", True)
    for n in range(4):
        async with command_scope():
            manager.note_probed(
                PathSpec.from_str_path(f"/data/old{n}"), _probed()
            )
    async with command_scope():
        mine = PathSpec.from_str_path("/data/mine")
        manager.note_probed(mine, _probed())
        assert manager.probed_stat(mine) is not None
        assert len(manager._probed) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("scoped", [False, True])
async def test_an_overlapping_probe_belongs_only_to_its_command(scoped):
    cache, index = _stores()
    manager = CacheManager(cache, index, "/data/", True)
    path = PathSpec.from_str_path("/data/arch/h.txt")
    ready, release = asyncio.Event(), asyncio.Event()

    async def note():
        ready.set()
        await release.wait()
        manager.note_probed(path, _probed())

    async def produce():
        if scoped:
            async with command_scope():
                await note()
        else:
            await note()

    producer = asyncio.create_task(produce())
    await ready.wait()
    async with command_scope():
        release.set()
        await producer
        assert manager.probed_stat(path) is None


@pytest.mark.asyncio
async def test_one_large_command_does_not_rescan_its_probes_on_every_insert(
    monkeypatch,
):
    # Past the bound, a prune that frees nothing (every entry is the running
    # command's) must not run again on the next insert, or a large walk turns
    # quadratic: the next prune waits until the map has doubled.
    monkeypatch.setattr("mirage.cache.manager.PROBED_LIMIT", 4)
    scans = []
    original = CacheManager._prune_probes

    def counting(self, started):
        scans.append(len(self._probed))
        original(self, started)

    monkeypatch.setattr(CacheManager, "_prune_probes", counting)
    cache, index = _stores()
    manager = CacheManager(cache, index, "/data/", True)
    async with command_scope():
        for n in range(64):
            manager.note_probed(
                PathSpec.from_str_path(f"/data/f{n}"), _probed()
            )
        assert len(manager._probed) == 64
    assert len(scans) <= 5


async def _settled(
    receipt: WriteReceipt | None,
    policy: ReadPolicy = ReadPolicy.BOUNDED,
    data: bytes = b"new\n",
) -> RAMFileCacheStore:
    cache, index = _stores()
    await cache.set("/data/x.txt", b"old\n", fingerprint="t-old", ttl=600)
    manager = CacheManager(cache, index, "/data/", True, read_policy=policy)
    started = manager.generation
    await manager.settle_after_write(_spec(), data, receipt, started)
    return cache


@pytest.mark.asyncio
@pytest.mark.parametrize("policy", [ReadPolicy.BOUNDED, ReadPolicy.FRESH])
async def test_settle_drops_bytes_the_backend_stored_differently(policy):
    # SharePoint property promotion: 4 bytes sent, 15 stored.
    cache = await _settled(WriteReceipt(stored_size=15, token="t1"), policy)
    assert await cache.exists("/data/x.txt") is False


@pytest.mark.asyncio
@pytest.mark.parametrize("policy", [ReadPolicy.BOUNDED, ReadPolicy.FRESH])
@pytest.mark.parametrize("size", [4, None])
async def test_settle_keeps_vouched_bytes_with_the_backend_token(policy, size):
    cache = await _settled(WriteReceipt(stored_size=size, token="t1"), policy)
    assert await cache.get("/data/x.txt") == b"new\n"
    assert await cache.is_fresh("/data/x.txt", "t1") is True
    assert await cache.is_unbounded("/data/x.txt") is False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "receipt", [None, WriteReceipt(stored_size=None, token=None)]
)
async def test_settle_keeps_a_silent_write_tokenless_on_bounded(receipt):
    cache = await _settled(receipt, ReadPolicy.BOUNDED)
    assert await cache.get("/data/x.txt") == b"new\n"
    assert await cache.is_fresh("/data/x.txt", "t-old") is False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "receipt",
    [None, WriteReceipt(stored_size=None, token=None),
     WriteReceipt(stored_size=4, token=None)],
)
async def test_settle_drops_a_silent_write_on_fresh(receipt):
    cache = await _settled(receipt, ReadPolicy.FRESH)
    assert await cache.exists("/data/x.txt") is False


@pytest.mark.asyncio
async def test_settle_drops_when_another_mutation_landed_mid_upload():
    # Two writes race on one path and the earlier upload settles last: its
    # bytes may no longer be what the backend holds.
    cache, index = _stores()
    manager = CacheManager(cache, index, "/data/", True)
    started = manager.generation
    await manager.invalidate_after_write(_spec("/data/y.txt"))
    await manager.settle_after_write(
        _spec(), b"new\n", WriteReceipt(4, "t1"), started
    )
    assert await cache.exists("/data/x.txt") is False


@pytest.mark.asyncio
async def test_settle_drops_without_a_started_generation():
    cache, index = _stores()
    await cache.set("/data/x.txt", b"old\n")
    manager = CacheManager(cache, index, "/data/", True)
    await manager.settle_after_write(
        _spec(), b"new\n", WriteReceipt(4, "t1"), None
    )
    assert await cache.exists("/data/x.txt") is False


@pytest.mark.asyncio
async def test_settle_keeps_nothing_for_a_key_the_mount_does_not_own():
    cache, index = _stores()
    await cache.set("/data/x.txt", b"old\n")
    manager = CacheManager(cache, index, "/data/", True, lambda _: False)
    await manager.settle_after_write(
        _spec(), b"new\n", WriteReceipt(4, "t1"), manager.generation
    )
    assert await cache.exists("/data/x.txt") is False


@pytest.mark.asyncio
async def test_settle_leaves_a_non_caching_mount_uncached():
    cache, index = _stores()
    manager = CacheManager(cache, index, "/data/", False)
    await manager.settle_after_write(
        _spec(), b"new\n", WriteReceipt(4, "t1"), manager.generation
    )
    assert await cache.exists("/data/x.txt") is False


@pytest.mark.asyncio
@pytest.mark.parametrize("receipt", [WriteReceipt(4, "t1"), None])
async def test_settle_evicts_the_parent_listing(receipt):
    cache, index = _stores()
    await index.set_dir(
        "/data",
        [("x.txt", IndexEntry(id="x", name="x.txt", resource_type="file"))],
    )
    manager = CacheManager(cache, index, "/data/", True)
    await manager.settle_after_write(
        _spec(), b"new\n", receipt, manager.generation
    )
    assert (await index.list_dir("/data")).entries is None


@pytest.mark.asyncio
async def test_settle_retires_a_read_that_began_before_the_keep():
    # A read_through that fetched the pre-write bytes and lands after the
    # keep must not put them back over what the write kept.
    cache, index = _stores()
    manager = CacheManager(cache, index, "/data/", True)
    fetched = asyncio.Event()
    release = asyncio.Event()

    async def fetch() -> bytes:
        fetched.set()
        await release.wait()
        return b"old\n"

    reader = asyncio.create_task(manager.read_through(_spec(), fetch))
    await fetched.wait()
    started = manager.generation
    await manager.settle_after_write(
        _spec(), b"new\n", WriteReceipt(4, "t1"), started
    )
    release.set()
    assert await reader == b"old\n"
    assert await cache.get("/data/x.txt") == b"new\n"


@pytest.mark.asyncio
async def test_settle_retires_the_commands_probe_answers():
    cache, index = _stores()
    manager = CacheManager(cache, index, "/data/", True)
    async with command_scope():
        manager.note_probed(_spec(), _probed())
        await manager.settle_after_write(
            _spec(), b"new\n", WriteReceipt(4, "t1"), manager.generation
        )
        assert manager.probed_stat(_spec()) is None

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
import threading

import pytest

from mirage.errors.types import QuotaExceededError
from mirage.types import CapacityResult, CapacityState, PathSpec
from mirage.vfs.capacity import StorageUsage, charge, storage_usage
from mirage.vfs.errors import VFSConfigError

_F = PathSpec.from_str_path("/data/f")


def test_reaching_the_limit_exactly_passes_and_one_more_byte_is_refused():
    usage = StorageUsage(10, used=6)
    usage.admit(_F, 4)
    with pytest.raises(QuotaExceededError) as err:
        usage.admit(_F, 5)
    assert err.value.errno == errno.EDQUOT


def test_growth_of_zero_or_less_passes_over_the_cap():
    usage = StorageUsage(10, used=50)
    usage.admit(_F, 0)
    usage.admit(_F, -3)


def test_a_zero_cap_admits_empty_files_only():
    usage = StorageUsage(0, used=0)
    usage.admit(_F, 0)
    with pytest.raises(QuotaExceededError):
        usage.admit(_F, 1)


def test_hold_counts_against_the_limit_until_it_lands():
    usage = StorageUsage(10, used=2)
    usage.hold(_F, 6)
    assert usage.pending == 6
    with pytest.raises(QuotaExceededError):
        usage.hold(_F, 3)
    assert usage.pending == 6
    usage.land(6, 4)
    assert (usage.used, usage.pending) == (6, 0)


def test_land_on_an_uncounted_usage_only_takes_its_hold_out():
    usage = StorageUsage(10)
    usage.pending = 5
    usage.land(5, 5)
    assert (usage.used, usage.pending) == (None, 0)


def test_report_is_the_quota_row_df_prints():
    assert StorageUsage(10, used=4).report() == CapacityResult(
        state=CapacityState.QUOTA, total=10, used=4, available=6
    )
    assert StorageUsage(10).report() == CapacityResult(
        state=CapacityState.UNKNOWN
    )


def test_report_never_shows_negative_room():
    assert StorageUsage(10, used=15).report().available == 0


def test_storage_usage_reads_the_setting():
    assert storage_usage("ram", None) is None
    usage = storage_usage("ram", "1K", used=0)
    assert usage is not None
    assert (usage.limit, usage.used) == (1024, 0)
    with pytest.raises(VFSConfigError) as err:
        storage_usage("disk", "5T")
    assert (
        str(err.value) == 'disk: capacity must be a size like 100MB, got "5T"'
    )


@pytest.mark.asyncio
async def test_parallel_callers_wait_on_one_count():
    calls = 0

    async def count() -> int:
        nonlocal calls
        calls += 1
        await asyncio.sleep(0)
        return 7

    usage = StorageUsage(10)
    await asyncio.gather(*(usage.counted(count) for _ in range(5)))
    assert (calls, usage.used) == (1, 7)
    usage.stale()
    await usage.counted(count)
    assert calls == 2


@pytest.mark.asyncio
async def test_a_charge_holds_before_and_lands_what_it_measured():
    sizes = {"/data/f": 2}

    async def size_of(path: PathSpec) -> int:
        return sizes.get(path.virtual, 0)

    async def count() -> int:
        return 2

    usage = StorageUsage(10)
    async with charge(usage, _F, size_of, count) as held:
        held.grow_to(6)
        assert usage.pending == 4
        sizes["/data/f"] = 6
    assert (usage.used, usage.pending) == (6, 0)
    with pytest.raises(QuotaExceededError):
        async with charge(usage, _F, size_of, count) as held:
            held.hold(5)
    assert (usage.used, usage.pending) == (6, 0)


@pytest.mark.asyncio
async def test_a_charge_reserves_each_chunk_of_a_stream():
    async def size_of(path: PathSpec) -> int:
        return 0

    async def count() -> int:
        return 0

    async def chunks():
        yield b"123"
        yield b"456"

    usage = StorageUsage(5)
    async with charge(usage, _F, size_of, count) as held:
        stream = held.stream(chunks())
        assert not isinstance(stream, bytes)
        assert await anext(stream) == b"123"
        with pytest.raises(QuotaExceededError):
            await anext(stream)
        assert usage.pending == 3
    assert (usage.used, usage.pending) == (0, 0)


@pytest.mark.asyncio
async def test_an_uncapped_charge_measures_nothing():
    async def size_of(path: PathSpec) -> int:
        raise AssertionError("measured")

    async def count() -> int:
        raise AssertionError("counted")

    async with charge(None, _F, size_of, count) as held:
        held.hold(100)
        assert held.stream(b"x") == b"x"


@pytest.mark.asyncio
async def test_a_replacement_reserves_only_what_passes_the_bytes_it_replaces():
    sizes = {"/data/f": 10}

    async def size_of(path: PathSpec) -> int:
        return sizes.get(path.virtual, 0)

    async def count() -> int:
        return 10

    async def chunks():
        yield b"1234"
        yield b"5678901"

    usage = StorageUsage(10)
    async with charge(usage, _F, size_of, count) as held:
        assert held.stream(b"1") == b"1"
        assert usage.pending == 0
        sizes["/data/f"] = 1
    assert usage.used == 1
    async with charge(usage, _F, size_of, count) as held:
        stream = held.stream(chunks())
        assert not isinstance(stream, bytes)
        await anext(stream)
        assert usage.pending == 3
        with pytest.raises(QuotaExceededError):
            await anext(stream)
    with pytest.raises(QuotaExceededError):
        async with charge(usage, _F, size_of, count) as held:
            held.stream(b"x" * 10, append=True)


@pytest.mark.asyncio
async def test_overlapping_writes_recount_once_none_is_in_flight():
    calls = 0
    sizes = {"/data/d/f": 4}

    async def size_of(path: PathSpec) -> int:
        return sum(
            n
            for p, n in sizes.items()
            if p == path.virtual or p.startswith(path.virtual + "/")
        )

    async def count() -> int:
        nonlocal calls
        calls += 1
        return sum(sizes.values())

    usage = StorageUsage(10)
    folder = PathSpec.from_str_path("/data/d")
    child = PathSpec.from_str_path("/data/d/f")
    async with charge(usage, folder, size_of, count):
        async with charge(usage, child, size_of, count):
            sizes.clear()
        assert usage.dirty
    assert (calls, usage.used) == (1, -4)
    async with charge(usage, _F, size_of, count):
        pass
    assert (calls, usage.used, usage.dirty) == (2, 0, False)


@pytest.mark.asyncio
async def test_a_recount_asked_mid_write_waits_for_it():
    async def size_of(path: PathSpec) -> int:
        return 0

    async def count() -> int:
        return 0

    usage = StorageUsage(10)
    async with charge(usage, _F, size_of, count) as held:
        usage.stale()
        await usage.counted(count)
        held.hold(3)
        assert usage.pending == 3
    assert usage.dirty


@pytest.mark.asyncio
async def test_a_replacement_loses_its_credit_once_a_folder_move_overlaps_it():
    sizes = {"/data/d/f": 10}

    async def size_of(path: PathSpec) -> int:
        return sum(
            n
            for p, n in sizes.items()
            if p == path.virtual or p.startswith(path.virtual + "/")
        )

    async def count() -> int:
        return sum(sizes.values())

    usage = StorageUsage(10)
    folder = PathSpec.from_str_path("/data/d")
    saved = PathSpec.from_str_path("/data/saved")
    with pytest.raises(QuotaExceededError):
        async with charge(
            usage, PathSpec.from_str_path("/data/d/f"), size_of, count
        ) as held:
            async with (
                charge(usage, folder, size_of, count),
                charge(usage, saved, size_of, count),
            ):
                sizes["/data/saved/f"] = sizes.pop("/data/d/f")
            assert held.contended
            held.stream(b"x" * 10)


@pytest.mark.asyncio
async def test_a_write_cancelled_while_it_measures_releases_its_hold():
    measured = asyncio.Event()

    async def size_of(path: PathSpec) -> int:
        if usage.pending:
            measured.set()
            await asyncio.Event().wait()
        return 0

    async def count() -> int:
        return 0

    usage = StorageUsage(10)

    async def write() -> None:
        async with charge(usage, _F, size_of, count) as held:
            held.hold(4)

    task = asyncio.ensure_future(write())
    await measured.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert (usage.pending, usage.dirty, usage.active) == (0, True, [])


def test_a_store_serves_one_running_loop_at_a_time():
    usage = StorageUsage(10, used=0)
    ready = threading.Event()
    done = threading.Event()

    async def hold_loop() -> None:
        usage.admit(_F, 1)
        ready.set()
        while not done.is_set():
            await asyncio.sleep(0.01)

    thread = threading.Thread(target=asyncio.run, args=(hold_loop(),))
    thread.start()
    ready.wait()

    async def second() -> None:
        usage.admit(_F, 1)

    try:
        with pytest.raises(RuntimeError, match="one event loop at a time"):
            asyncio.run(second())
    finally:
        done.set()
        thread.join()
    asyncio.run(second())

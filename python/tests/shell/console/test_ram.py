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

from mirage.shell.console.ram import RAMConsoleStore
from mirage.shell.console.types import Channel


@pytest.mark.asyncio
async def test_append_assigns_increasing_seq():
    store = RAMConsoleStore()

    first = await store.append(Channel.STDOUT, b"a")
    second = await store.append(Channel.STDERR, b"b")

    assert (first.seq, second.seq) == (0, 1)
    assert second.ts >= first.ts


@pytest.mark.asyncio
async def test_read_from_returns_window_and_next_cursor():
    store = RAMConsoleStore()
    for payload in (b"a", b"b", b"c"):
        await store.append(Channel.STDOUT, payload)

    chunks, next_seq, truncated = await store.read_from(1)

    assert [c.data for c in chunks] == [b"b", b"c"]
    assert next_seq == 3
    assert not truncated


@pytest.mark.asyncio
async def test_read_from_honours_limit():
    store = RAMConsoleStore()
    for payload in (b"a", b"b", b"c"):
        await store.append(Channel.STDOUT, payload)

    chunks, next_seq, _ = await store.read_from(0, limit=2)

    assert [c.data for c in chunks] == [b"a", b"b"]
    assert next_seq == 2


@pytest.mark.asyncio
async def test_read_from_the_end_is_empty_not_an_error():
    store = RAMConsoleStore()
    await store.append(Channel.STDOUT, b"a")

    chunks, next_seq, _ = await store.read_from(1)

    assert chunks == []
    assert next_seq == 1


@pytest.mark.asyncio
async def test_retention_drops_oldest_and_reports_truncation():
    store = RAMConsoleStore(max_bytes=2)
    for payload in (b"a", b"b", b"c"):
        await store.append(Channel.STDOUT, payload)

    chunks, next_seq, truncated = await store.read_from(0)

    assert truncated
    assert [c.data for c in chunks] == [b"b", b"c"]
    assert next_seq == 3


@pytest.mark.asyncio
async def test_trim_never_drops_the_terminal_control_chunk():
    """The chunk that releases wait_finished() outranks the budget."""
    store = RAMConsoleStore(max_bytes=2)
    await store.append(Channel.STDOUT, b"payload")

    await store.append(Channel.CONTROL, b"exit:0")

    chunks, _, _ = await store.read_from(0)
    assert [c.channel for c in chunks] == [Channel.CONTROL]


@pytest.mark.asyncio
async def test_reader_still_in_range_is_not_told_it_was_truncated():
    store = RAMConsoleStore(max_bytes=2)
    for payload in (b"a", b"b", b"c"):
        await store.append(Channel.STDOUT, payload)

    _, _, truncated = await store.read_from(2)

    assert not truncated


@pytest.mark.asyncio
async def test_wait_returns_immediately_when_data_already_exists():
    store = RAMConsoleStore()
    await store.append(Channel.STDOUT, b"a")

    await asyncio.wait_for(store.wait(0), timeout=1)


@pytest.mark.asyncio
async def test_wait_blocks_until_the_next_append():
    store = RAMConsoleStore()
    waiter = asyncio.create_task(store.wait(0))
    await asyncio.sleep(0)
    assert not waiter.done()

    await store.append(Channel.STDOUT, b"a")

    await asyncio.wait_for(waiter, timeout=1)


@pytest.mark.asyncio
async def test_close_releases_blocked_readers():
    store = RAMConsoleStore()
    waiter = asyncio.create_task(store.wait(0))
    await asyncio.sleep(0)

    await store.close()

    await asyncio.wait_for(waiter, timeout=1)


def test_wait_wakes_a_reader_parked_on_another_thread_and_loop():
    """The case the whole waiter registry exists for.

    Readers reach a console through run_async_from_sync, which runs them
    on a pool thread with its own event loop. A loop-bound primitive
    cannot wake them.
    """
    store = RAMConsoleStore()
    woke = threading.Event()
    ready = threading.Event()
    reader_loop: list[asyncio.AbstractEventLoop] = []

    def _read_on_its_own_loop() -> None:
        loop = asyncio.new_event_loop()
        reader_loop.append(loop)
        asyncio.set_event_loop(loop)
        try:
            loop.call_soon(ready.set)
            loop.run_until_complete(asyncio.wait_for(store.wait(0), timeout=5))
            woke.set()
        finally:
            loop.close()

    reader = threading.Thread(target=_read_on_its_own_loop)
    reader.start()
    assert ready.wait(timeout=5)

    async def _append_on_this_loop() -> None:
        await store.append(Channel.STDOUT, b"from the other loop")

    asyncio.run(_append_on_this_loop())

    reader.join(timeout=5)
    assert woke.is_set()


@pytest.mark.asyncio
async def test_append_survives_a_waiter_whose_loop_closed():
    store = RAMConsoleStore()
    dead_loop = asyncio.new_event_loop()
    future: asyncio.Future[None] = dead_loop.create_future()
    store._waiters.append((0, dead_loop, future))
    dead_loop.close()

    chunk = await store.append(Channel.STDOUT, b"a")

    assert chunk.seq == 0

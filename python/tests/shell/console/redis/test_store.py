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
import os
import uuid

import pytest
import pytest_asyncio
import redis.asyncio as aioredis

from mirage.shell.console import Channel, JobConsole
from mirage.shell.console.redis import RedisConsoleStore

REDIS_URL = os.environ.get("REDIS_URL", "")
pytestmark = pytest.mark.skipif(not REDIS_URL, reason="REDIS_URL not set")


@pytest.fixture()
def prefix() -> str:
    return f"test:console:{uuid.uuid4().hex}:"


@pytest_asyncio.fixture()
async def store(prefix):
    s = RedisConsoleStore(url=REDIS_URL, key_prefix=prefix)
    yield s
    await s.clear()
    await s.close()


@pytest.mark.asyncio
async def test_append_assigns_dense_seqs(store):
    first = await store.append(Channel.STDOUT, b"one")
    second = await store.append(Channel.STDERR, b"two")
    assert (first.seq, second.seq) == (0, 1)
    chunks, nxt, truncated = await store.read_from(0)
    assert [(c.seq, c.channel, c.data) for c in chunks] == [
        (0, Channel.STDOUT, b"one"),
        (1, Channel.STDERR, b"two"),
    ]
    assert nxt == 2
    assert truncated is False


@pytest.mark.asyncio
async def test_read_from_cursor_and_limit(store):
    for i in range(4):
        await store.append(Channel.STDOUT, str(i).encode())
    chunks, nxt, _ = await store.read_from(1, limit=2)
    assert [c.data for c in chunks] == [b"1", b"2"]
    assert nxt == 3
    chunks, nxt, _ = await store.read_from(9)
    assert chunks == []
    assert nxt == 4


@pytest.mark.asyncio
async def test_wait_wakes_on_append(store):
    await store.append(Channel.STDOUT, b"x")
    await asyncio.wait_for(store.wait(0), 2)
    waiter = asyncio.create_task(store.wait(1))
    await asyncio.sleep(0.05)
    assert not waiter.done()
    await store.append(Channel.STDOUT, b"y")
    await asyncio.wait_for(waiter, 2)


@pytest.mark.asyncio
async def test_close_releases_parked_waiter(prefix):
    s = RedisConsoleStore(url=REDIS_URL, key_prefix=prefix)
    waiter = asyncio.create_task(s.wait(0))
    await asyncio.sleep(0.05)
    await s.close()
    await asyncio.wait_for(waiter, 2)


@pytest.mark.asyncio
async def test_follow_across_instances(prefix, store):
    """A reader on its own store instance sees the writer's console.

    This is the cross-process topology in miniature: the two instances
    share nothing but the key prefix.
    """
    writer = JobConsole(store=store)
    await writer.emit(Channel.STDOUT, b"out")
    await writer.emit(Channel.STDERR, b"err")
    await writer.finish("exit:0")
    reader_store = RedisConsoleStore(url=REDIS_URL, key_prefix=prefix)
    got = []
    async for chunk in JobConsole(store=reader_store).follow():
        got.append((chunk.channel, chunk.data))
    assert got == [
        (Channel.STDOUT, b"out"),
        (Channel.STDERR, b"err"),
        (Channel.CONTROL, b"exit:0"),
    ]
    await reader_store.close()


@pytest.mark.asyncio
async def test_wire_schema_is_pinned(prefix, store):
    """The exact bytes on the wire, shared with the TypeScript twin.

    Both implementations assert this same shape (entry id ``(seq+1)-0``,
    fields ``c``/``d``/``t``, the ``seq`` counter), which is what lets a
    reader in the other language attach to a stream this one wrote.
    """
    await store.append(Channel.STDOUT, b"payload")
    client = aioredis.from_url(REDIS_URL)
    entries = await client.xrange(f"{prefix}stream", "-", "+")
    counter = await client.get(f"{prefix}seq")
    await client.aclose()
    assert counter == b"1"
    (entry_id, fields), = entries
    assert entry_id == b"1-0"
    assert fields[b"c"] == b"stdout"
    assert fields[b"d"] == b"payload"
    assert float(fields[b"t"]) > 0


@pytest.mark.asyncio
async def test_wait_finished_joins_late_control(prefix, store):
    reader_store = RedisConsoleStore(url=REDIS_URL, key_prefix=prefix)
    joiner = asyncio.create_task(
        JobConsole(store=reader_store).wait_finished())
    await store.append(Channel.STDOUT, b"still going")
    await asyncio.sleep(0.05)
    assert not joiner.done()
    await store.append(Channel.CONTROL, b"exit:0")
    await asyncio.wait_for(joiner, 2)
    await reader_store.close()


@pytest.mark.asyncio
async def test_append_after_ending_is_dropped(store):
    """The ending is terminal in the store, not only in this process.

    An emit that raced a kill past ``JobConsole``'s local guard arrives
    here after the CONTROL chunk; the append script must refuse it so
    no chunk ever lands past the ending.
    """
    await store.append(Channel.STDOUT, b"out")
    await store.append(Channel.CONTROL, b"exit:0")
    late = await store.append(Channel.STDERR, b"late")
    chunks, nxt, _ = await store.read_from(0)
    assert [c.channel for c in chunks] == [Channel.STDOUT, Channel.CONTROL]
    assert nxt == 2
    # The drop reports the last real chunk rather than minting a seq.
    assert late.seq == chunks[-1].seq


@pytest.mark.asyncio
async def test_ttl_bounds_retention(prefix):
    s = RedisConsoleStore(url=REDIS_URL, key_prefix=prefix, ttl_seconds=60)
    client = aioredis.from_url(REDIS_URL)
    try:
        assert s.key_prefix == prefix
        await s.append(Channel.STDOUT, b"x")
        assert await client.ttl(f"{prefix}stream") > 0
        assert await client.ttl(f"{prefix}seq") > 0
        await s.append(Channel.CONTROL, b"exit:0")
        assert await client.ttl(f"{prefix}ended") > 0
    finally:
        await client.aclose()
        await s.clear()
        await s.close()


@pytest.mark.asyncio
async def test_no_ttl_by_default(prefix, store):
    await store.append(Channel.STDOUT, b"x")
    client = aioredis.from_url(REDIS_URL)
    try:
        assert await client.ttl(f"{prefix}stream") == -1
        assert await client.ttl(f"{prefix}seq") == -1
    finally:
        await client.aclose()

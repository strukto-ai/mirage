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
async def test_wait_finished_joins_late_control(prefix, store):
    reader_store = RedisConsoleStore(url=REDIS_URL, key_prefix=prefix)
    joiner = asyncio.create_task(JobConsole(store=reader_store).wait_finished())
    await store.append(Channel.STDOUT, b"still going")
    await asyncio.sleep(0.05)
    assert not joiner.done()
    await store.append(Channel.CONTROL, b"exit:0")
    await asyncio.wait_for(joiner, 2)
    await reader_store.close()

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

from mirage.io.cachable_iterator import CachableAsyncIterator
from mirage.workspace.mount.activity import ResourceActivity


@pytest.mark.asyncio
@pytest.mark.parametrize("finish", ["eof", "error", "close", "bounded"])
async def test_resource_usage_ends_with_its_stream(finish):
    activity = ResourceActivity()

    async def chunks():
        yield b"value"
        if finish == "error":
            raise ValueError("read failed")

    source = chunks()
    if finish == "bounded":
        source = CachableAsyncIterator(source)
    source = activity.hold(source)
    waiting = asyncio.create_task(activity.wait())
    await asyncio.sleep(0)
    assert not waiting.done()
    if finish == "close":
        await source.aclose()
        await source.aclose()
    elif finish == "bounded":
        assert await source.drain_bounded(0) is None
    elif finish == "error":
        with pytest.raises(ValueError, match="read failed"):
            async for _ in source:
                pass
    else:
        assert b"".join([chunk async for chunk in source]) == b"value"
    await asyncio.wait_for(waiting, 5)
    release = activity.acquire()
    waiting = asyncio.create_task(activity.wait())
    await asyncio.sleep(0)
    assert not waiting.done()
    release()
    await asyncio.wait_for(waiting, 5)


@pytest.mark.asyncio
async def test_exhausted_cache_stream_does_not_keep_a_resource_active():
    content = b"value"

    async def chunks():
        yield content

    cached = CachableAsyncIterator(chunks())
    assert await cached.drain() == content
    activity = ResourceActivity()
    activity.hold(cached)
    await asyncio.wait_for(activity.wait(), 1)


@pytest.mark.asyncio
async def test_close_waits_for_a_pending_pull_before_releasing_usage():
    activity = ResourceActivity()
    entered = asyncio.Event()
    release = asyncio.Event()

    async def chunks():
        entered.set()
        await release.wait()
        yield b"value"

    source = activity.hold(chunks())
    pulling = asyncio.create_task(source.__anext__())
    await entered.wait()
    closing = asyncio.create_task(source.aclose())
    waiting = asyncio.create_task(activity.wait())
    await asyncio.sleep(0)
    assert not closing.done()
    assert not waiting.done()
    release.set()
    assert await pulling == b"value"
    await asyncio.wait_for(asyncio.gather(closing, waiting), 1)

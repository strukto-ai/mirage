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

from mirage.utils.activity import Activity


class _DelegatedSource:
    def __init__(self, source):
        self.source = source

    def __aiter__(self):
        return self

    async def __anext__(self):
        return await anext(self.source)

    async def aclose(self):
        await self.source.aclose()


class _ClosingSource:
    def __init__(self):
        self.started = asyncio.Event()
        self.stopped = asyncio.Event()
        self.cleaned = asyncio.Event()
        self.closes = 0

    def __aiter__(self):
        return self

    async def __anext__(self):
        self.started.set()
        await self.stopped.wait()
        raise StopAsyncIteration

    async def aclose(self):
        self.closes += 1
        self.stopped.set()
        await self.cleaned.wait()


@pytest.mark.asyncio
@pytest.mark.parametrize("finish", ["eof", "error", "close"])
async def test_usage_ends_with_its_stream(finish):
    activity = Activity()

    async def chunks():
        yield b"value"
        if finish == "error":
            raise ValueError("read failed")

    source = activity.hold(chunks())
    waiting = asyncio.create_task(activity.wait())
    await asyncio.sleep(0)
    assert not waiting.done()
    if finish == "close":
        await source.aclose()
        await source.aclose()
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
@pytest.mark.parametrize("wrapped", [False, True])
async def test_close_waits_for_a_pending_pull_before_releasing_usage(wrapped):
    activity = Activity()
    entered = asyncio.Event()
    release = asyncio.Event()

    async def chunks():
        entered.set()
        await release.wait()
        yield b"value"

    raw = chunks()
    source = activity.hold(_DelegatedSource(raw) if wrapped else raw)
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


@pytest.mark.asyncio
async def test_close_wakes_a_pending_pull_and_retains_usage_through_cleanup():
    activity = Activity()
    source = _ClosingSource()
    held = activity.hold(source)
    pulling = asyncio.create_task(anext(held))
    await source.started.wait()
    closing = asyncio.create_task(held.aclose())
    again = asyncio.create_task(held.aclose())
    waiting = asyncio.create_task(activity.wait())
    try:
        await asyncio.wait_for(source.stopped.wait(), 1)
        with pytest.raises(StopAsyncIteration):
            await asyncio.wait_for(pulling, 1)
        await asyncio.sleep(0)
        assert not waiting.done()
        assert not closing.done()
        assert not again.done()
        assert source.closes == 1
        closing.cancel()
        await asyncio.sleep(0)
        closing.cancel()
        await asyncio.sleep(0)
        assert not closing.done()
        assert not waiting.done()
        source.cleaned.set()
        await asyncio.wait_for(asyncio.gather(closing, again, waiting), 1)
        await held.aclose()
        assert source.closes == 1
    finally:
        source.stopped.set()
        source.cleaned.set()
        await asyncio.gather(
            pulling, closing, again, waiting, return_exceptions=True
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("error", [ValueError, RuntimeError])
async def test_failed_close_releases_usage_and_is_not_retried(error):
    activity = Activity()
    source = _ClosingSource()

    async def fail():
        source.closes += 1
        raise error("close failed")

    source.aclose = fail
    held = activity.hold(source)
    for _ in range(2):
        with pytest.raises(error, match="close failed"):
            await held.aclose()
    await asyncio.wait_for(activity.wait(), 1)
    assert source.closes == 1

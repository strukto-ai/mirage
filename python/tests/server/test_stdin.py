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

from mirage.io.cooperative import CHUNK_SIZE
from mirage.io.pipe import CAPACITY
from mirage.server.stdin import LoopStdin, UploadStdin


@pytest.mark.asyncio
async def test_an_upload_reads_back_in_order_then_ends():
    upload = UploadStdin()
    await upload.feed(b"a")
    await upload.feed(b"")
    await upload.feed(b"b")
    await upload.close()
    assert [await upload.read() for _ in range(4)] == [b"a", b"b", b"", b""]


@pytest.mark.asyncio
@pytest.mark.parametrize("capacity", [CAPACITY, CAPACITY * 2])
async def test_a_full_upload_waits_for_the_reader(capacity):
    upload = UploadStdin(capacity)
    for i in range(capacity // CHUNK_SIZE):
        await upload.feed(bytes([i]) * CHUNK_SIZE)
    blocked = asyncio.ensure_future(upload.feed(b"next"))
    await asyncio.sleep(0.05)
    assert not blocked.done()
    assert await upload.read() == b"\x00" * CHUNK_SIZE
    await asyncio.wait_for(blocked, 1)
    await upload.close()
    remaining = []
    while chunk := await upload.read():
        remaining.append(chunk)
    assert (
        b"".join(remaining)
        == b"".join(
            bytes([i]) * CHUNK_SIZE for i in range(1, capacity // CHUNK_SIZE)
        )
        + b"next"
    )


@pytest.mark.asyncio
async def test_discard_frees_a_waiting_feed_and_drops_the_rest():
    upload = UploadStdin()
    for i in range(CAPACITY // CHUNK_SIZE):
        await upload.feed(bytes([i]) * CHUNK_SIZE)
    blocked = asyncio.ensure_future(upload.feed(b"next"))
    await asyncio.sleep(0.05)
    upload.discard()
    await asyncio.wait_for(blocked, 1)
    await upload.feed(b"later")
    await upload.close()
    assert await upload.read() == b""


@pytest.mark.asyncio
async def test_discard_ends_a_waiting_read():
    upload = UploadStdin()
    waiting = asyncio.ensure_future(upload.read())
    await asyncio.sleep(0.05)
    upload.discard()
    assert await asyncio.wait_for(waiting, 1) == b""


def test_a_line_on_another_loop_reads_the_upload():
    async def main() -> list[bytes]:
        upload = UploadStdin()
        home = asyncio.get_running_loop()
        got: list[bytes] = []

        def other_loop() -> None:
            async def pull() -> None:
                got.extend([c async for c in LoopStdin(upload, home)])

            asyncio.run(pull())

        thread = threading.Thread(target=other_loop)
        thread.start()
        await upload.feed(b"x" * 3)
        await upload.feed(b"y")
        await upload.close()
        await asyncio.to_thread(thread.join, 5)
        return got

    assert asyncio.run(main()) == [b"xxx", b"y"]

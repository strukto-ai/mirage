import asyncio
import time

import pytest

from mirage.concurrency.worker import Worker
from mirage.rs.errors import StreamRefusal


@pytest.mark.asyncio
async def test_a_rust_refusal_keeps_partial_output_and_releases_the_process():
    worker = Worker()
    try:
        await worker.call(time.monotonic)
        process = worker._process
        with pytest.raises(StreamRefusal) as refused:
            await worker.call(
                eval,
                "__import__('mirage.rs.stream', fromlist=['open_stream'])"
                ".open_stream('base64', {'mode': 'decode', "
                "'ignore_garbage': False}).feed(b'YWJj*')",
            )
        assert refused.value.message == "base64: invalid input"
        assert str(refused.value) == "base64: invalid input"
        assert refused.value.output == b"abc"
        assert process is not None and process.returncode is not None
        assert worker._process is None
        assert await worker.call(len, b"recovered") == 9
    finally:
        await worker.close()


@pytest.mark.asyncio
async def test_cancel_kills_and_joins_the_owned_process():
    worker = Worker()
    await worker.call(time.monotonic)
    process = worker._process
    task = asyncio.create_task(worker.call(time.sleep, 120))
    try:
        await asyncio.sleep(0.02)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 1)
        assert process is not None and process.returncode is not None
        assert worker._process is None
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await worker.close()

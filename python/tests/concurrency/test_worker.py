import asyncio
import time

import pytest

from mirage.concurrency.worker import Worker


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


@pytest.mark.asyncio
async def test_failed_stop_retains_child_and_refuses_more_work(monkeypatch):
    worker = Worker()
    await worker.call(time.monotonic)
    process = worker._process
    assert process is not None
    kill = process.kill

    def reject():
        raise PermissionError("termination refused")

    monkeypatch.setattr(process, "kill", reject)
    try:
        with pytest.raises(PermissionError, match="termination refused"):
            await worker.close()
        assert worker._process is process and process.returncode is None
        with pytest.raises(PermissionError, match="termination refused"):
            await worker.call(time.monotonic)
        assert worker._process is process and process.returncode is None
        monkeypatch.setattr(process, "kill", kill)
        await worker.close(retry=True)
        assert process.returncode is not None and worker._process is None
    finally:
        monkeypatch.setattr(process, "kill", kill)
        await worker.close(retry=True)

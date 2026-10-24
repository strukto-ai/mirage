import asyncio
import os
import signal
import subprocess
import sys
from functools import partial

import pytest

from mirage.commands.builtin.generic.diff import DiffFlags, diff
from mirage.rs import diff_pool
from mirage.rs.diff_pool import DiffPool
from mirage.rs.diff_types import DiffOptions
from mirage.rs.errors import StreamRefusal
from mirage.types import PathSpec


async def _bytes(value: bytes = b"a\n") -> bytes:
    return value


async def _unexpected_metadata(path):
    raise AssertionError(f"unexpected metadata read for {path.virtual}")


async def _standalone_diff_cleanup():
    diff_pool.RETIRE_BYTES = 0
    original = asyncio.create_subprocess_exec
    processes = []
    attempts = 0

    async def start(*args, **kwargs):
        process = await original(*args, **kwargs)
        processes.append(process)
        kill = process.kill

        def stop():
            nonlocal attempts
            attempts += 1
            assert process.returncode is None
            if attempts == 1:
                raise PermissionError("termination refused")
            kill()

        process.kill = stop
        return process

    files = {"/a": b"a\n", "/b": b"b\n"}

    async def read(path):
        return files[path.virtual]

    asyncio.create_subprocess_exec = start
    try:
        await diff(
            [PathSpec.from_str_path(path, "") for path in files],
            stream=read,
            readdir_fn=_unexpected_metadata,
            stat_fn=_unexpected_metadata,
            flags=DiffFlags(),
        )
    except ExceptionGroup as exc:
        assert len(exc.exceptions) == 1
        assert isinstance(exc.exceptions[0], PermissionError)
    else:
        raise AssertionError("cleanup failure was not reported")
    assert attempts == 2
    assert len(processes) == 1 and processes[0].returncode is not None
    print("cleanup retried and child joined")


def test_standalone_diff_retries_failed_retirement_without_joining_caller():
    with subprocess.Popen(
        [
            sys.executable,
            "-c",
            "import asyncio, runpy, sys; "
            "asyncio.run(runpy.run_path(sys.argv[1])"
            "['_standalone_diff_cleanup']())",
            __file__,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    ) as child:
        try:
            stdout, stderr = child.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            stdout, stderr = child.communicate()
            pytest.fail(f"standalone diff cleanup hung: {stdout}{stderr}")
        assert child.returncode == 0, stderr
        assert stdout == "cleanup retried and child joined\n"


@pytest.mark.asyncio
async def test_reuses_worker_and_expires_idle_process(monkeypatch):
    monkeypatch.setattr(diff_pool, "IDLE_TTL", 0.03)
    pool = DiffPool()
    try:
        first = await pool.compare(
            DiffOptions(), _bytes, partial(_bytes, b"b\n")
        )
        assert first.outcome == "different" and first.status == 1
        assert b"".join(first.output) == b"1c1\n< a\n---\n> b\n"
        entry = next(iter(pool._entries))
        process = entry.worker._process
        assert process is not None
        second = await pool.compare(DiffOptions(), _bytes, _bytes)
        assert second.outcome == "equal" and not second.output
        assert next(iter(pool._entries)).worker._process is process
        for _ in range(100):
            if not pool._entries:
                break
            await asyncio.sleep(0.01)
        assert not pool._entries
        assert process.returncode is not None
        await pool.compare(DiffOptions(), _bytes, _bytes)
        assert next(iter(pool._entries)).worker._process is not process
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_fifo_admission_reads_only_after_capacity_and_cancels_queue(
    monkeypatch,
):
    monkeypatch.setattr(diff_pool, "WORKER_LIMIT", 1)
    monkeypatch.setattr(diff_pool, "QUEUE_LIMIT", 2)
    admitted = asyncio.Event()
    release = asyncio.Event()
    order = []

    async def blocked():
        admitted.set()
        await release.wait()
        return b"a\n"

    async def tracked(number):
        order.append(number)
        return b"a\n"

    pool = DiffPool()
    first = asyncio.create_task(pool.compare(DiffOptions(), blocked, _bytes))
    await admitted.wait()
    second = asyncio.create_task(
        pool.compare(DiffOptions(), partial(tracked, 2), _bytes)
    )
    third = asyncio.create_task(
        pool.compare(DiffOptions(), partial(tracked, 3), _bytes)
    )
    await asyncio.sleep(0)
    assert not order
    with pytest.raises(RuntimeError, match="queue is full"):
        await pool.compare(DiffOptions(), _bytes, _bytes)
    third.cancel()
    with pytest.raises(asyncio.CancelledError):
        await third
    fourth = asyncio.create_task(
        pool.compare(DiffOptions(), partial(tracked, 4), _bytes)
    )
    release.set()
    try:
        await asyncio.wait_for(asyncio.gather(first, second, fourth), 10)
        assert order == [2, 4]
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_cancel_active_comparison_joins_child_and_recovers():
    pool = DiffPool()
    admitted = asyncio.Event()
    released = asyncio.Event()

    async def blocked():
        admitted.set()
        try:
            await asyncio.Future()
        finally:
            released.set()

    task = asyncio.create_task(pool.compare(DiffOptions(), blocked, _bytes))
    await admitted.wait()
    process = next(iter(pool._entries)).worker._process
    task.cancel()
    try:
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 5)
        assert released.is_set()
        assert process is not None and process.returncode is not None
        assert not pool._entries
        assert (await pool.compare(DiffOptions(), _bytes, _bytes)).status == 0
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_startup_failure_releases_capacity(monkeypatch):
    original = asyncio.create_subprocess_exec
    calls = 0

    async def start(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise PermissionError("workers disabled")
        return await original(*args, **kwargs)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", start)
    pool = DiffPool()
    try:
        with pytest.raises(RuntimeError, match="workers disabled"):
            await pool.compare(DiffOptions(), _bytes, _bytes)
        assert not pool._entries
        assert (await pool.compare(DiffOptions(), _bytes, _bytes)).status == 0
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_idle_death_is_reported_and_next_comparison_recovers():
    pool = DiffPool()
    try:
        await pool.compare(DiffOptions(), _bytes, _bytes)
        process = next(iter(pool._entries)).worker._process
        assert process is not None
        os.kill(process.pid, signal.SIGKILL)
        await process.wait()
        with pytest.raises(RuntimeError, match="exited"):
            await pool.compare(DiffOptions(), _bytes, _bytes)
        assert not pool._entries
        assert (await pool.compare(DiffOptions(), _bytes, _bytes)).status == 0
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_failed_real_termination_retains_handle_capacity_and_close_retries(
    monkeypatch,
):
    monkeypatch.setattr(diff_pool, "WORKER_LIMIT", 1)
    monkeypatch.setattr(diff_pool, "IDLE_TTL", 0.01)
    pool = DiffPool()
    await pool.compare(DiffOptions(), _bytes, _bytes)
    entry = next(iter(pool._entries))
    process = entry.worker._process
    assert process is not None
    kill = process.kill

    def reject():
        raise PermissionError("termination refused")

    monkeypatch.setattr(process, "kill", reject)
    for _ in range(100):
        if entry.state == "stop_failed":
            break
        await asyncio.sleep(0.01)
    try:
        assert entry.state == "stop_failed"
        assert entry.worker._process is process
        assert process.returncode is None
        os.kill(process.pid, 0)
        with pytest.raises(RuntimeError, match="could not be stopped"):
            await pool.compare(DiffOptions(), _bytes, _bytes)
        monkeypatch.setattr(process, "kill", kill)
        results = await asyncio.gather(
            pool.close(), pool.close(), return_exceptions=True
        )
        assert all(isinstance(result, ExceptionGroup) for result in results)
        assert results[0] is results[1]
        assert process.returncode is not None
        assert entry.worker._process is None
        assert not pool._entries
    finally:
        monkeypatch.setattr(process, "kill", kill)
        await entry.worker.close(retry=True)


@pytest.mark.asyncio
async def test_close_cancels_active_rejects_queued_and_waits_for_all_children(
    monkeypatch,
):
    monkeypatch.setattr(diff_pool, "WORKER_LIMIT", 2)
    pool = DiffPool()
    admitted = 0
    ready = asyncio.Event()
    cleaned = []

    async def blocked():
        nonlocal admitted
        admitted += 1
        if admitted == 2:
            ready.set()
        try:
            await asyncio.Future()
        finally:
            await asyncio.sleep(0)
            cleaned.append(True)

    active = [
        asyncio.create_task(pool.compare(DiffOptions(), blocked, _bytes))
        for _ in range(2)
    ]
    await ready.wait()
    processes = [entry.worker._process for entry in pool._entries]
    queued = asyncio.create_task(pool.compare(DiffOptions(), _bytes, _bytes))
    await asyncio.sleep(0)
    await asyncio.wait_for(asyncio.gather(pool.close(), pool.close()), 5)
    results = await asyncio.gather(*active, queued, return_exceptions=True)
    assert all(
        isinstance(result, asyncio.CancelledError) for result in results[:2]
    )
    assert isinstance(results[2], RuntimeError)
    assert cleaned == [True, True]
    assert all(
        process is not None and process.returncode is not None
        for process in processes
    )
    assert not pool._entries


@pytest.mark.asyncio
async def test_large_output_is_bounded_and_event_loop_runs():
    pool = DiffPool()
    heartbeat = asyncio.Event()

    async def tick():
        await asyncio.sleep(0.001)
        heartbeat.set()

    ticker = asyncio.create_task(tick())
    try:
        result = await pool.compare(
            DiffOptions(),
            partial(_bytes, b"a" * 500000),
            partial(_bytes, b"b" * 500000),
        )
        assert heartbeat.is_set()
        assert result.status == 1
        assert all(len(part) <= diff_pool.CHUNK_SIZE for part in result.output)
        assert sum(map(len, result.output)) > 1000000
    finally:
        await ticker
        await pool.close()


@pytest.mark.asyncio
async def test_cancel_after_match_request_joins_computing_child(monkeypatch):
    from mirage.rs import diff_worker

    sent = asyncio.Event()
    original = diff_pool.Worker.send

    async def send(worker, fn, *args):
        await original(worker, fn, *args)
        if fn is diff_worker.end and args == (1,):
            sent.set()

    monkeypatch.setattr(diff_pool.Worker, "send", send)
    pool = DiffPool()
    old = b"".join(f"old-{index}\n".encode() for index in range(100000))
    new = b"".join(f"new-{index}\n".encode() for index in range(100000))
    task = asyncio.create_task(
        pool.compare(DiffOptions(), partial(_bytes, old), partial(_bytes, new))
    )
    await asyncio.wait_for(sent.wait(), 10)
    process = next(iter(pool._entries)).worker._process
    task.cancel()
    try:
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 5)
        assert process is not None and process.returncode is not None
        assert (await pool.compare(DiffOptions(), _bytes, _bytes)).status == 0
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_one_cleanup_failure_does_not_skip_other_workers(monkeypatch):
    pool = DiffPool()
    ready = asyncio.Event()
    count = 0

    async def blocked():
        nonlocal count
        count += 1
        if count == 2:
            ready.set()
        await asyncio.Future()

    tasks = [
        asyncio.create_task(pool.compare(DiffOptions(), blocked, _bytes))
        for _ in range(2)
    ]
    await ready.wait()
    entries = list(pool._entries)
    refusing = entries[0].worker._process
    healthy = entries[1].worker._process
    assert refusing is not None and healthy is not None
    kill = refusing.kill

    def reject():
        raise PermissionError("termination refused")

    monkeypatch.setattr(refusing, "kill", reject)
    try:
        with pytest.raises(ExceptionGroup):
            await asyncio.wait_for(pool.close(), 5)
        assert healthy.returncode is not None
        assert refusing.returncode is None
        assert entries[0].worker._process is refusing
        os.kill(refusing.pid, 0)
    finally:
        monkeypatch.setattr(refusing, "kill", kill)
        await entries[0].worker.close(retry=True)
        await asyncio.gather(*tasks, return_exceptions=True)


@pytest.mark.asyncio
async def test_stop_rejects_without_reading_new_inputs():
    pool = DiffPool()
    pool.stop()

    async def unread():
        raise AssertionError("closed pool read an input")

    with pytest.raises(RuntimeError, match="closed"):
        await pool.compare(DiffOptions(), unread, unread)
    await pool.close()


@pytest.mark.asyncio
async def test_ed_incomplete_lines_preserve_output_diagnostics_and_trouble_status():
    pool = DiffPool()
    try:
        result = await pool.compare(
            DiffOptions(mode="ed", old_label="a", new_label="b"),
            partial(_bytes, b"a"),
            partial(_bytes, b"b"),
        )
        assert result.outcome == "different"
        assert result.status == 2
        assert b"".join(result.output) == b"1c\nb\n.\n"
        assert b"".join(result.stderr) == (
            b"diff: a: No newline at end of file\n\n"
            b"diff: b: No newline at end of file\n\n"
        )
        equal = await pool.compare(
            DiffOptions(mode="ed"),
            partial(_bytes, b"a"),
            partial(_bytes, b"a"),
        )
        assert equal.outcome == "equal" and equal.status == 2
        assert not equal.output
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_cancellation_during_startup_keeps_and_joins_late_child(
    monkeypatch,
):
    original = asyncio.create_subprocess_exec
    created = asyncio.Event()
    release = asyncio.Event()
    processes = []

    async def start(*args, **kwargs):
        process = await original(*args, **kwargs)
        processes.append(process)
        if len(processes) == 1:
            created.set()
            await release.wait()
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", start)
    pool = DiffPool()
    task = asyncio.create_task(pool.compare(DiffOptions(), _bytes, _bytes))
    await asyncio.wait_for(created.wait(), 5)
    task.cancel()
    await asyncio.sleep(0)
    assert not task.done()
    release.set()
    try:
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 5)
        assert processes[0].returncode is not None
        assert not pool._entries
        assert (await pool.compare(DiffOptions(), _bytes, _bytes)).status == 0
    finally:
        release.set()
        await pool.close()


@pytest.mark.asyncio
async def test_queued_requests_reject_when_cancelled_workers_cannot_stop(
    monkeypatch,
):
    monkeypatch.setattr(diff_pool, "WORKER_LIMIT", 1)
    pool = DiffPool()
    admitted = asyncio.Event()

    async def blocked():
        admitted.set()
        await asyncio.Future()

    task = asyncio.create_task(pool.compare(DiffOptions(), blocked, _bytes))
    await admitted.wait()
    entry = next(iter(pool._entries))
    process = entry.worker._process
    assert process is not None
    kill = process.kill

    def reject():
        raise PermissionError("termination refused")

    monkeypatch.setattr(process, "kill", reject)
    queued = asyncio.create_task(pool.compare(DiffOptions(), _bytes, _bytes))
    await asyncio.sleep(0)
    task.cancel()
    try:
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 5)
        with pytest.raises(RuntimeError, match="could not be stopped"):
            await asyncio.wait_for(queued, 5)
        assert entry.state == "stop_failed"
        assert entry.worker._process is process and process.returncode is None
        monkeypatch.setattr(process, "kill", kill)
        with pytest.raises(ExceptionGroup, match="cleanup failed"):
            await pool.close()
        assert process.returncode is not None
    finally:
        monkeypatch.setattr(process, "kill", kill)
        await entry.worker.close(retry=True)


@pytest.mark.asyncio
async def test_native_config_refusal_survives_worker_and_pool_recovers():
    pool = DiffPool()
    try:
        with pytest.raises(StreamRefusal) as refused:
            await pool.compare(DiffOptions(context=-1), _bytes, _bytes)
        assert refused.value.message.startswith(
            "bad stream config: a count cannot be negative"
        )
        assert refused.value.output == b""
        assert not pool._entries
        assert (await pool.compare(DiffOptions(), _bytes, _bytes)).status == 0
    finally:
        await pool.close()

import asyncio

import pytest

from mirage.io.cooperative import CHUNK_SIZE
from mirage.io.stdio import Stdio, invoke
from mirage.io.types import CountedRun, IOResult, materialize


@pytest.mark.asyncio
async def test_interleaved_writers_are_bounded_and_settle_late_status():
    events = []
    done = asyncio.Event()

    async def run(stdio: Stdio):
        await stdio.stdout.write(b"a" * (CHUNK_SIZE * 8))
        await stdio.stderr.write(b"error" * (CHUNK_SIZE * 2))
        await stdio.stdout.write(b"z")
        done.set()
        return IOResult(exit_code=7, counted_runs=[CountedRun((1,), "/a")])

    source, io = await invoke(run)
    assert not done.is_set()

    async def stderr(data):
        events.append(("stderr", data))

    io.output.stderr = stderr
    async for data in source:
        assert len(data) <= CHUNK_SIZE
        events.append(("stdout", data))
    assert done.is_set()
    assert io.exit_code == 7
    assert io.counted_runs == [CountedRun((1,), "/a")]
    assert (
        b"".join(data for channel, data in events if channel == "stdout")
        == b"a" * (CHUNK_SIZE * 8) + b"z"
    )
    assert b"".join(
        data for channel, data in events if channel == "stderr"
    ) == b"error" * (CHUNK_SIZE * 2)
    assert events[-1] == ("stdout", b"z")


@pytest.mark.asyncio
async def test_captured_stderr_and_late_error_preserve_prefix():
    async def run(stdio):
        await stdio.stdout.write(b"prefix")
        await stdio.stderr.write(b"warning")
        raise ValueError("late")

    source, io = await invoke(run)
    assert await anext(source) == b"prefix"
    with pytest.raises(ValueError, match="late"):
        await anext(source)
    assert await io.materialize_stderr() == b"warning"


@pytest.mark.asyncio
async def test_reader_close_cancels_and_joins_stalled_input():
    closed = asyncio.Event()

    async def stdin():
        try:
            await asyncio.Event().wait()
            yield b""
        finally:
            closed.set()

    async def run(stdio):
        await stdio.stdout.write(b"prefix")
        async for data in stdio.stdin:
            await stdio.stdout.write(data)

    source, io = await invoke(run, stdin())
    assert await anext(source) == b"prefix"
    await asyncio.wait_for(source.aclose(), 1)
    assert closed.is_set()


@pytest.mark.asyncio
async def test_returned_output_uses_owned_stream_and_preserves_eager_metadata():
    expected = IOResult(stderr=b"diagnostic", exit_code=3)

    async def run(stdio):
        return expected

    source, io = await invoke(run)
    assert io.exit_code == 3
    assert not io.output.settled
    assert await materialize(source) == b""
    assert io.output.settled
    assert await materialize(io.stderr) == b"diagnostic"


@pytest.mark.asyncio
async def test_close_before_first_pull_still_joins_the_writer():
    closed = asyncio.Event()

    async def run(stdio):
        try:
            await stdio.stdout.write(b"prefix")
            await asyncio.Event().wait()
        finally:
            closed.set()

    source, _ = await invoke(run)
    await asyncio.wait_for(source.aclose(), 1)
    assert closed.is_set()


@pytest.mark.asyncio
async def test_close_cancels_an_active_output_pull():
    closed = asyncio.Event()

    async def run(stdio):
        try:
            await stdio.stdout.write(b"prefix")
            await stdio.wait_cancelled()
        finally:
            closed.set()

    source, _ = await invoke(run)
    assert await anext(source) == b"prefix"
    pending = asyncio.create_task(anext(source))
    await asyncio.sleep(0)
    await asyncio.wait_for(source.aclose(), 1)
    await asyncio.gather(pending, return_exceptions=True)
    assert closed.is_set()


@pytest.mark.asyncio
async def test_cancelled_individual_write_does_not_shift_following_channel():
    timed_out = asyncio.Event()

    async def run(stdio):
        try:
            await asyncio.wait_for(
                stdio.stdout.write(b"a" * (CHUNK_SIZE * 5)), 0.01
            )
        except TimeoutError:
            timed_out.set()
        await stdio.stderr.write(b"diagnostic")
        return IOResult()

    source, io = await invoke(run)
    await asyncio.wait_for(timed_out.wait(), 1)
    assert await materialize(source) == b"a" * (CHUNK_SIZE * 4)
    assert await io.materialize_stderr() == b"diagnostic"


@pytest.mark.asyncio
@pytest.mark.parametrize("none", [True, False])
async def test_no_output_joins_partially_consumed_stdin(none):
    closed = asyncio.Event()

    async def stdin():
        try:
            yield b"first"
            yield b"last"
        finally:
            closed.set()

    async def run(stdio):
        assert await anext(stdio.stdin) == b"first"
        return None if none else IOResult()

    await invoke(run, stdin())
    assert closed.is_set()


@pytest.mark.asyncio
@pytest.mark.parametrize("channel", ["stdout", "stderr"])
async def test_lazy_returned_output_retains_stdin(channel):
    closed = asyncio.Event()

    async def stdin():
        try:
            yield b"first"
            yield b"last"
        finally:
            closed.set()

    async def run(stdio):
        assert await anext(stdio.stdin) == b"first"
        return IOResult(**{channel: stdio.stdin})

    source, io = await invoke(run, stdin())
    assert not closed.is_set()
    stdout = await materialize(source)
    assert (
        stdout if channel == "stdout" else await materialize(io.stderr)
    ) == b"last"
    assert closed.is_set()


@pytest.mark.asyncio
async def test_native_and_returned_output_share_order_and_late_status():
    outcome = IOResult()
    events = []

    async def returned():
        yield b"returned"
        outcome.exit_code = 9

    async def run(stdio):
        await stdio.stdout.write(b"written")
        await stdio.stderr.write(b"warning")
        outcome.stderr = b"returned error"
        return returned(), outcome

    source, io = await invoke(run)

    async def stderr(data):
        events.append(("stderr", data))

    io.output.stderr = stderr
    async for data in source:
        events.append(("stdout", data))
    assert events == [
        ("stdout", b"written"),
        ("stderr", b"warning"),
        ("stdout", b"returned"),
        ("stderr", b"returned error"),
    ]
    assert io.exit_code == 9


@pytest.mark.asyncio
async def test_eager_failure_and_decline_finish_before_publication():
    async def fail(stdio):
        raise ValueError("eager")

    async def decline(stdio):
        return None

    with pytest.raises(ValueError, match="eager"):
        await invoke(fail)
    assert await invoke(decline) is None


@pytest.mark.asyncio
async def test_returned_generator_publishes_late_diagnostics_and_metadata_once():
    outcome = IOResult(counted_runs=[CountedRun((1,), "early")])
    finalized = []

    async def returned():
        yield b"prefix"
        outcome.stderr = b"late diagnostic"
        outcome.counted_runs = [CountedRun((3,), "late")]
        outcome.exit_code = 5

    async def run(stdio):
        return returned(), outcome

    source, io = await invoke(run)
    assert io.counted_runs == [CountedRun((1,), "early")]
    io.output.callbacks.append(lambda: finalized.append(io.counted_runs))
    assert await materialize(source) == b"prefix"
    assert await materialize(io.stderr) == b"late diagnostic"
    assert io.counted_runs == [CountedRun((3,), "late")]
    assert io.exit_code == 5
    assert finalized == [[CountedRun((3,), "late")]]
    await source.aclose()
    assert len(finalized) == 1


@pytest.mark.asyncio
async def test_returned_stderr_survives_failed_stdout():
    async def returned():
        yield b"prefix"
        raise ValueError("late")

    async def run(stdio):
        return returned(), IOResult(stderr=b"diagnostic")

    source, io = await invoke(run)
    assert await anext(source) == b"prefix"
    with pytest.raises(ValueError, match="late"):
        await anext(source)
    assert await materialize(io.stderr) == b"diagnostic"


@pytest.mark.asyncio
async def test_early_close_retains_cleanup_diagnostic_and_finalizes_once():
    outcome = IOResult(exit_code=1)
    finalized = []

    async def returned():
        try:
            yield b"first"
            yield b"second"
        finally:
            outcome.stderr = b"finished"
            outcome.counted_runs = [CountedRun((1,), "cleanup")]
            outcome.exit_code = 0

    async def run(stdio):
        return returned(), outcome

    source, io = await invoke(run)
    io.output.callbacks.append(lambda: finalized.append(io.counted_runs))
    assert await anext(source) == b"first"
    await source.aclose()
    assert io.stderr == b"finished"
    assert io.exit_code == 0
    assert finalized == [[CountedRun((1,), "cleanup")]]


@pytest.mark.asyncio
async def test_external_producer_cancellation_does_not_wait_for_stderr_reader():
    owners = []

    async def returned():
        yield b"prefix"
        yield b"second"

    async def run(stdio):
        owners.append(asyncio.current_task())
        return returned(), IOResult(stderr=b"diagnostic")

    source, _ = await invoke(run)
    assert await anext(source) == b"prefix"
    owners[0].cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(owners[0], 1)
    await source.aclose()

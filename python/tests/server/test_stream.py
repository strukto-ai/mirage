import asyncio
import base64
import json

import pytest
from starlette.requests import Request

from mirage.execution.ram import RAMExecutionStore
from mirage.io.pipe import CAPACITY
from mirage.server.jobs import JobTable
from mirage.server.stream import ShellOutput, ShellResponse
from mirage.shell.console.types import Channel


@pytest.mark.asyncio
async def test_a_larger_output_buffer_accepts_more_without_a_reader():
    output = ShellOutput(CAPACITY * 2)
    data = bytes(range(256)) * (CAPACITY // 256)
    await asyncio.wait_for(output.emit(Channel.STDOUT, data), 1)
    output.pipe.end()
    encoded = b"".join([chunk async for chunk in output.pipe.stream()])
    records = [json.loads(line) for line in encoded.splitlines()]
    assert all(set(record) == {"stream", "data"} for record in records)
    assert all(record["stream"] == "stdout" for record in records)
    assert (
        b"".join(base64.b64decode(record["data"]) for record in records)
        == data
    )
    await output.close()


@pytest.mark.asyncio
async def test_canceling_a_blocked_write_leaves_only_complete_wire_records():
    output = ShellOutput()
    writing = asyncio.create_task(output.emit(Channel.STDOUT, b"x" * 65536))
    await asyncio.sleep(0)
    assert not writing.done()
    writing.cancel()
    with pytest.raises(asyncio.CancelledError):
        await writing
    output.pipe.end()
    encoded = b"".join([chunk async for chunk in output.pipe.stream()])
    assert encoded.endswith(b"\n")
    records = [json.loads(line) for line in encoded.splitlines()]
    assert all(set(record) == {"stream", "data"} for record in records)
    assert all(record["stream"] == "stdout" for record in records)
    prefix = b"".join(base64.b64decode(record["data"]) for record in records)
    assert 0 < len(prefix) < 65536
    assert prefix == b"x" * len(prefix)
    await output.close()


@pytest.mark.asyncio
async def test_disconnect_joins_cleanup_when_the_record_store_is_unavailable():
    entered, cleanup, release, headers = (asyncio.Event() for _ in range(4))
    incoming = asyncio.Queue()

    class BrokenStore(RAMExecutionStore):
        offline = False

        async def get(self, execution_id):
            if self.offline:
                raise OSError("storage unavailable")
            return await super().get(execution_id)

    async def receive():
        return await incoming.get()

    async def send(message):
        if message["type"] == "http.response.start":
            headers.set()

    output = ShellOutput()

    async def run(scope):
        await scope.start()
        await output.emit(Channel.STDOUT, b"prefix")
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cleanup.set()
            await release.wait()

    store = BrokenStore()
    table = JobTable(store)
    job = await table.submit("workspace", "held", run, session_id="session")
    await entered.wait()
    scope = {"type": "http", "method": "POST", "path": "/", "headers": []}
    request = Request(scope, receive)
    response = ShellResponse(output, table, job, request, None, None)
    sending = asyncio.create_task(response(scope, receive, send))
    await headers.wait()
    store.offline = True
    await incoming.put({"type": "http.disconnect"})
    await asyncio.wait_for(cleanup.wait(), 1)
    assert not sending.done()
    release.set()
    with pytest.raises(OSError, match="storage unavailable"):
        await asyncio.wait_for(sending, 1)
    assert output.store.closed
    store.offline = False
    await table.close()
    await store.close()

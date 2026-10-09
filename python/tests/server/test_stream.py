import asyncio
import base64
import json

import pytest
from starlette.requests import Request

from mirage.io.pipe import CAPACITY
from mirage.server.jobs import JobStatus, JobTable
from mirage.server.stdin import UploadStdin
from mirage.server.stream import ShellOutput, ShellResponse


@pytest.mark.asyncio
async def test_a_larger_output_buffer_accepts_more_without_a_reader():
    output = ShellOutput(CAPACITY * 2)
    data = bytes(range(256)) * (CAPACITY // 256)
    await asyncio.wait_for(output.emit("stdout", data), 1)
    output.pipe.end()
    encoded = b"".join([chunk async for chunk in output.pipe.stream()])
    records = [json.loads(line) for line in encoded.splitlines()]
    assert all(set(record) == {"stream", "data"} for record in records)
    assert all(record["stream"] == "stdout" for record in records)
    assert (
        b"".join(base64.b64decode(record["data"]) for record in records)
        == data
    )


@pytest.mark.asyncio
async def test_canceling_a_blocked_write_leaves_only_complete_wire_records():
    output = ShellOutput()
    writing = asyncio.create_task(output.emit("stdout", b"x" * 65536))
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


@pytest.mark.asyncio
async def test_disconnect_cancels_the_job_and_joins_its_cleanup():
    entered, cleanup, release, headers = (asyncio.Event() for _ in range(4))
    incoming = asyncio.Queue()

    async def receive():
        return await incoming.get()

    async def send(message):
        if message["type"] == "http.response.start":
            headers.set()

    output = ShellOutput()

    async def run(scope):
        await scope.start()
        await output.emit("stdout", b"prefix")
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cleanup.set()
            await release.wait()

    table = JobTable()
    job = table.submit("workspace", "held", run, session_id="session")
    await entered.wait()
    scope = {"type": "http", "method": "POST", "path": "/", "headers": []}
    request = Request(scope, receive)
    response = ShellResponse(output, table, job, request, None, None)
    sending = asyncio.create_task(response(scope, receive, send))
    await headers.wait()
    await incoming.put({"type": "http.disconnect"})
    await asyncio.wait_for(cleanup.wait(), 1)
    assert not sending.done()
    release.set()
    await asyncio.wait_for(sending, 1)
    assert table.get(job.id).status == JobStatus.CANCELED
    await table.close()


@pytest.mark.asyncio
async def test_the_final_record_waits_for_the_upload_to_end():
    uploaded = asyncio.Event()
    incoming = asyncio.Queue()
    sent = []

    async def receive():
        return await incoming.get()

    async def send(message):
        sent.append(message)

    async def run(scope):
        await scope.start()
        return {"exit_code": 0}

    table = JobTable()
    job = table.submit("workspace", "true", run, session_id="session")
    await table.wait(job.id)
    upload = asyncio.create_task(uploaded.wait())
    scope = {"type": "http", "method": "POST", "path": "/", "headers": []}
    request = Request(scope, receive)
    response = ShellResponse(
        ShellOutput(), table, job, request, upload, UploadStdin()
    )
    sending = asyncio.create_task(response(scope, receive, send))
    for _ in range(50):
        await asyncio.sleep(0)
    assert all(message.get("more_body", True) for message in sent)
    uploaded.set()
    await asyncio.wait_for(sending, 1)
    assert sent[-1]["more_body"] is False
    assert json.loads(sent[-1]["body"])["status"] == "done"
    await table.close()

import asyncio
import base64
import json

import pytest
from starlette.requests import ClientDisconnect, Request

from mirage.execution.types import ExecutionStatus
from mirage.io import IOResult
from mirage.server.jobs import ExecutionTable
from mirage.server.stdin import UploadStdin
from mirage.server.stream import PAYLOAD_SIZE, ShellResponse, record
from mirage.shell.console import Channel
from mirage.workspace.shell_execution import ShellExecution


async def finished(scope):
    await scope.start()
    return {"exit_code": 0}


async def bad_body():
    raise ValueError("bad multipart body")


def none():
    """An execution future a job resolved without opening one."""
    future = asyncio.get_running_loop().create_future()
    future.set_result(None)
    return future


async def said(console, cancel, scope):
    await console.emit(Channel.STDOUT, b"out")
    await console.emit(Channel.STDERR, b"err")
    return IOResult()


def test_a_record_holds_at_most_a_payload_of_its_event():
    data = bytes(range(256)) * (PAYLOAD_SIZE // 128 + 1)
    records = [
        json.loads(line) for line in record("stdout", data).splitlines()
    ]
    assert len(records) == 3
    assert all(set(r) == {"stream", "data"} for r in records)
    assert all(r["stream"] == "stdout" for r in records)
    parts = [base64.b64decode(r["data"]) for r in records]
    assert all(len(part) <= PAYLOAD_SIZE for part in parts)
    assert b"".join(parts) == data


# The line's events go out as its records, as they come, then the final
# record with its status.
@pytest.mark.asyncio
async def test_the_response_sends_each_event_then_the_final_record():
    incoming = asyncio.Queue()
    sent = []
    loop = asyncio.get_running_loop()
    opened = loop.create_future()

    async def receive():
        return await incoming.get()

    async def send(message):
        sent.append(message)

    async def run(scope):
        await scope.start()
        execution = ShellExecution(said, scope)
        opened.set_result(execution)
        await execution.wait()
        return {"exit_code": 0}

    table = ExecutionTable()
    job = table.submit("workspace", "line", run, session_id="session")
    scope = {"type": "http", "method": "POST", "path": "/", "headers": []}
    response = ShellResponse(
        opened, loop, table, job, Request(scope, receive), None, None
    )
    await asyncio.wait_for(response(scope, receive, send), 1)
    bodies = b"".join(
        m["body"] for m in sent if m["type"] == "http.response.body"
    )
    lines = [json.loads(line) for line in bodies.splitlines()]
    assert [
        (line["stream"], base64.b64decode(line["data"])) for line in lines[:2]
    ] == [
        ("stdout", b"out"),
        ("stderr", b"err"),
    ]
    assert lines[2]["status"] == "done"
    await table.close()


async def failing(console, cancel, scope):
    await console.emit(Channel.STDOUT, b"partial")
    raise ValueError("boom")


# A line that fails while it streams keeps what it sent, and its final
# record says how it ended.
@pytest.mark.asyncio
async def test_a_line_that_fails_while_streaming_still_sends_the_final_record():
    incoming = asyncio.Queue()
    sent = []
    loop = asyncio.get_running_loop()
    opened = loop.create_future()

    async def receive():
        return await incoming.get()

    async def send(message):
        sent.append(message)

    async def run(scope):
        await scope.start()
        execution = ShellExecution(failing, scope)
        opened.set_result(execution)
        await execution.wait()
        return {"exit_code": 0}

    table = ExecutionTable()
    job = table.submit("workspace", "line", run, session_id="session")
    scope = {"type": "http", "method": "POST", "path": "/", "headers": []}
    response = ShellResponse(
        opened, loop, table, job, Request(scope, receive), None, None
    )
    await asyncio.wait_for(response(scope, receive, send), 1)
    bodies = b"".join(
        m["body"] for m in sent if m["type"] == "http.response.body"
    )
    lines = [json.loads(line) for line in bodies.splitlines()]
    assert base64.b64decode(lines[0]["data"]) == b"partial"
    assert lines[-1]["status"] == "failed"
    assert lines[-1]["error"] == "ValueError: boom"
    await table.close()


@pytest.mark.asyncio
async def test_disconnect_cancels_the_job_and_joins_its_cleanup():
    entered, cleanup, release, headers = (asyncio.Event() for _ in range(4))
    incoming = asyncio.Queue()
    loop = asyncio.get_running_loop()
    opened = loop.create_future()

    async def receive():
        return await incoming.get()

    async def send(message):
        if message["type"] == "http.response.start":
            headers.set()

    async def held(console, cancel, scope):
        await console.emit(Channel.STDOUT, b"prefix")
        entered.set()
        await cancel.wait()
        return IOResult()

    async def run(scope):
        await scope.start()
        execution = ShellExecution(held, scope)
        opened.set_result(execution)
        try:
            await execution.wait()
        except asyncio.CancelledError:
            execution.cancel()
            raise
        finally:
            cleanup.set()
            await release.wait()

    table = ExecutionTable()
    job = table.submit("workspace", "held", run, session_id="session")
    await entered.wait()
    scope = {"type": "http", "method": "POST", "path": "/", "headers": []}
    request = Request(scope, receive)
    response = ShellResponse(opened, loop, table, job, request, None, None)
    sending = asyncio.create_task(response(scope, receive, send))
    await headers.wait()
    await incoming.put({"type": "http.disconnect"})
    await asyncio.wait_for(cleanup.wait(), 1)
    assert not sending.done()
    release.set()
    await asyncio.wait_for(sending, 1)
    assert table.get(job.id).status == ExecutionStatus.CANCELED
    await table.close()


# A caller that hangs up before the job hands its line over still has
# that line closed once the handover arrives.
@pytest.mark.asyncio
async def test_a_disconnect_before_the_handover_still_closes_the_line():
    started, headers, finished = (asyncio.Event() for _ in range(3))
    incoming = asyncio.Queue()
    loop = asyncio.get_running_loop()
    opened = loop.create_future()

    async def receive():
        return await incoming.get()

    async def send(message):
        if message["type"] == "http.response.start":
            headers.set()

    async def held(console, cancel, scope):
        await cancel.wait()
        finished.set()
        return IOResult()

    def give(execution):
        if not opened.done():
            opened.set_result(execution)

    async def run(scope):
        await scope.start()
        execution = ShellExecution(held, scope)
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            loop.call_soon(give, execution)

    table = ExecutionTable()
    job = table.submit("workspace", "held", run, session_id="session")
    await started.wait()
    scope = {"type": "http", "method": "POST", "path": "/", "headers": []}
    response = ShellResponse(
        opened, loop, table, job, Request(scope, receive), None, None
    )
    sending = asyncio.create_task(response(scope, receive, send))
    await headers.wait()
    await incoming.put({"type": "http.disconnect"})
    await asyncio.wait_for(sending, 1)
    assert finished.is_set()
    await table.close()


@pytest.mark.asyncio
async def test_the_final_record_does_not_wait_for_stdin_to_end():
    uploaded = asyncio.Event()
    incoming = asyncio.Queue()
    sent = []

    async def receive():
        return await incoming.get()

    async def send(message):
        sent.append(message)

    table = ExecutionTable()
    job = table.submit("workspace", "true", finished, session_id="session")
    await table.wait(job.id)
    upload = asyncio.create_task(uploaded.wait())
    scope = {"type": "http", "method": "POST", "path": "/", "headers": []}
    request = Request(scope, receive)
    response = ShellResponse(
        none(),
        asyncio.get_running_loop(),
        table,
        job,
        request,
        upload,
        UploadStdin(),
    )
    sending = asyncio.create_task(response(scope, receive, send))
    for _ in range(50):
        await asyncio.sleep(0)
    bodies = [m for m in sent if m["type"] == "http.response.body"]
    assert json.loads(bodies[-1]["body"])["status"] == "done"
    assert all(message.get("more_body", True) for message in sent)
    uploaded.set()
    await asyncio.wait_for(sending, 1)
    assert sent[-1] == {
        "type": "http.response.body",
        "body": b"",
        "more_body": False,
    }
    await table.close()


@pytest.mark.asyncio
async def test_a_hang_up_after_the_final_record_ends_with_an_empty_body():
    hang_up, recorded = asyncio.Event(), asyncio.Event()
    incoming = asyncio.Queue()
    sent = []

    async def receive():
        return await incoming.get()

    async def send(message):
        sent.append(message)
        if message.get("body"):
            recorded.set()

    async def upload():
        await hang_up.wait()
        raise ClientDisconnect()

    table = ExecutionTable()
    job = table.submit("workspace", "true", finished, session_id="session")
    await table.wait(job.id)
    scope = {"type": "http", "method": "POST", "path": "/", "headers": []}
    response = ShellResponse(
        none(),
        asyncio.get_running_loop(),
        table,
        job,
        Request(scope, receive),
        asyncio.create_task(upload()),
        UploadStdin(),
    )
    sending = asyncio.create_task(response(scope, receive, send))
    await asyncio.wait_for(recorded.wait(), 1)
    assert all(message.get("more_body", True) for message in sent)
    await incoming.put({"type": "http.disconnect"})
    hang_up.set()
    await asyncio.wait_for(sending, 1)
    bodies = b"".join(
        m["body"] for m in sent if m["type"] == "http.response.body"
    )
    assert [json.loads(line)["status"] for line in bodies.splitlines()] == [
        "done"
    ]
    assert sent[-1] == {
        "type": "http.response.body",
        "body": b"",
        "more_body": False,
    }
    assert table.get(job.id).status == ExecutionStatus.DONE
    await table.close()


@pytest.mark.asyncio
async def test_an_upload_that_failed_first_fails_the_final_record():
    incoming = asyncio.Queue()
    sent = []

    async def receive():
        return await incoming.get()

    async def send(message):
        sent.append(message)

    table = ExecutionTable()
    job = table.submit("workspace", "true", finished, session_id="session")
    await table.wait(job.id)
    upload = asyncio.create_task(bad_body())
    await asyncio.gather(upload, return_exceptions=True)
    scope = {"type": "http", "method": "POST", "path": "/", "headers": []}
    response = ShellResponse(
        none(),
        asyncio.get_running_loop(),
        table,
        job,
        Request(scope, receive),
        upload,
        None,
    )
    await asyncio.wait_for(response(scope, receive, send), 1)
    bodies = [m["body"] for m in sent if m["type"] == "http.response.body"]
    terminal = json.loads(b"".join(bodies))
    assert terminal == {
        "status": "failed",
        "result": None,
        "error": "bad multipart body",
    }
    await table.close()


# A failed upload can cancel the job before its work starts, so the line
# is never opened; the final record still goes out.
@pytest.mark.asyncio
async def test_a_job_cancelled_before_it_starts_still_sends_the_final_record():
    incoming = asyncio.Queue()
    sent = []
    loop = asyncio.get_running_loop()

    async def receive():
        return await incoming.get()

    async def send(message):
        sent.append(message)

    table = ExecutionTable()
    job = table.submit("workspace", "true", finished, session_id="session")
    upload = asyncio.create_task(bad_body())
    scope = {"type": "http", "method": "POST", "path": "/", "headers": []}
    response = ShellResponse(
        loop.create_future(),
        loop,
        table,
        job,
        Request(scope, receive),
        upload,
        None,
    )
    await asyncio.wait_for(response(scope, receive, send), 1)
    bodies = [m["body"] for m in sent if m["type"] == "http.response.body"]
    terminal = json.loads(b"".join(bodies))
    assert terminal["status"] == "failed"
    assert terminal["error"] == "bad multipart body"
    assert (await table.wait(job.id)).status.value == "canceled"
    await table.close()


@pytest.mark.asyncio
async def test_an_upload_failing_while_its_cleanup_runs_fails_the_record():
    held = asyncio.Event()
    incoming = asyncio.Queue()
    sent = []

    async def receive():
        return await incoming.get()

    async def send(message):
        sent.append(message)

    async def discard():
        await held.wait()

    part = UploadStdin()
    part.discard = discard
    error = ValueError("stdin part too large")

    async def upload():
        await part.fail(error)
        raise error

    table = ExecutionTable()
    job = table.submit("workspace", "true", finished, session_id="session")
    await table.wait(job.id)
    uploading = asyncio.create_task(upload())
    await asyncio.sleep(0)
    assert not uploading.done()
    scope = {"type": "http", "method": "POST", "path": "/", "headers": []}
    response = ShellResponse(
        none(),
        asyncio.get_running_loop(),
        table,
        job,
        Request(scope, receive),
        uploading,
        part,
    )
    sending = asyncio.create_task(response(scope, receive, send))
    for _ in range(50):
        await asyncio.sleep(0)
    held.set()
    await asyncio.wait_for(sending, 1)
    bodies = b"".join(
        m["body"] for m in sent if m["type"] == "http.response.body"
    )
    assert json.loads(bodies) == {
        "status": "failed",
        "result": None,
        "error": "stdin part too large",
    }
    await table.close()


@pytest.mark.asyncio
async def test_the_final_record_survives_its_eviction(monkeypatch):
    monkeypatch.setattr("mirage.server.jobs.MAX_FINISHED_JOBS", 1)
    finish, headers = asyncio.Event(), asyncio.Event()
    incoming = asyncio.Queue()
    sent = []

    async def receive():
        return await incoming.get()

    async def send(message):
        sent.append(message)
        if message["type"] == "http.response.start":
            headers.set()

    async def run(scope):
        await scope.start()
        await finish.wait()
        return {"exit_code": 0}

    table = ExecutionTable()
    job = table.submit("workspace", "held", run, session_id="session")
    table.submit("workspace", "other", run, session_id="session")
    scope = {"type": "http", "method": "POST", "path": "/", "headers": []}
    response = ShellResponse(
        none(),
        asyncio.get_running_loop(),
        table,
        job,
        Request(scope, receive),
        None,
        None,
    )
    sending = asyncio.create_task(response(scope, receive, send))
    await headers.wait()
    finish.set()
    await asyncio.wait_for(sending, 1)
    with pytest.raises(KeyError):
        table.get(job.id)
    assert json.loads(sent[-2]["body"])["status"] == "done"
    assert sent[-1]["more_body"] is False
    await table.close()

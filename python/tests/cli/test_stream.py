import asyncio
import base64
import json
import os
from types import SimpleNamespace

import pytest
from aiohttp import web

from mirage.cli import stream
from mirage.cli.stream import _write, consume_stream

pytestmark = pytest.mark.asyncio


def record(**fields):
    return (json.dumps(fields) + "\n").encode()


async def test_split_records_preserve_binary_channels_and_exit_status():
    out = bytearray()
    err = bytearray()
    body = (
        record(stream="stdout", data=base64.b64encode(b"\x00\xffa").decode())
        + record(stream="stderr", data=base64.b64encode(b"oops\n").decode())
        + record(
            status="done", result={"kind": "io", "exit_code": 7}, error=None
        )
    )

    async def source():
        for byte in body:
            yield bytes([byte])

    async def stdout(data):
        out.extend(data)

    async def stderr(data):
        err.extend(data)

    terminal = await consume_stream(source(), stdout, stderr)
    assert terminal["result"]["exit_code"] == 7
    assert out == b"\x00\xffa"
    assert err == b"oops\n"


@pytest.mark.parametrize(
    "body",
    [
        b"",
        record(stream="stdout", data="YQ=="),
        record(status="done", result={}, error=None)[:-1],
        record(stream="stdout", data="???"),
        record(status="done", result={}, error=None)
        + record(stream="stdout", data="YQ=="),
        record(status="done", result={}, error=1),
        record(channel="stdout", data="YQ==")
        + record(status="done", result={}, error=None),
    ],
)
async def test_invalid_or_truncated_stream_is_not_a_success(body):
    writes = []

    async def source():
        yield body

    async def write(data):
        writes.append(data)

    with pytest.raises(ValueError):
        await consume_stream(source(), write, write)


async def test_output_backpressure_stops_reading_more_records():
    entered = asyncio.Event()
    release = asyncio.Event()
    pulled = []

    async def source():
        pulled.append("output")
        yield record(stream="stdout", data="YQ==")
        pulled.append("done")
        yield record(status="done", result={}, error=None)

    async def write(data):
        entered.set()
        await release.wait()

    task = asyncio.create_task(consume_stream(source(), write, write))
    await entered.wait()
    assert pulled == ["output"]
    assert not task.done()
    release.set()
    await task
    assert pulled == ["output", "done"]


async def test_cancel_blocked_output_restores_descriptor_flags():
    read, write = os.pipe()
    try:
        task = asyncio.create_task(_write(write, b"x" * (4 * 1024 * 1024)))
        await asyncio.sleep(0.01)
        assert not task.done()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert os.get_blocking(write)
    finally:
        os.close(read)
        os.close(write)


@pytest.mark.parametrize("early", [False, True])
async def test_http_output_arrives_before_stdin_eof(
    monkeypatch, tmp_path, early
):
    received = bytearray()

    async def handler(request):
        head = bytearray()
        while b'filename="stdin.bin"' not in head or not head.endswith(
            b"\r\n\r\n"
        ):
            head.extend(await request.content.readany())
        assert b'{"command": "cat"}' in head
        response = web.StreamResponse(
            headers={"Content-Type": "application/x-ndjson"}
        )
        await response.prepare(request)
        await response.write(record(stream="stdout", data="cmVhZHkK"))
        if early:
            response.force_close()
        else:
            received.extend(await request.read())
        await response.write(record(stream="stderr", data="AP8="))
        await response.write(
            record(
                status="done",
                result={"kind": "io", "exit_code": 7},
                error=None,
            )
        )
        await response.write_eof()
        return response

    app = web.Application()
    app.router.add_post("/shell", handler)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = runner.addresses[0][1]
    input_read, input_write = os.pipe()
    with (
        (tmp_path / "stdout").open("w+b") as stdout,
        (tmp_path / "stderr").open("w+b") as stderr,
    ):
        monkeypatch.setattr(
            stream,
            "sys",
            SimpleNamespace(
                stdin=SimpleNamespace(fileno=lambda: input_read),
                stdout=stdout,
                stderr=stderr,
            ),
        )
        client = SimpleNamespace(
            settings=SimpleNamespace(url=f"http://127.0.0.1:{port}"),
            token=lambda: "",
        )
        task = asyncio.create_task(
            stream.stream_shell(
                client, "/shell?stream=true", {"command": "cat"}, True
            )
        )
        try:
            async with asyncio.timeout(3):
                while stdout.tell() == 0:
                    await asyncio.sleep(0.01)
            if not early:
                assert not task.done()
                os.write(input_write, b"input\x00\xff")
                os.close(input_write)
                input_write = -1
            assert await asyncio.wait_for(task, 3) == 7
            stdout.seek(0)
            stderr.seek(0)
            assert stdout.read() == b"ready\n"
            assert stderr.read() == b"\x00\xff"
            assert (
                not received
                if early
                else received.startswith(b"input\x00\xff")
            )
            assert os.get_blocking(input_read)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            os.close(input_read)
            if input_write >= 0:
                os.close(input_write)
            await runner.cleanup()


async def test_json_collects_channels_and_preserves_metadata(
    monkeypatch, tmp_path
):
    async def handler(request):
        assert await request.json() == {"command": "test"}
        return web.Response(
            body=(
                record(
                    stream="stdout", data=base64.b64encode(b"\xe2").decode()
                )
                + record(
                    stream="stderr",
                    data=base64.b64encode(b"diagnostic").decode(),
                )
                + record(
                    stream="stdout",
                    data=base64.b64encode(b"\x82\xac\xff\0").decode(),
                )
                + record(
                    status="done",
                    result={
                        "kind": "io",
                        "exit_code": 7,
                        "refusal": {"reason": "test"},
                    },
                    error=None,
                )
            ),
            content_type="application/x-ndjson",
        )

    app = web.Application()
    app.router.add_post("/shell", handler)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", 0).start()
    port = runner.addresses[0][1]
    with (
        (tmp_path / "stdout").open("w+b") as stdout,
        (tmp_path / "stderr").open("w+b") as stderr,
    ):
        monkeypatch.setattr(
            stream, "sys", SimpleNamespace(stdout=stdout, stderr=stderr)
        )
        client = SimpleNamespace(
            settings=SimpleNamespace(url=f"http://127.0.0.1:{port}"),
            token=lambda: "",
        )
        try:
            assert (
                await stream.stream_shell(
                    client,
                    "/shell?stream=true",
                    {"command": "test"},
                    False,
                    json_output=True,
                )
                == 7
            )
            stdout.seek(0)
            stderr.seek(0)
            assert json.load(stdout) == {
                "kind": "io",
                "exit_code": 7,
                "refusal": {"reason": "test"},
                "stdout": "€�\0",
                "stderr": "diagnostic",
            }
            assert stderr.read() == b""
        finally:
            await runner.cleanup()


async def _refused_shell(request):
    return web.Response(
        body=(
            record(
                stream="stderr",
                data=base64.b64encode(b"rm: Permission denied\n").decode(),
            )
            + record(
                status="done",
                result={
                    "kind": "io",
                    "exit_code": 126,
                    "refusal": {
                        "kind": "deny",
                        "reason": "no deletes",
                        "policy": "Guard",
                        "scope": "command",
                        "ask_id": None,
                    },
                },
                error=None,
            )
        ),
        content_type="application/x-ndjson",
    )


async def test_raw_output_ends_with_the_refusal_line(monkeypatch, tmp_path):
    app = web.Application()
    app.router.add_post("/shell", _refused_shell)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", 0).start()
    port = runner.addresses[0][1]
    with (
        (tmp_path / "stdout").open("w+b") as stdout,
        (tmp_path / "stderr").open("w+b") as stderr,
    ):
        monkeypatch.setattr(
            stream, "sys", SimpleNamespace(stdout=stdout, stderr=stderr)
        )
        client = SimpleNamespace(
            settings=SimpleNamespace(url=f"http://127.0.0.1:{port}"),
            token=lambda: "",
        )
        try:
            assert (
                await stream.stream_shell(
                    client, "/shell?stream=true", {"command": "rm x"}, False
                )
                == 126
            )
            stderr.seek(0)
            assert stderr.read() == (
                b"rm: Permission denied\npolicy denied: no deletes\n"
            )
        finally:
            await runner.cleanup()

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


async def ignore(data):
    pass


async def test_split_records_preserve_binary_channels_and_exit_status():
    out = bytearray()
    err = bytearray()
    body = (
        record(stream="stdout", data=base64.b64encode(b"\x00\xffa").decode())
        + record(stream="stderr", data=base64.b64encode(b"oops\n").decode())
        + record(status="done", result={"exit_code": 7}, error=None)
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


async def test_many_records_in_one_chunk_arrive_in_order():
    lines = [b"%d\n" % i for i in range(1000)]
    out = bytearray()
    body = b"".join(
        record(stream="stdout", data=base64.b64encode(line).decode())
        for line in lines
    ) + record(status="done", result={"exit_code": 0}, error=None)

    async def source():
        yield body

    async def stdout(data):
        out.extend(data)

    await consume_stream(source(), stdout, ignore)
    assert out == b"".join(lines)


async def oversized():
    for _ in range(17):
        yield b"x" * (64 * 1024)


async def test_a_record_past_the_cap_is_refused_across_chunks():
    with pytest.raises(ValueError, match="too large"):
        await consume_stream(oversized(), ignore, ignore)


@pytest.mark.parametrize(
    "body",
    [
        b"",
        record(stream="stdout", data="YQ=="),
        record(status="done", result={}, error=None)[:-1],
        record(stream="stdout", data="???"),
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


async def test_the_completion_record_ends_the_read():
    pulled = []

    async def source():
        yield record(status="done", result={"exit_code": 0}, error=None)
        pulled.append("past the completion")
        await asyncio.Event().wait()

    terminal = await asyncio.wait_for(
        consume_stream(source(), ignore, ignore), 1
    )
    assert terminal["status"] == "done"
    assert pulled == []


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
                result={"exit_code": 7},
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
            headers=dict,
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


async def test_the_line_ending_ends_the_client_while_stdin_stays_open(
    monkeypatch, tmp_path
):
    hung_up = asyncio.Event()

    async def handler(request):
        response = web.StreamResponse(
            headers={"Content-Type": "application/x-ndjson"}
        )
        await response.prepare(request)
        await response.write(record(stream="stdout", data="aGkK"))
        await response.write(
            record(
                status="done",
                result={"exit_code": 3},
                error=None,
            )
        )
        with pytest.raises(ConnectionResetError):
            await request.read()
        hung_up.set()
        return response

    app = web.Application()
    app.router.add_post("/shell", handler)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = runner.addresses[0][1]
    input_read, input_write = os.pipe()
    try:
        with (tmp_path / "stdout").open("w+b") as stdout:
            monkeypatch.setattr(
                stream,
                "sys",
                SimpleNamespace(
                    stdin=SimpleNamespace(fileno=lambda: input_read),
                    stdout=stdout,
                    stderr=stdout,
                ),
            )
            client = SimpleNamespace(
                settings=SimpleNamespace(url=f"http://127.0.0.1:{port}"),
                headers=dict,
            )
            code = await asyncio.wait_for(
                stream.stream_shell(
                    client, "/shell?stream=true", {"command": "x"}, True
                ),
                3,
            )
            assert code == 3
            stdout.seek(0)
            assert stdout.read() == b"hi\n"
            await asyncio.wait_for(hung_up.wait(), 3)
            assert os.get_blocking(input_read)
    finally:
        os.close(input_read)
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
                        "exit_code": 7,
                        "decision": {"reason": "test"},
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
            headers=dict,
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
                "exit_code": 7,
                "decision": {"reason": "test"},
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
                    "exit_code": 126,
                    "decision": {
                        "kind": "deny",
                        "reason": "no deletes",
                        "policy": "Guard",
                        "ask_id": None,
                    },
                },
                error=None,
            )
        ),
        content_type="application/x-ndjson",
    )


async def test_raw_output_ends_with_the_decision_line(monkeypatch, tmp_path):
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
            headers=dict,
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


@pytest.mark.parametrize(
    ("status", "body", "content_type", "said"),
    [
        (
            404,
            '{"error": {"code": "not_found", "message": "session not found"}}',
            "application/json",
            "error 404: session not found",
        ),
        (
            502,
            "<html>bad gateway</html>",
            "text/html",
            "error 502: <html>bad gateway</html>",
        ),
        (500, '["odd"]', "application/json", 'error 500: ["odd"]'),
        (
            500,
            '{"error": ',
            "application/json",
            'error 500: {"error": ',
        ),
    ],
)
async def test_an_error_status_says_the_daemons_detail(
    monkeypatch, tmp_path, status, body, content_type, said
):
    async def handler(request):
        return web.Response(
            status=status, text=body, content_type=content_type
        )

    app = web.Application()
    app.router.add_post("/shell", handler)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = runner.addresses[0][1]
    try:
        with (tmp_path / "out").open("w+b") as out:
            monkeypatch.setattr(
                stream, "sys", SimpleNamespace(stdout=out, stderr=out)
            )
            client = SimpleNamespace(
                settings=SimpleNamespace(url=f"http://127.0.0.1:{port}"),
                headers=dict,
            )
            with pytest.raises(RuntimeError) as exc:
                await stream.stream_shell(
                    client, "/shell?stream=true", {"command": "x"}, False
                )
            assert str(exc.value) == said
    finally:
        await runner.cleanup()


def _proxy_env(monkeypatch, http_proxy, no_proxy=None):
    for name in ("http_proxy", "https_proxy", "all_proxy", "no_proxy"):
        monkeypatch.delenv(name, raising=False)
        monkeypatch.delenv(name.upper(), raising=False)
    monkeypatch.setenv("HTTP_PROXY", http_proxy)
    monkeypatch.setenv("HTTPS_PROXY", http_proxy)
    if no_proxy is not None:
        monkeypatch.setenv("NO_PROXY", no_proxy)


async def _serve(handler):
    app = web.Application()
    app.router.add_post("/shell", handler)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", 0).start()
    return runner, runner.addresses[0][1]


@pytest.mark.parametrize(
    ("credentials", "proxy_authorization"),
    [("u:p@", "Basic dTpw"), ("", None)],
)
async def test_the_line_goes_through_the_proxy_the_environment_names(
    monkeypatch, tmp_path, credentials, proxy_authorization
):
    seen = []

    async def proxy(request):
        seen.append(
            (str(request.url), request.headers.get("Proxy-Authorization"))
        )
        return await _refused_shell(request)

    runner, port = await _serve(proxy)
    _proxy_env(monkeypatch, f"http://{credentials}127.0.0.1:{port}")
    try:
        with (tmp_path / "out").open("w+b") as out:
            monkeypatch.setattr(
                stream, "sys", SimpleNamespace(stdout=out, stderr=out)
            )
            client = SimpleNamespace(
                settings=SimpleNamespace(url="http://daemon.invalid:7"),
                headers=lambda: {"Authorization": "Bearer t"},
            )
            assert (
                await stream.stream_shell(
                    client, "/shell?stream=true", {"command": "rm x"}, False
                )
                == 126
            )
        assert seen == [
            ("http://daemon.invalid:7/shell?stream=true", proxy_authorization)
        ]
    finally:
        await runner.cleanup()


async def test_no_proxy_sends_the_line_straight_to_the_daemon(
    monkeypatch, tmp_path
):
    runner, port = await _serve(_refused_shell)
    _proxy_env(
        monkeypatch, "http://127.0.0.1:9", no_proxy="localhost,127.0.0.1"
    )
    try:
        with (tmp_path / "out").open("w+b") as out:
            monkeypatch.setattr(
                stream, "sys", SimpleNamespace(stdout=out, stderr=out)
            )
            client = SimpleNamespace(
                settings=SimpleNamespace(url=f"http://127.0.0.1:{port}"),
                headers=dict,
            )
            assert (
                await stream.stream_shell(
                    client, "/shell?stream=true", {"command": "rm x"}, False
                )
                == 126
            )
    finally:
        await runner.cleanup()


async def test_the_proxy_tunnel_never_carries_the_daemon_token(
    monkeypatch, tmp_path
):
    seen = []

    async def connect(reader, writer):
        seen.append(await reader.readuntil(b"\r\n\r\n"))
        writer.close()

    server = await asyncio.start_server(connect, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    _proxy_env(monkeypatch, f"http://127.0.0.1:{port}")
    try:
        with (tmp_path / "out").open("w+b") as out:
            monkeypatch.setattr(
                stream, "sys", SimpleNamespace(stdout=out, stderr=out)
            )
            client = SimpleNamespace(
                settings=SimpleNamespace(url="https://daemon.invalid:7"),
                headers=lambda: {"Authorization": "Bearer t"},
            )
            with pytest.raises(RuntimeError):
                await stream.stream_shell(
                    client, "/shell?stream=true", {"command": "x"}, False
                )
        assert len(seen) == 1
        assert seen[0].startswith(b"CONNECT daemon.invalid:7 ")
        assert b"Bearer" not in seen[0]
    finally:
        server.close()
        await server.wait_closed()


@pytest.mark.parametrize(
    ("url", "http_proxy", "no_proxy", "proxy"),
    [
        ("http://d:8765", "proxy.corp:3128", None, "http://proxy.corp:3128"),
        (
            "http://d:8765",
            "HTTP://proxy.corp:3128",
            None,
            "http://proxy.corp:3128",
        ),
        ("http://d:8765", "socks5://proxy.corp:1080", None, None),
        ("http://127.0.0.1:8765", "http://p:1", "127.0.0.1:8765", None),
        (
            "http://127.0.0.1:8765",
            "http://p:1",
            "127.0.0.1:9999",
            "http://p:1",
        ),
        ("http://127.0.0.1:8765", "http://p:1", "127.0.0.1", None),
        ("http://[::1]:8765", "http://p:1", "::1", None),
    ],
)
def test_the_proxy_is_the_one_httpx_picks(
    monkeypatch, url, http_proxy, no_proxy, proxy
):
    _proxy_env(monkeypatch, http_proxy, no_proxy)
    assert stream.proxy_for(url) == (proxy, None)

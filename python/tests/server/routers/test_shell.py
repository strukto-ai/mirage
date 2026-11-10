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
import base64
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
import pytest
import uvicorn
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from mirage.execution.line.types import Line, LineState
from mirage.execution.types import LineId
from mirage.server import build_app


def _minimal_config() -> dict:
    return {
        "config": {
            "mounts": {"/": {"vfs": "ram", "mode": "WRITE"}},
        },
    }


def _lines(app: FastAPI, wid: str) -> list[Line]:
    return app.state.registry.get(wid).runner.ws.line_table.lines()


async def _ended(app: FastAPI, wid: str, line_id: LineId) -> Line:
    table = app.state.registry.get(wid).runner.ws.line_table
    for _ in range(100):
        line = table.get(line_id)
        if line is not None and line.ended_at is not None:
            return line
        await asyncio.sleep(0.05)
    raise AssertionError(f"line {line_id} never ended")


async def _create_workspace(client: AsyncClient) -> str:
    r = await client.post("/v1/workspaces", json=_minimal_config())
    assert r.status_code == 201
    return r.json()["id"]


@pytest.mark.asyncio
async def test_shell_sync_returns_io_result():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        r = await client.post(
            f"/v1/workspaces/{wid}/shell",
            json={"command": "echo hello"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["exit_code"] == 0
        assert body["stdout"].startswith("hello")


# A body that reads but fails the schema is a 400 naming its first bad
# field; a body that does not read is a 400 too.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("body", "error"),
    [
        (
            {"command": "echo hello", "provision": True},
            {
                "code": "unknown_field",
                "message": "provision is not a known field",
                "param": "provision",
            },
        ),
        (
            {},
            {
                "code": "missing_field",
                "message": "command is required",
                "param": "command",
            },
        ),
        (
            {"command": 5},
            {
                "code": "invalid_value",
                "message": "command must be a string",
                "param": "command",
            },
        ),
        (
            {"command": "echo hi", "record": 1},
            {
                "code": "invalid_value",
                "message": "record must be a boolean",
                "param": "record",
            },
        ),
        (
            {"provision": True, "command": 5},
            {
                "code": "invalid_value",
                "message": "command must be a string",
                "param": "command",
            },
        ),
    ],
)
@pytest.mark.parametrize("explain", [False, True])
async def test_shell_answers_a_bad_field_400(body, error, explain):
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        r = await client.post(
            f"/v1/workspaces/{wid}/shell",
            params={"explain": str(explain).lower()},
            json=body,
        )
        assert (r.status_code, r.json()) == (400, {"error": error})


@pytest.mark.asyncio
async def test_shell_answers_a_bad_request_part_400():
    async with _served() as client:
        wid = await _create_workspace(client)
        r = await client.post(
            f"/v1/workspaces/{wid}/shell",
            files={
                "request": (
                    None,
                    json.dumps({"command": "echo hi", "provision": True}),
                    "application/json",
                ),
            },
        )
        assert r.status_code == 400, r.text
        assert r.json()["error"]["param"] == "provision"


@pytest.mark.asyncio
async def test_shell_answers_an_unreadable_body_400():
    async with _served() as client:
        wid = await _create_workspace(client)
        route = f"/v1/workspaces/{wid}/shell"
        headers = {"content-type": "application/json"}
        r = await client.post(route, content=b'{"command":', headers=headers)
        assert r.status_code == 400, r.text
        for explain in ["false", "true"]:
            empty = await client.post(route, params={"explain": explain})
            assert empty.status_code == 400, empty.text
        part = await client.post(
            route,
            files={"request": (None, '{"command":', "application/json")},
        )
        assert part.status_code == 400, part.text


# A field's null is the field unset; an empty string is a value.
@pytest.mark.asyncio
async def test_shell_reads_null_as_unset():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        unset = dict.fromkeys(
            ["cwd", "runtime", "machine", "record", "open_stdin"]
        )
        route = f"/v1/workspaces/{wid}/shell"
        r = await client.post(route, json={"command": "echo hi", **unset})
        assert r.status_code == 200, r.text
        assert r.json()["stdout"] == "hi\n"
        explained = await client.post(
            route,
            params={"explain": "true"},
            json={"command": "echo hi", **unset},
        )
        assert explained.status_code == 200, explained.text


@pytest.mark.asyncio
@pytest.mark.parametrize("field", ["cwd", "runtime", "machine"])
async def test_explain_refuses_an_empty_string_as_set(field):
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        r = await client.post(
            f"/v1/workspaces/{wid}/shell",
            params={"explain": "true"},
            json={"command": "echo hi", field: ""},
        )
        assert r.status_code == 400, r.text


# Query parameters are checked before the workspace, the body after the
# workspace and the session.
@pytest.mark.asyncio
async def test_shell_checks_in_order():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        flags = await client.post(
            "/v1/workspaces/nope/shell?stream=abc&explain=xyz",
            json={"command": "echo hi"},
        )
        assert (flags.status_code, flags.json()) == (
            400,
            {
                "error": {
                    "code": "invalid_value",
                    "message": "explain must be a boolean",
                    "param": "explain",
                }
            },
        )
        for route in [
            "/v1/workspaces/nope/shell",
            "/v1/workspaces/nope/shell?stream=true&explain=true",
            f"/v1/workspaces/{wid}/shell?session_id=nope",
        ]:
            r = await client.post(route, json={"bogus": 1})
            assert r.status_code == 404, (route, r.text)


# A line on a workspace another daemon holds is refused, naming that
# daemon; once it gives the lease up, the line runs here.
@pytest.mark.asyncio
async def test_shell_refuses_a_workspace_another_daemon_holds():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        store = app.state.registry.get(wid).runner.ws.job_table.store
        assert await store.lease("elsewhere") is None
        r = await client.post(
            f"/v1/workspaces/{wid}/shell", json={"command": "echo hello"}
        )
        assert r.status_code == 409, r.text
        assert "'elsewhere'" in r.json()["error"]["message"]
        await store.release("elsewhere")
        r = await client.post(
            f"/v1/workspaces/{wid}/shell", json={"command": "echo hello"}
        )
        assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_shell_honors_cwd():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        r = await client.post(
            f"/v1/workspaces/{wid}/shell",
            json={"command": "mkdir -p /sub && echo -n nested > /sub/f.txt"},
        )
        assert r.status_code == 200, r.text
        r = await client.post(
            f"/v1/workspaces/{wid}/shell",
            json={"command": "cat f.txt", "cwd": "/sub"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["exit_code"] == 0
        assert body["stdout"] == "nested"


@pytest.mark.asyncio
async def test_shell_refuses_a_runtime_or_machine_the_workspace_lacks():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        route = f"/v1/workspaces/{wid}/shell"
        runtime = await client.post(
            route, json={"command": "echo hi", "runtime": "no-such-runtime"}
        )
        assert (runtime.status_code, runtime.json()) == (
            400,
            {
                "error": {
                    "code": "invalid_value",
                    "message": "runtime must be one of monty",
                    "param": "runtime",
                }
            },
        )
        machine = await client.post(
            route, json={"command": "echo hi", "machine": ""}
        )
        assert (machine.status_code, machine.json()) == (
            400,
            {
                "error": {
                    "code": "invalid_value",
                    "message": "machine must be unset: the workspace has "
                    "no machines",
                    "param": "machine",
                }
            },
        )


@pytest.mark.asyncio
async def test_shell_record_false_leaves_no_history_entry():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        r = await client.post(
            f"/v1/workspaces/{wid}/shell",
            json={"command": "echo recorded"},
        )
        assert r.status_code == 200, r.text
        r = await client.post(
            f"/v1/workspaces/{wid}/shell",
            json={"command": "echo hidden", "record": False},
        )
        assert r.status_code == 200, r.text
        r = await client.post(
            f"/v1/workspaces/{wid}/shell",
            json={"command": "history"},
        )
        assert r.status_code == 200, r.text
        out = r.json()["stdout"]
        assert "echo recorded" in out
        assert "echo hidden" not in out


@pytest.mark.asyncio
async def test_shell_sync_records_a_job_in_done_state():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        r = await client.post(
            f"/v1/workspaces/{wid}/shell",
            json={"command": "echo done-marker"},
        )
        assert r.status_code == 200, r.text
        assert r.json()["stdout"].startswith("done-marker")
        [line] = _lines(app, wid)
        assert (line.command, line.state) == (
            "echo done-marker",
            LineState.EXITED,
        )
        assert (line.exit, line.signal, line.error) == (0, None, None)


@pytest.mark.asyncio
async def test_shell_with_stdin_multipart():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        r = await client.post(
            f"/v1/workspaces/{wid}/shell",
            data={"request": json.dumps({"command": "wc -l"})},
            files={
                "stdin": (
                    "stdin.bin",
                    b"a\nb\nc\n",
                    "application/octet-stream",
                ),
            },
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["exit_code"] == 0
        assert body["stdout"].strip().startswith("3")


@pytest.mark.asyncio
@pytest.mark.parametrize("vfs", ["ram", "disk"])
async def test_large_multipart_stdin_roundtrip(tmp_path, vfs):
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        mount = {"vfs": vfs, "mode": "WRITE"}
        if vfs == "disk":
            mount["config"] = {"root": str(tmp_path)}
        created = await client.post(
            "/v1/workspaces", json={"config": {"mounts": {"/work": mount}}}
        )
        assert created.status_code == 201, created.text
        wid = created.json()["id"]
        try:
            for stdin in [("α\0\r\n" * 240_000).encode(), b""]:
                payload = json.dumps(
                    {
                        "command": "cat > input.bin",
                        "cwd": "/work",
                        "record": False,
                    }
                )
                result = await client.post(
                    f"/v1/workspaces/{wid}/shell",
                    files={
                        "request": (
                            "request.json",
                            payload,
                            "application/json",
                        ),
                        "stdin": (
                            "stdin.bin",
                            stdin,
                            "application/octet-stream",
                        ),
                    },
                )
                assert result.status_code == 200, result.text
                assert result.json()["exit_code"] == 0, result.text
                read = await client.post(
                    f"/v1/workspaces/{wid}/shell",
                    json={"command": "base64 /work/input.bin"},
                )
                assert read.status_code == 200, read.text
                assert read.json()["exit_code"] == 0
                assert base64.b64decode(read.json()["stdout"]) == stdin
        finally:
            await client.delete(f"/v1/workspaces/{wid}")


@pytest.mark.asyncio
async def test_unknown_workspace_404():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        r = await client.post(
            "/v1/workspaces/ws_doesnotexist/shell",
            json={"command": "echo hi"},
        )
        assert r.status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize("stream", [False, True])
async def test_unknown_session_404(stream):
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        r = await client.post(
            f"/v1/workspaces/{wid}/shell",
            params={"session_id": "nope", "stream": str(stream).lower()},
            json={"command": "echo hi"},
        )
        assert r.status_code == 404
        assert r.json()["error"]["message"] == "session not found"


@pytest.mark.asyncio
async def test_a_caller_that_drops_cancels_its_foreground_job(tmp_path):
    app = build_app(idle_grace_seconds=10.0, pid_file=tmp_path / "daemon.pid")
    server = uvicorn.Server(
        uvicorn.Config(
            app, host="127.0.0.1", port=0, log_level="warning", ws="none"
        )
    )
    task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.01)
    port = server.servers[0].sockets[0].getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    try:
        async with AsyncClient(base_url=base) as client:
            wid = await _create_workspace(client)
            with pytest.raises(httpx.TimeoutException):
                await client.post(
                    f"/v1/workspaces/{wid}/shell",
                    json={"command": "sleep 20"},
                    timeout=0.5,
                )
            [line] = _lines(app, wid)
            line = await _ended(app, wid, line.id)
        assert line.signal == 2
    finally:
        server.should_exit = True
        await task


BOUNDARY = "mirage-test-boundary"


def _part(name: str, filename: str | None = None) -> bytes:
    disposition = f'form-data; name="{name}"'
    if filename is not None:
        disposition += f'; filename="{filename}"'
    return (
        f"--{BOUNDARY}\r\nContent-Disposition: {disposition}\r\n\r\n".encode()
    )


def _request_part(command: str) -> bytes:
    return (
        _part("request") + json.dumps({"command": command}).encode() + b"\r\n"
    )


END = f"\r\n--{BOUNDARY}--\r\n".encode()
MULTIPART = {"content-type": f"multipart/form-data; boundary={BOUNDARY}"}


class _StdinStatuses:
    """Records the status each stdin route answers, a caller already
    gone included.

    Args:
        app (ASGIApp): the app it wraps.
        seen (list[int]): where the statuses go, in order.
    """

    def __init__(self, app: ASGIApp, seen: list[int]) -> None:
        self.app = app
        self.seen = seen

    async def __call__(
        self, scope: Scope, receive: Receive, send: Send
    ) -> None:
        async def spy(message: Message) -> None:
            if message["type"] == "http.response.start" and scope[
                "path"
            ].endswith("/stdin"):
                self.seen.append(message["status"])
            await send(message)

        await self.app(scope, receive, spy)


@asynccontextmanager
async def _served(app: FastAPI | None = None) -> AsyncIterator[AsyncClient]:
    server = uvicorn.Server(
        uvicorn.Config(
            app or build_app(idle_grace_seconds=10.0),
            host="127.0.0.1",
            port=0,
            log_level="warning",
            ws="none",
        )
    )
    task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.01)
    port = server.servers[0].sockets[0].getsockname()[1]
    try:
        async with AsyncClient(
            base_url=f"http://127.0.0.1:{port}", timeout=10
        ) as client:
            yield client
    finally:
        server.should_exit = True
        await task


@pytest.mark.asyncio
async def test_stdin_streams_into_a_running_line():
    app = build_app(idle_grace_seconds=10.0)
    async with _served(app) as client:
        wid = await _create_workspace(client)
        running = asyncio.Event()

        async def body() -> AsyncIterator[bytes]:
            yield _request_part("cat > /out.txt") + _part("stdin", "stdin.bin")
            yield b"first\n"
            await asyncio.wait_for(running.wait(), 5)
            yield b"second\n" + END

        async def watch() -> None:
            while True:
                if any(
                    line.state == LineState.RUNNING
                    for line in _lines(app, wid)
                ):
                    running.set()
                    return
                await asyncio.sleep(0.02)

        watcher = asyncio.create_task(watch())
        r = await client.post(
            f"/v1/workspaces/{wid}/shell", content=body(), headers=MULTIPART
        )
        await watcher
        assert r.status_code == 200, r.text
        read = await client.post(
            f"/v1/workspaces/{wid}/shell", json={"command": "cat /out.txt"}
        )
        assert read.json()["stdout"] == "first\nsecond\n"


@pytest.mark.asyncio
async def test_a_line_that_stops_reading_still_answers():
    async with _served() as client:
        wid = await _create_workspace(client)

        async def body() -> AsyncIterator[bytes]:
            yield _request_part("head -c 3") + _part("stdin", "stdin.bin")
            for _ in range(64):
                yield b"abcdefgh" * 8192
            yield END

        r = await client.post(
            f"/v1/workspaces/{wid}/shell", content=body(), headers=MULTIPART
        )
        assert r.status_code == 200, r.text
        assert r.json()["stdout"] == "abc"


@pytest.mark.asyncio
async def test_a_line_starts_before_its_stdin_sends_a_byte():
    app = build_app(idle_grace_seconds=10.0)
    async with _served(app) as client:
        wid = await _create_workspace(client)
        running = asyncio.Event()

        async def body() -> AsyncIterator[bytes]:
            yield _request_part("cat > /out.txt") + _part("stdin", "stdin.bin")
            await asyncio.wait_for(running.wait(), 5)
            yield b"late\n" + END

        async def watch() -> None:
            while True:
                if any(
                    line.state == LineState.RUNNING
                    for line in _lines(app, wid)
                ):
                    running.set()
                    return
                await asyncio.sleep(0.02)

        watcher = asyncio.create_task(watch())
        r = await client.post(
            f"/v1/workspaces/{wid}/shell", content=body(), headers=MULTIPART
        )
        await watcher
        assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_a_body_that_stops_before_its_last_boundary_is_refused():
    async with _served() as client:
        wid = await _create_workspace(client)
        r = await asyncio.wait_for(
            client.post(
                f"/v1/workspaces/{wid}/shell",
                content=_request_part("cat")
                + _part("stdin", "stdin.bin")
                + b"abc",
                headers=MULTIPART,
            ),
            10,
        )
        assert r.status_code == 400, r.text
        assert r.json()["error"]["message"] == "multipart body ended early"


@pytest.mark.asyncio
async def test_stdin_reads_whole_however_the_body_is_split():
    async with _served() as client:
        wid = await _create_workspace(client)
        stdin = f"a\r\n--{BOUNDARY[:5]}\r\r\n-\r\n--{BOUNDARY[:-1]}\r".encode()
        whole = (
            _request_part("cat") + _part("stdin", "stdin.bin") + stdin + END
        )

        async def body() -> AsyncIterator[bytes]:
            for i in range(0, len(whole), 3):
                yield whole[i : i + 3]

        r = await client.post(
            f"/v1/workspaces/{wid}/shell", content=body(), headers=MULTIPART
        )
        assert r.status_code == 200, r.text
        assert r.json()["stdout"] == stdin.decode()


@pytest.mark.asyncio
async def test_part_headers_past_the_bound_are_refused():
    app = build_app(idle_grace_seconds=10.0)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        body = (
            f"--{BOUNDARY}\r\nX-Pad: {'x' * 20000}\r\n".encode()
            + _request_part("true")[len(f"--{BOUNDARY}\r\n") :]
            + END[2:]
        )
        r = await client.post(
            f"/v1/workspaces/{wid}/shell", content=body, headers=MULTIPART
        )
        assert r.status_code == 400, r.text
        assert r.json()["error"]["message"] == "multipart body is malformed"


@pytest.mark.asyncio
async def test_stdin_before_the_request_part_is_refused():
    app = build_app(idle_grace_seconds=10.0)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        body = (
            _part("stdin", "stdin.bin")
            + b"abc\r\n"
            + _request_part("cat")
            + END[2:]
        )
        r = await client.post(
            f"/v1/workspaces/{wid}/shell", content=body, headers=MULTIPART
        )
        assert r.status_code == 400, r.text
        assert "before 'stdin'" in r.json()["error"]["message"]


@pytest.mark.asyncio
async def test_shell_inherits_io_config_from_http_workspace_creation():
    app = build_app(idle_grace_seconds=10.0)
    async with app.router.lifespan_context(app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            config = _minimal_config()
            config["config"]["io"] = {"buffer_bytes": 131072}
            created = await client.post("/v1/workspaces", json=config)
            assert created.status_code == 201, created.text
            wid = created.json()["id"]
            assert (
                app.state.registry.get(wid).runner.ws.io.buffer_bytes == 131072
            )
            data = bytes(range(256)) * 1025
            response = await client.post(
                f"/v1/workspaces/{wid}/shell?stream=true",
                files={
                    "request": (
                        None,
                        json.dumps({"command": "cat; printf err >&2"}),
                    ),
                    "stdin": ("stdin.bin", data),
                },
            )
            assert response.status_code == 200, response.text
            events = [json.loads(line) for line in response.text.splitlines()]
            assert (
                b"".join(
                    base64.b64decode(event["data"])
                    for event in events
                    if event.get("stream") == "stdout"
                )
                == data
            )
            assert (
                b"".join(
                    base64.b64decode(event["data"])
                    for event in events
                    if event.get("stream") == "stderr"
                )
                == b"err"
            )
            assert events[-1]["status"] == "done"
            assert events[-1]["result"]["exit_code"] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "padding", ["", "x" * (128 * 1024 + 1)], ids=["small", "large"]
)
async def test_shell_stream_preserves_bytes_channels_and_final_status(padding):
    app = build_app(idle_grace_seconds=10.0)
    async with app.router.lifespan_context(app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            wid = await _create_workspace(client)
            response = await client.post(
                f"/v1/workspaces/{wid}/shell?stream=true",
                json={
                    "command": f"printf '\\377\\000x{padding}'; printf err >&2; false"
                },
            )
            assert response.status_code == 200
            assert response.headers["content-type"] == "application/x-ndjson"
            events = [json.loads(line) for line in response.text.splitlines()]
            stdout = b"".join(
                base64.b64decode(e["data"])
                for e in events
                if e.get("stream") == "stdout"
            )
            stderr = b"".join(
                base64.b64decode(e["data"])
                for e in events
                if e.get("stream") == "stderr"
            )
            assert stdout == b"\xff\x00x" + padding.encode()
            assert stderr == b"err"
            assert all(
                len(base64.b64decode(event["data"])) <= 8 * 1024
                for event in events
                if "stream" in event
            )
            assert events[-1]["status"] == "done"
            assert events[-1]["result"]["exit_code"] == 1
            assert events[-1]["result"]["stdout"] == ""
            assert events[-1]["result"]["stderr"] == ""
            last = _lines(app, wid)[-1]
            assert (last.exit, last.signal) == (1, None)


@pytest.mark.asyncio
@pytest.mark.parametrize("other", ["explain"])
async def test_shell_stream_refuses_incompatible_mode(other):
    app = build_app(idle_grace_seconds=10.0)
    async with app.router.lifespan_context(app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            wid = await _create_workspace(client)
            response = await client.post(
                f"/v1/workspaces/{wid}/shell?stream=true&{other}=true",
                json={"command": "echo no"},
            )
            assert response.status_code == 400
            assert app.state.jobs.requests() == []


@pytest.mark.asyncio
async def test_shell_stream_sends_prefix_before_completion_and_cancels_on_disconnect():
    app = build_app(idle_grace_seconds=10.0)
    async with _served(app) as client:
        wid = await _create_workspace(client)
        async with client.stream(
            "POST",
            f"/v1/workspaces/{wid}/shell?stream=true",
            json={"command": "echo ready; sleep 30"},
        ) as response:
            lines = response.aiter_lines()
            first = json.loads(await asyncio.wait_for(anext(lines), 3))
            assert base64.b64decode(first["data"]) == b"ready\n"
            [line] = _lines(app, wid)
            assert line.state == LineState.RUNNING
        line = await _ended(app, wid, line.id)
        assert line.signal == 2


@pytest.mark.asyncio
async def test_a_server_shutting_down_refuses_a_new_line():
    app = build_app(idle_grace_seconds=10.0)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        app.state.registry.draining = True
        r = await client.post(
            f"/v1/workspaces/{wid}/shell", json={"command": "echo late"}
        )
    assert r.status_code == 503
    assert r.json()["error"]["message"] == "server is shutting down"
    await app.state.registry.close_all()


async def _record(lines: AsyncIterator[str]) -> dict:
    return json.loads(await asyncio.wait_for(anext(lines), 5))


def _open_stdin(client: AsyncClient, wid: str, command: str):
    return client.stream(
        "POST",
        f"/v1/workspaces/{wid}/shell?stream=true",
        json={"command": command, "open_stdin": True},
    )


@pytest.mark.asyncio
async def test_open_stdin_takes_writes_while_the_line_runs():
    async with _served() as client:
        wid = await _create_workspace(client)
        async with _open_stdin(client, wid, "cat") as reply:
            lines = reply.aiter_lines()
            line_id = (await _record(lines))["line_id"]
            route = f"/v1/workspaces/{wid}/lines/{line_id}/stdin"
            for word in ("one\n", "two\n"):
                written = await client.post(route, content=word.encode())
                assert written.status_code == 204, written.text
                echoed = await _record(lines)
                assert base64.b64decode(echoed["data"]).decode() == word
            assert (await client.delete(route)).status_code == 204
            last = await _record(lines)
            assert last["status"] == "done"
            assert last["result"]["exit_code"] == 0
            assert last["result"]["line_id"] == line_id
        assert (await client.post(route, content=b"x")).status_code == 404


@pytest.mark.asyncio
async def test_a_closed_stdin_refuses_a_write():
    async with _served() as client:
        wid = await _create_workspace(client)
        async with _open_stdin(client, wid, "cat; sleep 5") as reply:
            lines = reply.aiter_lines()
            line_id = (await _record(lines))["line_id"]
            route = f"/v1/workspaces/{wid}/lines/{line_id}/stdin"
            assert (await client.delete(route)).status_code == 204
            assert (await client.delete(route)).status_code == 204
            refused = await client.post(route, content=b"late")
            assert (refused.status_code, refused.json()) == (
                409,
                {
                    "error": {
                        "code": "conflict",
                        "message": "the line's stdin is not open",
                    }
                },
            )


@pytest.mark.asyncio
async def test_a_write_past_the_buffer_waits_until_the_line_ends():
    async with _served() as client:
        wid = await _create_workspace(client)
        async with _open_stdin(client, wid, "sleep 1") as reply:
            lines = reply.aiter_lines()
            line_id = (await _record(lines))["line_id"]
            written = await client.post(
                f"/v1/workspaces/{wid}/lines/{line_id}/stdin",
                content=b"x" * (1024 * 1024),
            )
            assert written.status_code == 409, written.text
            assert (await _record(lines))["status"] == "done"


@pytest.mark.asyncio
async def test_deleting_a_workspace_answers_a_held_write():
    app = build_app(idle_grace_seconds=10.0)
    async with _served(app) as client:
        wid = await _create_workspace(client)
        capacity = app.state.registry.get(wid).runner.ws.io.buffer_bytes
        async with _open_stdin(client, wid, "sleep 30") as reply:
            lines = reply.aiter_lines()
            line_id = (await _record(lines))["line_id"]
            route = f"/v1/workspaces/{wid}/lines/{line_id}/stdin"
            filled = await client.post(route, content=b"x" * capacity)
            assert filled.status_code == 204, filled.text
            held = asyncio.create_task(client.post(route, content=b"y"))
            await asyncio.sleep(0.2)
            assert not held.done()
            assert (await client.delete(f"/v1/workspaces/{wid}")).is_success
            answer = await asyncio.wait_for(held, 5)
            assert answer.status_code == 409, answer.text


@pytest.mark.asyncio
async def test_open_stdin_needs_a_stream_and_no_stdin_part():
    async with _served() as client:
        wid = await _create_workspace(client)
        route = f"/v1/workspaces/{wid}/shell"
        body = {"command": "cat", "open_stdin": True}
        assert (await client.post(route, json=body)).status_code == 400
        explained = await client.post(f"{route}?explain=true", json=body)
        assert explained.status_code == 400
        both = await client.post(
            f"{route}?stream=true",
            files={
                "request": (None, json.dumps(body), "application/json"),
                "stdin": ("stdin.bin", b"x"),
            },
        )
        assert both.status_code == 400


@pytest.mark.asyncio
async def test_stdin_routes_name_a_running_line_with_open_stdin():
    async with _served() as client:
        wid = await _create_workspace(client)
        other = await _create_workspace(client)
        unknown = f"/v1/workspaces/{wid}/lines/nope/stdin"
        assert (await client.post(unknown, content=b"x")).status_code == 404
        assert (await client.delete(unknown)).status_code == 404
        async with client.stream(
            "POST",
            f"/v1/workspaces/{wid}/shell?stream=true",
            json={"command": "sleep 5"},
        ):
            listed: list[dict] = []
            while not listed:
                listed = (
                    await client.get(
                        f"/v1/workspaces/{wid}/lines",
                        params={"state": "running"},
                    )
                ).json()
            line_id = listed[0]["id"]
            route = f"/v1/workspaces/{wid}/lines/{line_id}/stdin"
            assert (await client.post(route, content=b"x")).status_code == 409
            elsewhere = f"/v1/workspaces/{other}/lines/{line_id}/stdin"
            assert (await client.delete(elsewhere)).status_code == 404


@pytest.mark.asyncio
async def test_a_caller_that_hangs_up_drops_its_held_write():
    app = build_app(idle_grace_seconds=10.0)
    statuses: list[int] = []
    app.add_middleware(_StdinStatuses, seen=statuses)
    async with _served(app) as client:
        wid = await _create_workspace(client)
        capacity = app.state.registry.get(wid).runner.ws.io.buffer_bytes
        async with _open_stdin(client, wid, "sleep 2; cat") as reply:
            lines = reply.aiter_lines()
            line_id = (await _record(lines))["line_id"]
            route = f"/v1/workspaces/{wid}/lines/{line_id}/stdin"
            filled = await client.post(route, content=b"x" * capacity)
            assert filled.status_code == 204, filled.text
            _, writer = await asyncio.open_connection(
                "127.0.0.1", client.base_url.port
            )
            late = (
                f"POST {route} HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                "Content-Type: application/octet-stream\r\n"
                "Content-Length: 4\r\n\r\nlate"
            )
            writer.write(late.encode())
            await writer.drain()
            await asyncio.sleep(0.2)
            writer.close()
            await writer.wait_closed()
            seen = b""
            while len(seen) < capacity:
                record = await _record(lines)
                seen += base64.b64decode(record["data"])
            await asyncio.sleep(0.2)
            assert (await client.delete(route)).status_code == 204
            record = await _record(lines)
            while "status" not in record:
                seen += base64.b64decode(record["data"])
                record = await _record(lines)
            assert seen == b"x" * capacity
            assert statuses == [204, 499, 204]

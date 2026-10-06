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
from httpx import ASGITransport, AsyncClient

from mirage.server import build_app


def _minimal_config() -> dict:
    return {
        "config": {
            "mounts": {"/": {"vfs": "ram", "mode": "WRITE"}},
        },
    }


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
        assert body["kind"] == "io"
        assert body["exit_code"] == 0
        assert body["stdout"].startswith("hello")
        assert "X-Mirage-Job-Id" in r.headers


@pytest.mark.asyncio
async def test_shell_refuses_an_unknown_field():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        r = await client.post(
            f"/v1/workspaces/{wid}/shell",
            json={"command": "echo hello", "provision": True},
        )
        assert r.status_code == 400, r.text
        assert "provision" in r.json()["detail"]


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
async def test_shell_passes_runtime_through():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        # An unknown entry name fails loud inside Workspace.shell,
        # proving the field reaches the runtime argument.
        r = await client.post(
            f"/v1/workspaces/{wid}/shell",
            json={"command": "echo hi", "runtime": "no-such-runtime"},
        )
        assert r.status_code == 500, r.text
        assert "unknown runtime" in r.json()["detail"]


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
        job_id = r.headers["X-Mirage-Job-Id"]

        rj = await client.get(f"/v1/jobs/{job_id}")
        assert rj.status_code == 200
        body = rj.json()
        assert body["status"] == "done"
        assert body["result"]["stdout"].startswith("done-marker")


@pytest.mark.asyncio
async def test_shell_background_returns_job_id_immediately():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        r = await client.post(
            f"/v1/workspaces/{wid}/shell?background=true",
            json={"command": "sleep 0.3 && echo bg-done"},
        )
        assert r.status_code == 202, r.text
        body = r.json()
        assert body["job_id"].startswith("job_")
        assert body["workspace_id"] == wid
        assert r.headers["X-Mirage-Job-Id"] == body["job_id"]


@pytest.mark.asyncio
async def test_background_job_completes_and_result_is_readable():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        r = await client.post(
            f"/v1/workspaces/{wid}/shell?background=true",
            json={"command": "echo finished"},
        )
        job_id = r.json()["job_id"]
        rw = await client.post(f"/v1/jobs/{job_id}/wait", json={})
        body = rw.json()
        assert body["status"] == "done"
        assert body["result"]["stdout"].startswith("finished")


@pytest.mark.asyncio
async def test_wait_with_timeout_returns_running_status():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        r = await client.post(
            f"/v1/workspaces/{wid}/shell?background=true",
            json={"command": "sleep 1.0"},
        )
        job_id = r.json()["job_id"]
        rw = await client.post(
            f"/v1/jobs/{job_id}/wait", json={"timeout_s": 0.1}
        )
        assert rw.status_code == 200
        assert rw.json()["status"] == "running"


@pytest.mark.asyncio
async def test_cancel_running_job():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        r = await client.post(
            f"/v1/workspaces/{wid}/shell?background=true",
            json={"command": "sleep 5.0"},
        )
        job_id = r.json()["job_id"]
        await asyncio.sleep(0.05)

        rd = await client.delete(f"/v1/jobs/{job_id}")
        assert rd.status_code == 200
        await asyncio.sleep(0.1)

        rg = await client.get(f"/v1/jobs/{job_id}")
        status = rg.json()["status"]
        assert status in ("canceled", "failed")


@pytest.mark.asyncio
async def test_list_jobs_filtered_by_workspace():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        wid_a = await _create_workspace(client)
        wid_b = await _create_workspace(client)
        await client.post(
            f"/v1/workspaces/{wid_a}/shell",
            json={"command": "echo a"},
        )
        await client.post(
            f"/v1/workspaces/{wid_b}/shell",
            json={"command": "echo b"},
        )
        r = await client.get("/v1/jobs")
        assert len(r.json()) == 2

        r = await client.get(f"/v1/jobs?workspace_id={wid_a}")
        jobs = r.json()
        assert len(jobs) == 1
        assert jobs[0]["workspace_id"] == wid_a


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
@pytest.mark.parametrize("background", [False, True])
@pytest.mark.parametrize("vfs", ["ram", "disk"])
async def test_large_multipart_stdin_roundtrip(tmp_path, vfs, background):
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
                    params={"background": str(background).lower()},
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
                assert result.status_code == (202 if background else 200), (
                    result.text
                )
                if background:
                    job = result.json()["job_id"]
                    waited = await client.post(f"/v1/jobs/{job}/wait", json={})
                    assert waited.json()["status"] == "done", waited.text
                else:
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
async def test_unknown_job_404():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        r = await client.get("/v1/jobs/job_doesnotexist")
        assert r.status_code == 404


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
            status = ""
            for _ in range(100):
                jobs = (
                    await client.get("/v1/jobs", params={"workspace_id": wid})
                ).json()
                status = jobs[0]["status"]
                if status == "canceled":
                    break
                await asyncio.sleep(0.05)
        assert status == "canceled"
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


@asynccontextmanager
async def _served() -> AsyncIterator[AsyncClient]:
    server = uvicorn.Server(
        uvicorn.Config(
            build_app(idle_grace_seconds=10.0),
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
    async with _served() as client:
        wid = await _create_workspace(client)
        running = asyncio.Event()

        async def body() -> AsyncIterator[bytes]:
            yield _request_part("cat > /out.txt") + _part("stdin", "stdin.bin")
            yield b"first\n"
            await asyncio.wait_for(running.wait(), 5)
            yield b"second\n" + END

        async def watch() -> None:
            while True:
                jobs = (
                    await client.get("/v1/jobs", params={"workspace_id": wid})
                ).json()
                if any(j["status"] == "running" for j in jobs):
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
    async with _served() as client:
        wid = await _create_workspace(client)
        running = asyncio.Event()

        async def body() -> AsyncIterator[bytes]:
            yield _request_part("cat > /out.txt") + _part("stdin", "stdin.bin")
            await asyncio.wait_for(running.wait(), 5)
            yield b"late\n" + END

        async def watch() -> None:
            while True:
                jobs = (
                    await client.get("/v1/jobs", params={"workspace_id": wid})
                ).json()
                if any(j["status"] == "running" for j in jobs):
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
        assert r.json()["detail"] == "multipart body ended early"


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
        assert r.json()["detail"] == (
            "bad multipart body: Maximum header size exceeded"
        )


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
        assert "before 'stdin'" in r.json()["detail"]

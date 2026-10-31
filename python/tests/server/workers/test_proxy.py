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
import json
import os
import sys
import tempfile
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

import pytest
import uvicorn
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from mirage.server.app import build_app
from mirage.server.env import ENV_WORKER_TOKEN
from mirage.server.rate_limit import RateLimit
from mirage.server.workers import pool as placement
from mirage.server.workers.pool import WorkerPool
from mirage.server.workers.proxy import WorkerProxy, build_worker_proxy
from mirage.server.workers.types import WorkerType

CONFIG = {"mounts": {"/data": {"vfs": "ram", "mode": "write"}}}


def _place_on(monkeypatch, *indexes: int) -> None:
    """Where the next new workspaces go: worker 0 or worker 1, in order."""
    order = list(indexes)
    monkeypatch.setattr(
        placement.random, "choice", lambda running: running[order.pop(0)]
    )


@dataclass
class _Daemon:
    proxy: WorkerProxy
    pool: WorkerPool
    apps: list[FastAPI]
    client: AsyncClient
    exits: list[int]


@asynccontextmanager
async def _daemon(
    max_workspaces: int | None = None,
    rate_limits: Sequence[RateLimit] = (),
) -> AsyncIterator[_Daemon]:
    """Two servers on the pool's sockets, in this process, behind the
    proxy."""
    pool = WorkerPool(
        count=2,
        worker_type=WorkerType.PROCESS,
        env=dict(os.environ),
        host="localhost",
        graceful_timeout=0,
    )
    # The worker apps read the pool's token as they first answer.
    os.environ[ENV_WORKER_TOKEN] = pool.token
    apps = [
        build_app(
            max_workspaces=sys.maxsize,
            rate_limits=rate_limits,
            forwarded_allow_ips=["*"],
        )
        for _ in pool.workers
    ]
    servers = [
        uvicorn.Server(uvicorn.Config(app, uds=w.socket, log_level="warning"))
        for app, w in zip(apps, pool.workers)
    ]
    tasks = [asyncio.create_task(s.serve()) for s in servers]
    while not all(s.started for s in servers):
        await asyncio.sleep(0.01)
    exits: list[int] = []
    proxy = build_worker_proxy(
        pool,
        max_workspaces=max_workspaces,
        proxies=[],
        allowed_hosts=["test", "localhost", "127.0.0.1"],
        idle_grace_seconds=60,
        exit=lambda: exits.append(1),
    )
    try:
        async with AsyncClient(
            transport=ASGITransport(app=proxy), base_url="http://test"
        ) as client:
            yield _Daemon(proxy, pool, apps, client, exits)
    finally:
        for server in servers:
            server.should_exit = True
        await asyncio.gather(*tasks)
        await pool.stop()
        del os.environ[ENV_WORKER_TOKEN]


def _ids(d: _Daemon) -> list[list[str]]:
    return [[e.id for e in app.state.registry.list()] for app in d.apps]


@pytest.mark.asyncio
async def test_each_new_workspace_goes_to_a_worker_at_random(monkeypatch):
    _place_on(monkeypatch, 1, 0, 1)
    async with _daemon() as d:
        for workspace_id in ["a", "b", "c"]:
            r = await d.client.post(
                "/v1/workspaces", json={"id": workspace_id, "config": CONFIG}
            )
            assert r.status_code == 201
        assert _ids(d) == [["b"], ["a", "c"]]
        listed = (await d.client.get("/v1/workspaces")).json()
        assert [w["id"] for w in listed] == ["a", "b", "c"]
        health = (await d.client.get("/v1/health")).json()
        assert health["workspaces"] == 3 and health["workers"] == 2


@pytest.mark.asyncio
async def test_a_workspaces_requests_go_to_its_worker(monkeypatch):
    _place_on(monkeypatch, 0, 1)
    async with _daemon() as d:
        await d.client.post(
            "/v1/workspaces", json={"id": "a", "config": CONFIG}
        )
        await d.client.post(
            "/v1/workspaces", json={"id": "b", "config": CONFIG}
        )
        ran = await d.client.post(
            "/v1/workspaces/b/shell",
            json={"command": "echo hi > /data/x; cat /data/x"},
        )
        assert ran.json()["stdout"] == "hi\n"
        missing = await d.client.post(
            "/v1/workspaces/nope/shell", json={"command": "true"}
        )
        assert missing.status_code == 404


@pytest.mark.asyncio
async def test_a_create_under_a_held_id_or_config_workspace_id_goes_to_its_worker(
    monkeypatch,
):
    _place_on(monkeypatch, 0, 1)
    async with _daemon() as d:
        await d.client.post(
            "/v1/workspaces", json={"id": "a", "config": CONFIG}
        )
        named = {"config": {**CONFIG, "workspace_id": "n"}}
        await d.client.post("/v1/workspaces", json=named)
        assert _ids(d) == [["a"], ["n"]]
        again = await d.client.post(
            "/v1/workspaces", json={"id": "a", "config": CONFIG}
        )
        assert again.status_code == 200
        assert (
            await d.client.post("/v1/workspaces", json=named)
        ).status_code == 200
        other = {"mounts": {"/other": {"vfs": "ram", "mode": "write"}}}
        clash = await d.client.post(
            "/v1/workspaces", json={"id": "a", "config": other}
        )
        assert clash.status_code == 409
        assert _ids(d) == [["a"], ["n"]]
        cloned = await d.client.post(
            "/v1/workspaces/n/clone", json={"id": "n2"}
        )
        assert cloned.status_code == 201
        assert "n2" in _ids(d)[1]
        taken = await d.client.post("/v1/workspaces/n/clone", json={"id": "a"})
        assert taken.status_code == 409
        settle = d.pool.claim("x", d.pool.workers[0])
        building = await d.client.post(
            "/v1/workspaces/n/clone", json={"id": "x"}
        )
        assert building.status_code == 409
        settle()
        closed = await d.client.post("/v1/workspaces/n/close")
        assert closed.status_code == 200
        held = await d.client.post("/v1/workspaces/a/clone", json={"id": "n"})
        assert held.status_code == 409
        again = await d.client.post(
            "/v1/workspaces", json={"id": "n", "config": CONFIG}
        )
        assert again.status_code == 201
        assert "n" in _ids(d)[1]


@pytest.mark.asyncio
async def test_creates_of_one_id_racing_each_other_go_to_one_worker(
    monkeypatch,
):
    _place_on(monkeypatch, 0, 1)
    async with _daemon() as d:
        both = await asyncio.gather(
            d.client.post(
                "/v1/workspaces", json={"id": "same", "config": CONFIG}
            ),
            d.client.post(
                "/v1/workspaces", json={"id": "same", "config": CONFIG}
            ),
        )
        assert sorted(r.status_code for r in both) == [200, 201]
        assert [i for ids in _ids(d) for i in ids] == ["same"]


@pytest.mark.asyncio
async def test_max_workspaces_holds_across_workers_and_lets_a_retry_through():
    async with _daemon(max_workspaces=2) as d:
        racing = await asyncio.gather(
            *(
                d.client.post(
                    "/v1/workspaces", json={"id": i, "config": CONFIG}
                )
                for i in ["a", "b", "c"]
            )
        )
        assert sorted(r.status_code for r in racing) == [201, 201, 503]
        kept, other = [
            w["id"] for w in (await d.client.get("/v1/workspaces")).json()
        ]
        retry = await d.client.post(
            "/v1/workspaces", json={"id": kept, "config": CONFIG}
        )
        assert retry.status_code == 200
        assert (await d.client.get("/v1/ready")).json() == {"status": "full"}
        assert (
            await d.client.delete(f"/v1/workspaces/{kept}")
        ).status_code == 200
        closed = await d.client.post(f"/v1/workspaces/{other}/close")
        assert closed.status_code == 200
        assert (await d.client.get("/v1/health")).json()["workspaces"] == 0
        assert (await d.client.get("/v1/ready")).json() == {"status": "ready"}


@pytest.mark.asyncio
async def test_a_refused_caller_and_an_uploading_body_hold_no_slot():
    async with _daemon(max_workspaces=1) as d:
        refused = await d.client.post(
            "/v1/workspaces",
            json={"id": "x", "config": CONFIG},
            headers={"host": "evil.example"},
        )
        assert refused.status_code == 400
        finish = asyncio.Event()

        async def body() -> AsyncIterator[bytes]:
            yield b'{"id": "slow", '
            await finish.wait()
            yield f'"config": {json.dumps(CONFIG)}}}'.encode()

        slow = asyncio.create_task(
            d.client.post(
                "/v1/workspaces",
                content=body(),
                headers={"content-type": "application/json"},
            )
        )
        await asyncio.sleep(0.1)
        made = await d.client.post(
            "/v1/workspaces", json={"id": "a", "config": CONFIG}
        )
        assert made.status_code == 201
        finish.set()
        assert (await slow).status_code == 503
        assert [i for ids in _ids(d) for i in ids] == ["a"]
        for path in ("/v1/health", "/v1/ready"):
            got = await d.client.get(path, headers={"host": "evil.example"})
            assert got.status_code == 400
        explained = await d.client.post(
            "/v1/workspaces?explain=true", json={"id": "b", "config": CONFIG}
        )
        assert explained.status_code == 200
        assert [i for ids in _ids(d) for i in ids] == ["a"]


@pytest.mark.asyncio
async def test_a_request_counts_once_after_its_caller_check(monkeypatch):
    _place_on(monkeypatch, 0)
    async with _daemon(rate_limits=[RateLimit("ip", "2/minute")]) as d:
        made = await d.client.post(
            "/v1/workspaces", json={"id": "a", "config": CONFIG}
        )
        assert made.status_code == 201
        assert (await d.client.get("/v1/workspaces/a")).status_code == 200
        assert (await d.client.get("/v1/workspaces/a")).status_code == 429
        # A client that learned the token still counts.
        forged = await d.client.get(
            "/v1/workspaces/a", headers={"x-mirage-counted": d.pool.token}
        )
        assert forged.status_code == 429


@pytest.mark.asyncio
async def test_a_clone_counts_against_its_sources_workspace_limit():
    async with _daemon(rate_limits=[RateLimit("workspace", "1/minute")]) as d:
        await d.client.post(
            "/v1/workspaces", json={"id": "a", "config": CONFIG}
        )
        first = await d.client.post("/v1/workspaces/a/clone", json={"id": "b"})
        assert first.status_code == 201
        again = await d.client.post("/v1/workspaces/a/clone", json={"id": "c"})
        assert again.status_code == 429


@pytest.mark.asyncio
async def test_a_shell_answers_while_its_stdin_still_uploads():
    async with _daemon() as d:
        await d.client.post(
            "/v1/workspaces", json={"id": "a", "config": CONFIG}
        )
        socket = os.path.join(tempfile.mkdtemp(prefix="mw-"), "d.sock")
        server = uvicorn.Server(
            uvicorn.Config(
                d.proxy, uds=socket, lifespan="off", log_level="warning"
            )
        )
        serving = asyncio.create_task(server.serve())
        while not server.started:
            await asyncio.sleep(0.01)
        reader, writer = await asyncio.open_unix_connection(socket)
        part = (
            b'--b\r\nContent-Disposition: form-data; name="request"\r\n\r\n'
            b'{"command": "head -n 1"}\r\n'
            b'--b\r\nContent-Disposition: form-data; name="stdin"\r\n\r\n'
            b"hello\n"
        )
        writer.write(
            b"POST /v1/workspaces/a/shell?stream=true HTTP/1.1\r\n"
            b"Host: localhost\r\n"
            b"Content-Type: multipart/form-data; boundary=b\r\n"
            b"Transfer-Encoding: chunked\r\n\r\n"
            + f"{len(part):x}\r\n".encode()
            + part
            + b"\r\n"
        )
        got = b""
        try:
            # The body stays open: the output must come before it ends.
            while b'"status":"done"' not in got:
                got += await asyncio.wait_for(reader.read(65536), 10)
        finally:
            writer.close()
            server.should_exit = True
            await serving
        assert got.startswith(b"HTTP/1.1 200")
        assert b'"stream":"stdout","data":"aGVsbG8K"' in got


@pytest.mark.asyncio
async def test_a_multipart_load_is_read_up_to_its_request_part(monkeypatch):
    _place_on(monkeypatch, 0, 1, 0)
    async with _daemon() as d:
        await d.client.post(
            "/v1/workspaces", json={"id": "a", "config": CONFIG}
        )
        await d.client.post(
            "/v1/workspaces/a/shell", json={"command": "echo kept > /data/x"}
        )
        tar = (await d.client.get("/v1/workspaces/a/snapshot")).content
        loaded = await d.client.post(
            "/v1/workspaces/load",
            files={
                "request": (None, json.dumps({"id": "r"})),
                "snapshot": ("snapshot.tar", tar),
            },
        )
        assert loaded.status_code == 201
        assert "r" in _ids(d)[1]
        read = await d.client.post(
            "/v1/workspaces/r/shell", json={"command": "cat /data/x"}
        )
        assert read.json()["stdout"] == "kept\n"
        lost = await d.client.post(
            "/v1/workspaces/load",
            files=[
                ("snapshot", ("snapshot.tar", bytes(2 * 1024 * 1024))),
                ("request", (None, json.dumps({"id": "a"}))),
            ],
        )
        assert lost.status_code == 413
        preamble = await d.client.post(
            "/v1/workspaces/load",
            content=b"x"
            * (2 * 1024 * 1024)
            + b'\r\n--b\r\nContent-Disposition: form-data; name="request"'
            b"\r\n\r\n{}\r\n--b--\r\n",
            headers={"content-type": "multipart/form-data; boundary=b"},
        )
        assert preamble.status_code == 413
        twice = await d.client.post(
            "/v1/workspaces/load",
            files=[
                ("request", (None, '{"id": ')),
                ("request", (None, '"a"}')),
                ("snapshot", ("snapshot.tar", tar)),
            ],
        )
        assert twice.status_code == 400
        assert _ids(d) == [["a"], ["r"]]
        # One chunk ends the request part and runs past the limit.
        whole = (
            b'--b\r\nContent-Disposition: form-data; name="request"\r\n\r\n'
            b'{"id": "big"}\r\n--b\r\nContent-Disposition: form-data; '
            b'name="snapshot"; filename="s.tar"\r\n\r\n'
            + tar
            + bytes(2 * 1024 * 1024)
            + b"\r\n--b--\r\n"
        )
        big = await d.client.post(
            "/v1/workspaces/load",
            content=whole,
            headers={"content-type": "multipart/form-data; boundary=b"},
        )
        assert big.status_code == 201


@pytest.mark.asyncio
async def test_a_shutdown_its_worker_lets_through_stops_the_daemon():
    async with _daemon() as d:
        r = await d.client.post("/v1/shutdown")
        assert r.json() == {"status": "shutting_down", "pid": os.getpid()}
        assert d.exits == [1]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "worker_type", [WorkerType.PROCESS, WorkerType.THREAD]
)
async def test_workers_serve_lose_their_workspaces_and_leave_nothing_behind(
    monkeypatch, tmp_path, worker_type
):
    monkeypatch.setenv("MIRAGE_HOME", str(tmp_path))
    pool = WorkerPool(
        count=2,
        worker_type=worker_type,
        env=dict(os.environ),
        host="localhost",
        graceful_timeout=0,
    )
    await pool.start()
    proxy = build_worker_proxy(
        pool,
        max_workspaces=None,
        proxies=[],
        allowed_hosts=["test", "localhost", "127.0.0.1"],
        idle_grace_seconds=60,
        exit=lambda: None,
    )
    try:
        async with AsyncClient(
            transport=ASGITransport(app=proxy), base_url="http://test"
        ) as client:
            _place_on(monkeypatch, 0, 1, 0)
            await client.post(
                "/v1/workspaces", json={"id": "a", "config": CONFIG}
            )
            await client.post(
                "/v1/workspaces", json={"id": "b", "config": CONFIG}
            )
            ran = await client.post(
                "/v1/workspaces/b/shell", json={"command": "echo hi"}
            )
            assert ran.json()["stdout"] == "hi\n"
            await pool.workers[1].stop(0)
            assert pool.workers[1].dead
            health = (await client.get("/v1/health")).json()
            assert health["workspaces"] == 1 and health["workers"] == 1
            gone = await client.post(
                "/v1/workspaces/b/shell", json={"command": "true"}
            )
            assert gone.status_code == 404
            kept = await client.post(
                "/v1/workspaces/a/shell", json={"command": "true"}
            )
            assert kept.status_code == 200
            made = await client.post(
                "/v1/workspaces", json={"id": "c", "config": CONFIG}
            )
            assert made.status_code == 201
    finally:
        await pool.stop()
    assert all(w.dead for w in pool.workers)
    assert not Path(pool.workers[0].socket).parent.exists()

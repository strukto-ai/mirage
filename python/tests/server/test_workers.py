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
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass

import pytest
import uvicorn
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from mirage.server.app import build_app
from mirage.server.daemon_config import DaemonConfigError
from mirage.server.env import ENV_CPUS, ENV_WORKERS
from mirage.server.workers import (
    Front,
    WorkerPool,
    build_front,
    parse_cpu_list,
    resolve_workers,
)

CONFIG = {"mounts": {"/data": {"vfs": "ram", "mode": "write"}}}


def test_parse_cpu_list_reads_cpus_and_ranges_in_order_once_each():
    assert parse_cpu_list("0-3,6") == [0, 1, 2, 3, 6]
    assert parse_cpu_list(" 4 , 1-2, 2 ") == [4, 1, 2]


@pytest.mark.parametrize("text", ["", "a", "3-1", "-1", "0-99999"])
def test_parse_cpu_list_refuses(text):
    with pytest.raises(DaemonConfigError):
        parse_cpu_list(text)


def test_resolve_workers_reads_the_env_then_config_then_cpus(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("MIRAGE_HOME", str(tmp_path))
    monkeypatch.delenv(ENV_WORKERS, raising=False)
    monkeypatch.delenv(ENV_CPUS, raising=False)
    assert resolve_workers() == 1
    monkeypatch.setenv(ENV_CPUS, "0-2")
    assert resolve_workers() == 3
    monkeypatch.delenv(ENV_CPUS)
    (tmp_path / "config.toml").write_text("[daemon]\nworkers = 4\n")
    assert resolve_workers() == 4
    monkeypatch.setenv(ENV_WORKERS, "2")
    assert resolve_workers() == 2
    assert resolve_workers(8) == 8
    monkeypatch.setenv(ENV_WORKERS, "0")
    with pytest.raises(DaemonConfigError, match="workers"):
        resolve_workers()


@dataclass
class _Daemon:
    front: Front
    workers: list[FastAPI]
    client: AsyncClient
    exits: list[int]


@asynccontextmanager
async def _daemon(max_workspaces: int | None = None) -> AsyncIterator[_Daemon]:
    """Two in-process workers on the pool's sockets, behind a front."""
    pool = WorkerPool(
        count=2,
        cpus=None,
        command=[sys.executable],
        env=dict(os.environ),
        graceful_timeout=0,
    )
    apps = [build_app(max_workspaces=sys.maxsize) for _ in pool.workers]
    servers = [
        uvicorn.Server(uvicorn.Config(app, uds=w.socket, log_level="warning"))
        for app, w in zip(apps, pool.workers)
    ]
    tasks = [asyncio.create_task(s.serve()) for s in servers]
    while not all(s.started for s in servers):
        await asyncio.sleep(0.01)
    exits: list[int] = []
    front = build_front(
        pool,
        max_workspaces=max_workspaces,
        proxies=[],
        idle_grace_seconds=60,
        exit=lambda: exits.append(1),
    )
    try:
        async with AsyncClient(
            transport=ASGITransport(app=front), base_url="http://test"
        ) as client:
            yield _Daemon(front, apps, client, exits)
    finally:
        for server in servers:
            server.should_exit = True
        await asyncio.gather(*tasks)
        await pool.stop()


def _ids(app: FastAPI) -> list[str]:
    return [entry.id for entry in app.state.registry.list()]


@pytest.mark.asyncio
async def test_front_puts_each_workspace_on_the_worker_holding_the_fewest():
    async with _daemon() as d:
        for workspace_id in ["a", "b", "c"]:
            r = await d.client.post(
                "/v1/workspaces", json={"id": workspace_id, "config": CONFIG}
            )
            assert r.status_code == 201
        assert [_ids(app) for app in d.workers] == [["a", "c"], ["b"]]
        listed = (await d.client.get("/v1/workspaces")).json()
        assert [w["id"] for w in listed] == ["a", "b", "c"]
        health = (await d.client.get("/v1/health")).json()
        assert health["workspaces"] == 3 and health["workers"] == 2


@pytest.mark.asyncio
async def test_front_sends_a_workspaces_requests_and_jobs_to_its_worker():
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
        started = await d.client.post(
            "/v1/workspaces/b/shell?background=true",
            json={"command": "echo bg"},
        )
        job = started.json()["job_id"]
        got = await d.client.get(f"/v1/jobs/{job}")
        assert got.status_code == 200
        assert got.json()["workspace_id"] == "b"
        assert (await d.client.get("/v1/jobs/nope")).status_code == 404
        missing = await d.client.post(
            "/v1/workspaces/nope/shell", json={"command": "true"}
        )
        assert missing.status_code == 404


@pytest.mark.asyncio
async def test_front_sends_a_create_under_a_held_id_to_the_worker_holding_it():
    async with _daemon() as d:
        await d.client.post(
            "/v1/workspaces", json={"id": "a", "config": CONFIG}
        )
        await d.client.post(
            "/v1/workspaces", json={"id": "b", "config": CONFIG}
        )
        again = await d.client.post(
            "/v1/workspaces", json={"id": "a", "config": CONFIG}
        )
        assert again.status_code == 200
        other = {"mounts": {"/other": {"vfs": "ram", "mode": "write"}}}
        clash = await d.client.post(
            "/v1/workspaces", json={"id": "a", "config": other}
        )
        assert clash.status_code == 409
        assert [len(_ids(app)) for app in d.workers] == [1, 1]
        cloned = await d.client.post(
            "/v1/workspaces/b/clone", json={"id": "b2"}
        )
        assert cloned.status_code == 201
        assert "b2" in _ids(d.workers[1])
        taken = await d.client.post("/v1/workspaces/b/clone", json={"id": "a"})
        assert taken.status_code == 409


@pytest.mark.asyncio
async def test_front_reads_a_multipart_load_up_to_its_request_part():
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
        assert "r" in _ids(d.workers[1])
        read = await d.client.post(
            "/v1/workspaces/r/shell", json={"command": "cat /data/x"}
        )
        assert read.json()["stdout"] == "kept\n"


@pytest.mark.asyncio
async def test_front_counts_deletes_and_closes_and_holds_max_workspaces():
    async with _daemon(max_workspaces=2) as d:
        await d.client.post(
            "/v1/workspaces", json={"id": "a", "config": CONFIG}
        )
        await d.client.post(
            "/v1/workspaces", json={"id": "b", "config": CONFIG}
        )
        full = await d.client.post(
            "/v1/workspaces", json={"id": "c", "config": CONFIG}
        )
        assert full.status_code == 503
        assert full.json() == {"detail": "server is at max_workspaces (2)"}
        assert (await d.client.get("/v1/ready")).json() == {"status": "full"}
        assert (await d.client.delete("/v1/workspaces/a")).status_code == 200
        assert (
            await d.client.post("/v1/workspaces/b/close")
        ).status_code == 200
        assert (await d.client.get("/v1/health")).json()["workspaces"] == 0
        assert (await d.client.get("/v1/ready")).json() == {"status": "ready"}


@pytest.mark.asyncio
async def test_front_stops_the_daemon_on_a_shutdown_its_worker_lets_through():
    async with _daemon() as d:
        r = await d.client.post("/v1/shutdown")
        assert r.json() == {"status": "shutting_down", "pid": os.getpid()}
        assert d.exits == [1]

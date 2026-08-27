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

import pytest
from httpx import ASGITransport, AsyncClient

from mirage.server.app import build_app


def _minimal_config() -> dict:
    return {
        "config": {
            "mounts": {
                "/": {
                    "resource": "ram",
                    "mode": "WRITE"
                }
            },
        },
    }


async def _create_workspace(client: AsyncClient) -> str:
    r = await client.post("/v1/workspaces", json=_minimal_config())
    assert r.status_code == 201
    return r.json()["id"]


@pytest.mark.asyncio
async def test_execute_sync_returns_io_result():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        wid = await _create_workspace(client)
        r = await client.post(
            f"/v1/workspaces/{wid}/execute",
            json={"command": "echo hello"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["kind"] == "io"
        assert body["exit_code"] == 0
        assert body["stdout"].startswith("hello")
        assert "X-Mirage-Job-Id" in r.headers


@pytest.mark.asyncio
async def test_execute_honors_cwd():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        wid = await _create_workspace(client)
        r = await client.post(
            f"/v1/workspaces/{wid}/execute",
            json={"command": "mkdir -p /sub && echo -n nested > /sub/f.txt"},
        )
        assert r.status_code == 200, r.text
        r = await client.post(
            f"/v1/workspaces/{wid}/execute",
            json={
                "command": "cat f.txt",
                "cwd": "/sub"
            },
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["exit_code"] == 0
        assert body["stdout"] == "nested"


@pytest.mark.asyncio
async def test_execute_passes_runtime_through():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        wid = await _create_workspace(client)
        # An unknown entry name fails loud inside Workspace.execute,
        # proving the field reaches the runtime argument.
        r = await client.post(
            f"/v1/workspaces/{wid}/execute",
            json={
                "command": "echo hi",
                "runtime": "no-such-runtime"
            },
        )
        assert r.status_code == 500, r.text
        assert "unknown runtime" in r.json()["detail"]


@pytest.mark.asyncio
async def test_execute_sync_records_a_job_in_done_state():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        wid = await _create_workspace(client)
        r = await client.post(
            f"/v1/workspaces/{wid}/execute",
            json={"command": "echo done-marker"},
        )
        job_id = r.headers["X-Mirage-Job-Id"]

        rj = await client.get(f"/v1/jobs/{job_id}")
        assert rj.status_code == 200
        body = rj.json()
        assert body["status"] == "done"
        assert body["result"]["stdout"].startswith("done-marker")


@pytest.mark.asyncio
async def test_execute_background_returns_job_id_immediately():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        wid = await _create_workspace(client)
        r = await client.post(
            f"/v1/workspaces/{wid}/execute?background=true",
            json={"command": "sleep 0.3 && echo bg-done"},
        )
        assert r.status_code == 202, r.text
        body = r.json()
        assert body["job_id"].startswith("job_")
        assert body["workspace_id"] == wid


@pytest.mark.asyncio
async def test_background_job_completes_and_result_is_readable():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        wid = await _create_workspace(client)
        r = await client.post(
            f"/v1/workspaces/{wid}/execute?background=true",
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
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        wid = await _create_workspace(client)
        r = await client.post(
            f"/v1/workspaces/{wid}/execute?background=true",
            json={"command": "sleep 1.0"},
        )
        job_id = r.json()["job_id"]
        rw = await client.post(f"/v1/jobs/{job_id}/wait",
                               json={"timeout_s": 0.1})
        assert rw.status_code == 200
        assert rw.json()["status"] == "running"


@pytest.mark.asyncio
async def test_cancel_running_job():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        wid = await _create_workspace(client)
        r = await client.post(
            f"/v1/workspaces/{wid}/execute?background=true",
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
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        wid_a = await _create_workspace(client)
        wid_b = await _create_workspace(client)
        await client.post(
            f"/v1/workspaces/{wid_a}/execute",
            json={"command": "echo a"},
        )
        await client.post(
            f"/v1/workspaces/{wid_b}/execute",
            json={"command": "echo b"},
        )
        r = await client.get("/v1/jobs")
        assert len(r.json()) == 2

        r = await client.get(f"/v1/jobs?workspace_id={wid_a}")
        jobs = r.json()
        assert len(jobs) == 1
        assert jobs[0]["workspace_id"] == wid_a


@pytest.mark.asyncio
async def test_execute_with_stdin_multipart():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        wid = await _create_workspace(client)
        r = await client.post(
            f"/v1/workspaces/{wid}/execute",
            data={"request": json.dumps({"command": "wc -l"})},
            files={
                "stdin":
                ("stdin.bin", b"a\nb\nc\n", "application/octet-stream"),
            },
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["exit_code"] == 0
        assert body["stdout"].strip().startswith("3")


@pytest.mark.asyncio
async def test_unknown_workspace_404():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        r = await client.post(
            "/v1/workspaces/ws_doesnotexist/execute",
            json={"command": "echo hi"},
        )
        assert r.status_code == 404


@pytest.mark.asyncio
async def test_unknown_job_404():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        r = await client.get("/v1/jobs/job_doesnotexist")
        assert r.status_code == 404

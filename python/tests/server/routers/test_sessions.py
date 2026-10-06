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

import pytest
from httpx import ASGITransport, AsyncClient

from mirage.server import build_app
from mirage.types import MountMode


def _minimal_config() -> dict:
    return {
        "config": {
            "mounts": {"/": {"vfs": "ram", "mode": "WRITE"}},
        },
    }


async def _create_workspace(client: AsyncClient) -> str:
    r = await client.post("/v1/workspaces", json=_minimal_config())
    return r.json()["id"]


@pytest.mark.asyncio
async def test_create_list_delete_session_round_trip():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)

        r = await client.post(
            f"/v1/workspaces/{wid}/sessions", json={"session_id": "agent_a"}
        )
        assert r.status_code == 201, r.text
        assert r.json()["session_id"] == "agent_a"

        r = await client.get(f"/v1/workspaces/{wid}/sessions")
        ids = {s["session_id"] for s in r.json()}
        assert "agent_a" in ids
        assert len(ids) == 2

        r = await client.delete(f"/v1/workspaces/{wid}/sessions/agent_a")
        assert r.status_code == 200

        r = await client.get(f"/v1/workspaces/{wid}/sessions")
        ids = {s["session_id"] for s in r.json()}
        assert "agent_a" not in ids


@pytest.mark.asyncio
async def test_create_session_without_id_auto_assigns():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        r = await client.post(f"/v1/workspaces/{wid}/sessions", json={})
        assert r.status_code == 201
        sid = r.json()["session_id"]
        assert sid.startswith("sess_")


@pytest.mark.asyncio
async def test_create_session_collision_409():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        await client.post(
            f"/v1/workspaces/{wid}/sessions", json={"session_id": "dup"}
        )
        r = await client.post(
            f"/v1/workspaces/{wid}/sessions", json={"session_id": "dup"}
        )
        assert r.status_code == 409


@pytest.mark.asyncio
async def test_delete_unknown_session_404():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        r = await client.delete(f"/v1/workspaces/{wid}/sessions/nonexistent")
        assert r.status_code == 404


@pytest.mark.asyncio
async def test_create_session_refuses_a_bare_mount_list():
    # A list of prefixes used to mean "only these mounts". A profile now
    # narrows the mounts it names and never decides whether one exists,
    # so the list would be a silent no-op that still reads like
    # confinement: the door refuses it instead.
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        r = await client.post(
            f"/v1/workspaces/{wid}/sessions",
            json={
                "session_id": "agent_a",
                "mounts": ["/"],
            },
        )
        assert r.status_code == 422, r.text


@pytest.mark.asyncio
async def test_create_session_with_mount_modes():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        r = await client.post(
            f"/v1/workspaces/{wid}/sessions",
            json={
                "session_id": "agent_b",
                "mounts": {"/": "read"},
            },
        )
        assert r.status_code == 201, r.text

        registry = app.state.registry
        sess = registry.get(wid).runner.ws.get_session("agent_b")
        assert sess.mount_modes is not None
        assert sess.mount_modes.get("/") == MountMode.READ


@pytest.mark.asyncio
async def test_create_session_rejects_bad_profile():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        r = await client.post(
            f"/v1/workspaces/{wid}/sessions",
            json={
                "session_id": "agent_c",
                "mounts": {"/": "admin"},
            },
        )
        assert r.status_code == 422, r.text


@pytest.mark.asyncio
async def test_create_session_rejects_an_unknown_profile():
    # PolicyError is not a ValueError, so naming an unknown profile used to
    # escape the handler as a 500: the caller's typo read as our bug.
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        r = await client.post(
            f"/v1/workspaces/{wid}/sessions",
            json={
                "session_id": "agent_d",
                "profile": "nope",
            },
        )
        assert r.status_code == 422, r.text
        assert "nope" in r.text


@pytest.mark.asyncio
async def test_session_isolated_per_workspace():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        wid_a = await _create_workspace(client)
        wid_b = await _create_workspace(client)
        await client.post(
            f"/v1/workspaces/{wid_a}/sessions",
            json={"session_id": "only_in_a"},
        )
        r = await client.get(f"/v1/workspaces/{wid_b}/sessions")
        ids = {s["session_id"] for s in r.json()}
        assert "only_in_a" not in ids


async def _wait_status(client, job_id: str, status: str) -> dict:
    for _ in range(500):
        job = (await client.get(f"/v1/jobs/{job_id}")).json()
        if job["status"] == status:
            return job
        await asyncio.sleep(0.01)
    raise AssertionError(f"job {job_id} never reached {status}: {job}")


@pytest.mark.asyncio
async def test_session_cancel_stops_its_jobs_and_spares_the_others():
    app = build_app(idle_grace_seconds=10.0)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        r = await client.post(
            "/v1/workspaces",
            json={
                "config": {"mounts": {"/": {"vfs": "ram", "mode": "WRITE"}}}
            },
        )
        wid = r.json()["id"]
        for sid in ("a", "b"):
            await client.post(
                f"/v1/workspaces/{wid}/sessions", json={"session_id": sid}
            )
        jobs = {}
        for sid in ("a", "b"):
            r = await client.post(
                f"/v1/workspaces/{wid}/shell",
                params={"session_id": sid, "background": "true"},
                json={"command": "sleep 30"},
            )
            jobs[sid] = r.json()["job_id"]
            await _wait_status(client, jobs[sid], "running")
        r = await client.post(f"/v1/workspaces/{wid}/sessions/a/cancel")
        assert r.status_code == 200
        assert r.json() == {"canceled": 1}
        await _wait_status(client, jobs["a"], "canceled")
        b = (await client.get(f"/v1/jobs/{jobs['b']}")).json()
        assert b["status"] == "running"
        r = await client.post(f"/v1/workspaces/{wid}/sessions/nope/cancel")
        assert r.status_code == 404
        await client.delete(f"/v1/workspaces/{wid}")


@pytest.mark.asyncio
async def test_session_kill_stops_background_jobs_and_keeps_the_session():
    app = build_app(idle_grace_seconds=10.0)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        r = await client.post(
            "/v1/workspaces",
            json={
                "config": {"mounts": {"/": {"vfs": "ram", "mode": "WRITE"}}}
            },
        )
        wid = r.json()["id"]
        await client.post(
            f"/v1/workspaces/{wid}/sessions", json={"session_id": "a"}
        )
        await client.post(
            f"/v1/workspaces/{wid}/shell",
            params={"session_id": "a"},
            json={"command": "sleep 30 &"},
        )
        r = await client.post(f"/v1/workspaces/{wid}/sessions/a/kill")
        assert r.json() == {"killed": 1}
        r = await client.post(
            f"/v1/workspaces/{wid}/shell",
            params={"session_id": "a"},
            json={"command": "jobs; echo alive"},
        )
        assert "alive" in r.json()["stdout"]
        await client.delete(f"/v1/workspaces/{wid}")

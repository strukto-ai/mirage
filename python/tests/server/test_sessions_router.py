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

import pytest
from httpx import ASGITransport, AsyncClient

from mirage.server.app import build_app
from mirage.types import MountMode


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
    return r.json()["id"]


@pytest.mark.asyncio
async def test_create_list_delete_session_round_trip():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        wid = await _create_workspace(client)

        r = await client.post(f"/v1/workspaces/{wid}/sessions",
                              json={"session_id": "agent_a"})
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
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        wid = await _create_workspace(client)
        r = await client.post(f"/v1/workspaces/{wid}/sessions", json={})
        assert r.status_code == 201
        sid = r.json()["session_id"]
        assert sid.startswith("sess_")


@pytest.mark.asyncio
async def test_create_session_collision_409():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        wid = await _create_workspace(client)
        await client.post(f"/v1/workspaces/{wid}/sessions",
                          json={"session_id": "dup"})
        r = await client.post(f"/v1/workspaces/{wid}/sessions",
                              json={"session_id": "dup"})
        assert r.status_code == 409


@pytest.mark.asyncio
async def test_delete_unknown_session_404():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
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
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
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
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        wid = await _create_workspace(client)
        r = await client.post(
            f"/v1/workspaces/{wid}/sessions",
            json={
                "session_id": "agent_b",
                "mounts": {
                    "/": "read"
                },
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
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        wid = await _create_workspace(client)
        r = await client.post(
            f"/v1/workspaces/{wid}/sessions",
            json={
                "session_id": "agent_c",
                "mounts": {
                    "/": "admin"
                },
            },
        )
        assert r.status_code == 422, r.text


@pytest.mark.asyncio
async def test_create_session_rejects_an_unknown_profile():
    # PolicyError is not a ValueError, so naming an unknown profile used to
    # escape the handler as a 500: the caller's typo read as our bug.
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
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
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        wid_a = await _create_workspace(client)
        wid_b = await _create_workspace(client)
        await client.post(f"/v1/workspaces/{wid_a}/sessions",
                          json={"session_id": "only_in_a"})
        r = await client.get(f"/v1/workspaces/{wid_b}/sessions")
        ids = {s["session_id"] for s in r.json()}
        assert "only_in_a" not in ids

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

from mirage.server import build_app


async def _workspace(client: AsyncClient) -> str:
    r = await client.post(
        "/v1/workspaces",
        json={"config": {"mounts": {"/": {"vfs": "ram", "mode": "WRITE"}}}},
    )
    return r.json()["id"]


async def _unreadable_store() -> None:
    raise PermissionError("session store unreadable")


@pytest.mark.asyncio
async def test_a_session_that_does_not_exist_answers_404():
    app = build_app(idle_grace_seconds=10.0)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        wid = await _workspace(client)
        r = await client.get(f"/v1/workspaces/{wid}/sessions/ghost/vfs-md")
        assert r.status_code == 404
        r = await client.put(
            f"/v1/workspaces/{wid}/skill-md",
            params={"session_id": "ghost"},
            json={"path": "/SKILL.md"},
        )
        assert r.status_code == 404


@pytest.mark.asyncio
async def test_an_unreadable_session_store_is_a_server_failure(monkeypatch):
    app = build_app(idle_grace_seconds=10.0)
    async with AsyncClient(
        transport=ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://test",
    ) as client:
        wid = await _workspace(client)
        ws = app.state.registry.get(wid).runner.ws
        monkeypatch.setattr(ws, "ensure_sessions_loaded", _unreadable_store)
        r = await client.get(f"/v1/workspaces/{wid}/vfs-md")
        assert r.status_code == 500

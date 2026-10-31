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


def _config() -> dict:
    return {"config": {"mounts": {"/": {"vfs": "ram", "mode": "write"}}}}


@pytest.mark.asyncio
async def test_ready_answers_503_while_full_or_shutting_down():
    app = build_app(idle_grace_seconds=10.0, max_workspaces=1)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        r = await client.get("/v1/ready")
        assert (r.status_code, r.json()) == (200, {"status": "ready"})
        assert (
            await client.post("/v1/workspaces", json=_config())
        ).status_code == 201
        r = await client.get("/v1/ready")
        assert (r.status_code, r.json()) == (503, {"status": "full"})
        await app.state.registry.drain(0)
        r = await client.get("/v1/ready")
        assert (r.status_code, r.json()) == (503, {"status": "shutting_down"})
        assert (await client.get("/v1/health")).status_code == 200
    await app.state.registry.close_all()


@pytest.mark.asyncio
async def test_ready_counts_a_workspace_still_being_built():
    app = build_app(idle_grace_seconds=10.0, max_workspaces=1)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        async with app.state.registry.creating("w", "config"):
            r = await client.get("/v1/ready")
            assert (r.status_code, r.json()) == (503, {"status": "full"})
        r = await client.get("/v1/ready")
        assert (r.status_code, r.json()) == (200, {"status": "ready"})

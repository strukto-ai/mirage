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

import socket

import pytest
from httpx import ASGITransport, AsyncClient

from mirage.server import build_app


@pytest.mark.asyncio
async def test_the_host_is_listed_and_read_with_its_processes():
    app = build_app(idle_grace_seconds=10.0)
    host = f"host:{socket.gethostname()}"
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        r = await client.post(
            "/v1/workspaces",
            json={"config": {"mounts": {"/": {"vfs": "ram"}}}},
        )
        assert r.status_code == 201, r.text
        wid = r.json()["id"]
        r = await client.post(
            f"/v1/workspaces/{wid}/shell", json={"command": "sleep 30 &"}
        )
        assert r.status_code == 200, r.text
        r = await client.get(f"/v1/workspaces/{wid}/machines")
        assert r.status_code == 200, r.text
        [machine] = r.json()
        assert (machine["id"], machine["state"]) == (host, "managed")
        r = await client.get(f"/v1/workspaces/{wid}/machines/{host}")
        assert r.status_code == 200, r.text
        said = r.json()
        assert said["state"] == "managed"
        assert "sleep 30" in [p["command"] for p in said["processes"]]
        r = await client.get(f"/v1/workspaces/{wid}/machines/docker:none")
        assert r.status_code == 404
        r = await client.get(f"/v1/workspaces/{wid}/machines/plain")
        assert r.status_code == 400

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


async def _create_workspace(client: AsyncClient) -> str:
    r = await client.post(
        "/v1/workspaces",
        json={"config": {"mounts": {"/": {"vfs": "ram", "mode": "WRITE"}}}},
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _shell(client: AsyncClient, wid: str, command: str) -> dict:
    r = await client.post(
        f"/v1/workspaces/{wid}/shell", json={"command": command}
    )
    assert r.status_code == 200, r.text
    return r.json()


# A process is listed live and, once ended, with how it ended.
@pytest.mark.asyncio
async def test_a_process_is_listed_live_and_after_it_ends():
    app = build_app(idle_grace_seconds=10.0)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        result = await _shell(client, wid, "sleep 30 & echo $!")
        pid = int(result["stdout"])
        r = await client.get(
            f"/v1/workspaces/{wid}/processes", params={"state": "running"}
        )
        assert r.status_code == 200, r.text
        assert [p["pid"] for p in r.json()["items"]] == [pid]
        r = await client.get(
            f"/v1/workspaces/{wid}/processes",
            params={"line_id": result["line_id"]},
        )
        assert pid in [p["pid"] for p in r.json()["items"]]
        [job] = (await client.get(f"/v1/workspaces/{wid}/jobs")).json()[
            "items"
        ]
        r = await client.get(
            f"/v1/workspaces/{wid}/processes", params={"job_id": job["id"]}
        )
        [live] = r.json()["items"]
        assert (live["pid"], live["machine_pid"]) == (pid, None)
        r = await client.get(
            f"/v1/workspaces/{wid}/processes",
            params={"job_id": job["id"].removeprefix("job_")},
        )
        assert (r.status_code, r.json()) == (200, {"items": []})
        machine = live["machine"]
        assert (machine["type"], machine["id"]) == ("host", machine["name"])
        r = await client.get(
            f"/v1/workspaces/{wid}/processes",
            params={"machine": f"{machine['type']}:{machine['name']}"},
        )
        assert pid in [p["pid"] for p in r.json()["items"]]
        r = await client.get(
            f"/v1/workspaces/{wid}/processes",
            params={"machine": "docker:nowhere"},
        )
        assert r.json() == {"items": []}
        r = await client.get(
            f"/v1/workspaces/{wid}/processes", params={"machine": "nowhere"}
        )
        assert r.status_code == 400
        assert r.json() == {
            "error": {
                "code": "invalid_value",
                "message": "machine must be provider:name",
                "param": "machine",
            }
        }
        await _shell(client, wid, "kill %1; wait")
        r = await client.get(f"/v1/workspaces/{wid}/processes/{pid}")
        assert r.status_code == 200, r.text
        ended = r.json()
        assert (ended["command"], ended["state"], ended["signal"]) == (
            "sleep 30",
            "exited",
            15,
        )
        r = await client.get(f"/v1/workspaces/{wid}/processes/99999")
        assert r.status_code == 404

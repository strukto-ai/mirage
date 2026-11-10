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

import re

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


# A job is listed while its session lists it, with the pid `$!` names,
# and found by its id with the processes it ran.
@pytest.mark.asyncio
async def test_a_running_job_is_listed_and_found_by_id():
    app = build_app(idle_grace_seconds=10.0)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        result = await _shell(client, wid, "sleep 30 & echo $!")
        pid = int(result["stdout"])
        try:
            r = await client.get(
                f"/v1/workspaces/{wid}/jobs", params={"state": "running"}
            )
            assert r.status_code == 200, r.text
            [job] = r.json()
            assert (
                job["number"],
                job["command"],
                job["line_id"],
                job["pid"],
            ) == (1, "sleep 30", result["line_id"], pid)
            assert re.fullmatch(r"job_[0-9a-f]{32}", job["id"])
            r = await client.get(f"/v1/workspaces/{wid}/jobs/{job['id']}")
            assert r.status_code == 200, r.text
            assert r.json() == {**job, "processes": [pid]}
            bare = job["id"].removeprefix("job_")
            r = await client.get(f"/v1/workspaces/{wid}/jobs/{bare}")
            assert (r.status_code, r.json()) == (
                404,
                {"detail": "job not found"},
            )
            r = await client.get(
                f"/v1/workspaces/{wid}/jobs",
                params={"line_id": result["line_id"]},
            )
            assert r.json() == [job]
            r = await client.get(
                f"/v1/workspaces/{wid}/jobs", params={"line_id": "nope"}
            )
            assert r.json() == []
            r = await client.get(
                f"/v1/workspaces/{wid}/jobs", params={"session_id": "other"}
            )
            assert r.json() == []
            r = await client.get(f"/v1/workspaces/{wid}/jobs/nope")
            assert r.status_code == 404
        finally:
            await _shell(client, wid, "kill %1; wait")

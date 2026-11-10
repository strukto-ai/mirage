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


# A line the server runs answers with its id, by which the workspace's
# lines list and find it, with the jobs it started and what it ran.
@pytest.mark.asyncio
async def test_a_line_is_listed_and_found_by_the_id_its_result_names():
    app = build_app(idle_grace_seconds=10.0)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        result = await _shell(client, wid, "sleep 30 & echo $!")
        pid = int(result["stdout"])
        try:
            r = await client.get(f"/v1/workspaces/{wid}/lines")
            assert r.status_code == 200, r.text
            [line] = r.json()
            assert line["id"] == result["line_id"]
            assert (line["command"], line["state"], line["exit"]) == (
                "sleep 30 & echo $!",
                "exited",
                0,
            )
            r = await client.get(f"/v1/workspaces/{wid}/lines/{line['id']}")
            assert r.status_code == 200, r.text
            detail = r.json()
            [job] = (await client.get(f"/v1/workspaces/{wid}/jobs")).json()
            assert detail["jobs"] == [job["id"]]
            assert job["id"].startswith("job_")
            assert pid in detail["processes"]
            r = await client.get(f"/v1/workspaces/{wid}/processes/{pid}")
            assert detail["machines"] == [r.json()["machine"]]
            r = await client.get(
                f"/v1/workspaces/{wid}/lines", params={"state": "running"}
            )
            assert r.json() == []
            r = await client.get(
                f"/v1/workspaces/{wid}/lines", params={"state": "lost"}
            )
            assert r.status_code == 422
            r = await client.get(f"/v1/workspaces/{wid}/lines/nope")
            assert r.status_code == 404
        finally:
            await _shell(client, wid, "kill %1; wait")

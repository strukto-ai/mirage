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

CONFIG = {
    "config": {
        "mounts": {"/": {"vfs": "ram", "mode": "WRITE"}},
        "profiles": {
            "guarded": {
                "commands": {
                    "ask": [{"commands": ["rm"], "reason": "sign-off"}],
                },
            },
        },
    },
}


@pytest.mark.asyncio
async def test_explain_shell_is_the_dry_run_of_shell():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        r = await client.post("/v1/workspaces", json=CONFIG)
        wid = r.json()["id"]
        r = await client.post(
            f"/v1/workspaces/{wid}/sessions",
            json={"session_id": "agent", "profile": "guarded"},
        )
        assert r.status_code == 201, r.text
        r = await client.post(
            f"/v1/workspaces/{wid}/explain/shell",
            json={"command": "rm /f.txt", "session_id": "agent"},
        )
        assert r.status_code == 200, r.text
        [rm] = r.json()["explanations"]
        assert (rm["outcome"], rm["exit_code"], rm["stderr"]) == (
            "ask",
            126,
            "rm: Permission denied\n",
        )
        assert rm["refusal"]["kind"] == "pending"
        assert rm["answers"] == [
            {
                "kind": "ask",
                "reason": "sign-off",
                "policy": "PermissionsPolicy",
            }
        ]
        r = await client.get(f"/v1/workspaces/{wid}/asks")
        assert r.json() == []
        r = await client.post(
            f"/v1/workspaces/{wid}/explain/shell",
            json={"command": "ls", "session_id": "nobody"},
        )
        assert r.status_code == 404

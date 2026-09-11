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

ASK_REASON = "removal needs sign-off"


def _guarded_config() -> dict:
    return {
        "config": {
            "mounts": {
                "/": {
                    "resource": "ram",
                    "mode": "WRITE"
                }
            },
            "profiles": {
                "guarded": {
                    "commands": {
                        "ask": [{
                            "commands": ["rm"],
                            "reason": ASK_REASON,
                        }],
                    },
                },
            },
        },
    }


async def _create_workspace(client: AsyncClient) -> str:
    r = await client.post("/v1/workspaces", json=_guarded_config())
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _create_session(client: AsyncClient, wid: str, sid: str) -> None:
    r = await client.post(f"/v1/workspaces/{wid}/sessions",
                          json={
                              "session_id": sid,
                              "profile": "guarded"
                          })
    assert r.status_code == 201, r.text


async def _raise_ask(client: AsyncClient, wid: str, sid: str) -> str:
    """Run the guarded line once: it is refused pending and the ask id
    is what the pending list now holds."""
    r = await client.post(f"/v1/workspaces/{wid}/execute",
                          json={
                              "command": "rm /f.txt",
                              "session_id": sid
                          })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["exit_code"] == 126
    assert body["stderr"] == "rm: Permission denied\n"
    assert body["refusal"]["kind"] == "pending"
    r = await client.get(f"/v1/workspaces/{wid}/asks?session_id={sid}")
    assert r.status_code == 200
    pending = r.json()
    assert len(pending) == 1
    return pending[0]["id"]


@pytest.mark.asyncio
async def test_ask_allow_round_trip():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        wid = await _create_workspace(client)
        await _create_session(client, wid, "agent_a")
        await client.post(f"/v1/workspaces/{wid}/execute",
                          json={
                              "command": "touch /f.txt",
                              "session_id": "agent_a"
                          })
        ask_id = await _raise_ask(client, wid, "agent_a")

        r = await client.get(f"/v1/workspaces/{wid}/asks")
        record = r.json()[0]
        assert record["id"] == ask_id
        assert record["session_id"] == "agent_a"
        assert record["command"] == "rm"
        assert record["argv"] == ["/f.txt"]
        assert record["reason"] == ASK_REASON
        assert record["outcome"] is None

        r = await client.post(f"/v1/workspaces/{wid}/asks/{ask_id}",
                              json={
                                  "answer": "allow",
                                  "note": "reviewed"
                              })
        assert r.status_code == 200, r.text
        settled = r.json()
        assert settled["outcome"] == "allow"
        assert settled["scope"] == "once"
        assert settled["note"] == "reviewed"

        r = await client.get(f"/v1/workspaces/{wid}/asks")
        assert r.json() == []
        r = await client.get(f"/v1/workspaces/{wid}/asks?all=true")
        assert [a["id"] for a in r.json()] == [ask_id]

        r = await client.post(f"/v1/workspaces/{wid}/execute",
                              json={
                                  "command": "rm /f.txt",
                                  "session_id": "agent_a"
                              })
        assert r.json()["exit_code"] == 0, r.text
        # The ONCE answer is consumed by the retry that used it.
        r = await client.get(f"/v1/workspaces/{wid}/asks?all=true")
        assert r.json() == []


@pytest.mark.asyncio
async def test_ask_deny_refuses_the_retry():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        wid = await _create_workspace(client)
        await _create_session(client, wid, "agent_a")
        ask_id = await _raise_ask(client, wid, "agent_a")

        r = await client.post(f"/v1/workspaces/{wid}/asks/{ask_id}",
                              json={"answer": "deny"})
        assert r.status_code == 200, r.text
        assert r.json()["outcome"] == "deny"

        r = await client.post(f"/v1/workspaces/{wid}/execute",
                              json={
                                  "command": "rm /f.txt",
                                  "session_id": "agent_a"
                              })
        body = r.json()
        assert body["exit_code"] == 126
        assert body["stderr"] == "rm: Permission denied\n"
        assert body["refusal"]["kind"] == "deny"
        assert ASK_REASON in body["refusal"]["reason"]


@pytest.mark.asyncio
async def test_session_scope_covers_the_next_matching_line():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        wid = await _create_workspace(client)
        await _create_session(client, wid, "agent_a")
        await client.post(f"/v1/workspaces/{wid}/execute",
                          json={
                              "command": "touch /f.txt /g.txt",
                              "session_id": "agent_a"
                          })
        ask_id = await _raise_ask(client, wid, "agent_a")

        r = await client.post(f"/v1/workspaces/{wid}/asks/{ask_id}",
                              json={
                                  "answer": "allow",
                                  "scope": "session"
                              })
        assert r.status_code == 200, r.text
        assert r.json()["scope"] == "session"

        for target in ("/f.txt", "/g.txt"):
            r = await client.post(f"/v1/workspaces/{wid}/execute",
                                  json={
                                      "command": f"rm {target}",
                                      "session_id": "agent_a"
                                  })
            assert r.json()["exit_code"] == 0, r.text


@pytest.mark.asyncio
async def test_list_asks_filters_by_session():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        wid = await _create_workspace(client)
        await _create_session(client, wid, "agent_a")
        await _create_session(client, wid, "agent_b")
        await _raise_ask(client, wid, "agent_a")
        await _raise_ask(client, wid, "agent_b")

        r = await client.get(f"/v1/workspaces/{wid}/asks")
        assert {a["session_id"] for a in r.json()} == {"agent_a", "agent_b"}
        r = await client.get(f"/v1/workspaces/{wid}/asks?session_id=agent_b")
        assert [a["session_id"] for a in r.json()] == ["agent_b"]
        r = await client.get(f"/v1/workspaces/{wid}/asks?session_id=nope")
        assert r.status_code == 404, r.text


@pytest.mark.asyncio
async def test_answer_refusals():
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        wid = await _create_workspace(client)
        await _create_session(client, wid, "agent_a")
        ask_id = await _raise_ask(client, wid, "agent_a")

        r = await client.post(f"/v1/workspaces/{wid}/asks/{ask_id}",
                              json={"answer": "ask"})
        assert r.status_code == 422

        r = await client.post(f"/v1/workspaces/{wid}/asks/{ask_id}",
                              json={
                                  "answer": "deny",
                                  "scope": "session"
                              })
        assert r.status_code == 422

        r = await client.post(f"/v1/workspaces/{wid}/asks/nope",
                              json={"answer": "allow"})
        assert r.status_code == 404

        r = await client.post(f"/v1/workspaces/{wid}/asks/{ask_id}",
                              json={"answer": "allow"})
        assert r.status_code == 200
        r = await client.post(f"/v1/workspaces/{wid}/asks/{ask_id}",
                              json={"answer": "allow"})
        assert r.status_code == 409

        r = await client.get("/v1/workspaces/nope/asks")
        assert r.status_code == 404

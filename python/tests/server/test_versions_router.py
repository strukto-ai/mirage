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


def _client(tmp_path):
    app = build_app(idle_grace_seconds=30.0,
                    version_root=str(tmp_path / "repos"))
    return AsyncClient(transport=ASGITransport(app=app),
                       base_url="http://test")


async def _create_ws(client) -> str:
    r = await client.post("/v1/workspaces", json=_minimal_config())
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _write(client, wid: str, command: str) -> None:
    r = await client.post(f"/v1/workspaces/{wid}/execute",
                          json={"command": command})
    assert r.status_code == 200, r.text


async def _cat(client, wid: str, path: str) -> str:
    r = await client.post(f"/v1/workspaces/{wid}/execute",
                          json={"command": f"cat {path}"})
    assert r.status_code == 200, r.text
    return r.json()["stdout"]


@pytest.mark.asyncio
async def test_commit_log_checkout_flow(tmp_path):
    async with _client(tmp_path) as client:
        wid = await _create_ws(client)
        await _write(client, wid, "echo v1 > /notes.txt")

        r = await client.post(f"/v1/workspaces/{wid}/commit",
                              json={"message": "first"})
        assert r.status_code == 200, r.text
        v1 = r.json()["version"]
        assert r.json()["branch"] == "main"

        await _write(client, wid, "echo v2 > /notes.txt")
        r = await client.post(f"/v1/workspaces/{wid}/commit",
                              json={"message": "second"})
        assert r.status_code == 200, r.text

        r = await client.get(f"/v1/workspaces/{wid}/versions")
        assert r.status_code == 200
        log = r.json()
        assert [e["message"] for e in log] == ["second", "first"]

        assert await _cat(client, wid, "/notes.txt") == "v2\n"
        r = await client.post(f"/v1/workspaces/{wid}/checkout",
                              json={"ref": v1})
        assert r.status_code == 200, r.text
        assert await _cat(client, wid, "/notes.txt") == "v1\n"


@pytest.mark.asyncio
async def test_diff_endpoint_follows_git(tmp_path):
    async with _client(tmp_path) as client:
        wid = await _create_ws(client)
        await _write(client, wid, "echo one > /a.txt")
        r = await client.post(f"/v1/workspaces/{wid}/commit",
                              json={"message": "first"})
        v1 = r.json()["version"]

        await _write(client, wid, "echo two > /a.txt")
        await _write(client, wid, "echo new > /b.txt")
        r = await client.post(f"/v1/workspaces/{wid}/commit",
                              json={"message": "second"})
        v2 = r.json()["version"]

        r = await client.get(f"/v1/workspaces/{wid}/diff",
                             params={
                                 "a": v1,
                                 "b": v2
                             })
        assert r.status_code == 200, r.text
        assert r.json()["modified"] == ["a.txt"]
        assert r.json()["added"] == ["b.txt"]

        await _write(client, wid, "echo three > /a.txt")
        r = await client.get(f"/v1/workspaces/{wid}/diff", params={"a": v2})
        assert r.status_code == 200, r.text
        assert r.json()["modified"] == ["a.txt"]

        r = await client.get(f"/v1/workspaces/{wid}/diff")
        assert r.status_code == 200, r.text
        assert r.json()["modified"] == ["a.txt"]


@pytest.mark.asyncio
async def test_diff_bad_ref_404(tmp_path):
    async with _client(tmp_path) as client:
        wid = await _create_ws(client)
        await _write(client, wid, "echo x > /x.txt")
        await client.post(f"/v1/workspaces/{wid}/commit", json={})
        r = await client.get(f"/v1/workspaces/{wid}/diff",
                             params={"a": "deadbeef" * 5})
        assert r.status_code == 404


@pytest.mark.asyncio
async def test_branch_endpoint_diverges(tmp_path):
    async with _client(tmp_path) as client:
        wid = await _create_ws(client)
        await _write(client, wid, "echo one > /a.txt")
        r = await client.post(f"/v1/workspaces/{wid}/commit",
                              json={"message": "first"})
        v1 = r.json()["version"]

        r = await client.post(f"/v1/workspaces/{wid}/branch",
                              json={"name": "exp"})
        assert r.status_code == 201, r.text
        assert r.json()["branch"] == "exp"
        assert r.json()["version"] == v1

        await _write(client, wid, "echo two > /a.txt")
        r = await client.post(f"/v1/workspaces/{wid}/commit",
                              json={
                                  "message": "on exp",
                                  "branch": "exp"
                              })
        assert r.status_code == 200, r.text

        exp_log = (await client.get(f"/v1/workspaces/{wid}/versions",
                                    params={"branch": "exp"})).json()
        main_log = (await client.get(f"/v1/workspaces/{wid}/versions",
                                     params={"branch": "main"})).json()
        assert [e["message"] for e in exp_log] == ["on exp", "first"]
        assert [e["message"] for e in main_log] == ["first"]


@pytest.mark.asyncio
async def test_branch_duplicate_409(tmp_path):
    async with _client(tmp_path) as client:
        wid = await _create_ws(client)
        await _write(client, wid, "echo x > /x.txt")
        await client.post(f"/v1/workspaces/{wid}/commit", json={})
        await client.post(f"/v1/workspaces/{wid}/branch", json={"name": "exp"})
        r = await client.post(f"/v1/workspaces/{wid}/branch",
                              json={"name": "exp"})
        assert r.status_code == 409


@pytest.mark.asyncio
async def test_branch_from_missing_404(tmp_path):
    async with _client(tmp_path) as client:
        wid = await _create_ws(client)
        await _write(client, wid, "echo x > /x.txt")
        await client.post(f"/v1/workspaces/{wid}/commit", json={})
        r = await client.post(f"/v1/workspaces/{wid}/branch",
                              json={
                                  "name": "exp",
                                  "from_branch": "ghost"
                              })
        assert r.status_code == 404


@pytest.mark.asyncio
async def test_commit_unknown_branch_404(tmp_path):
    async with _client(tmp_path) as client:
        wid = await _create_ws(client)
        await _write(client, wid, "echo x > /x.txt")
        await client.post(f"/v1/workspaces/{wid}/commit", json={})
        r = await client.post(f"/v1/workspaces/{wid}/commit",
                              json={"branch": "ghost"})
        assert r.status_code == 404


@pytest.mark.asyncio
async def test_clone_from_version_creates_new_workspace(tmp_path):
    async with _client(tmp_path) as client:
        wid = await _create_ws(client)
        await _write(client, wid, "echo base > /b.txt")
        r = await client.post(f"/v1/workspaces/{wid}/commit",
                              json={"message": "base"})
        version = r.json()["version"]

        r = await client.post("/v1/workspaces/clone",
                              json={
                                  "source_id": wid,
                                  "at": version
                              })
        assert r.status_code == 201, r.text
        new_id = r.json()["id"]
        assert new_id != wid
        assert await _cat(client, new_id, "/b.txt") == "base\n"


@pytest.mark.asyncio
async def test_clone_live_workspace(tmp_path):
    async with _client(tmp_path) as client:
        wid = await _create_ws(client)
        await _write(client, wid, "echo live > /l.txt")

        r = await client.post("/v1/workspaces/clone", json={"source_id": wid})
        assert r.status_code == 201, r.text
        new_id = r.json()["id"]
        assert new_id != wid
        assert await _cat(client, new_id, "/l.txt") == "live\n"


@pytest.mark.asyncio
async def test_log_empty_when_no_commits(tmp_path):
    async with _client(tmp_path) as client:
        wid = await _create_ws(client)
        r = await client.get(f"/v1/workspaces/{wid}/versions")
        assert r.status_code == 200
        assert r.json() == []


@pytest.mark.asyncio
async def test_commit_unknown_workspace_404(tmp_path):
    async with _client(tmp_path) as client:
        r = await client.post("/v1/workspaces/nope/commit", json={})
        assert r.status_code == 404


@pytest.mark.asyncio
async def test_checkout_bad_ref_404(tmp_path):
    async with _client(tmp_path) as client:
        wid = await _create_ws(client)
        await _write(client, wid, "echo x > /x.txt")
        await client.post(f"/v1/workspaces/{wid}/commit", json={})
        r = await client.post(f"/v1/workspaces/{wid}/checkout",
                              json={"ref": "deadbeef" * 5})
        assert r.status_code == 404


@pytest.mark.asyncio
async def test_clone_duplicate_id_409(tmp_path):
    async with _client(tmp_path) as client:
        wid = await _create_ws(client)
        r = await client.post("/v1/workspaces/clone",
                              json={
                                  "source_id": wid,
                                  "id": wid
                              })
        assert r.status_code == 409

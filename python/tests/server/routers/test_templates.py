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


from collections.abc import AsyncIterator

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from mirage.resources.memory import memory_resource_store
from mirage.resources.types import EntryInput, Policy, TemplateInput
from mirage.server import build_app
from mirage.server.resources.files import files_resource_store

RAM = {"mounts": {"/": {"vfs": "ram", "mode": "WRITE"}}}
TWO = {
    "mounts": {
        "/": {"vfs": "ram", "mode": "WRITE"},
        "/extra": {"vfs": "ram", "mode": "WRITE"},
    }
}


@pytest.fixture
def app() -> FastAPI:
    return build_app(
        idle_grace_seconds=10.0, resource_store=memory_resource_store()
    )


@pytest_asyncio.fixture
async def client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c


@pytest.mark.asyncio
async def test_a_template_is_saved_listed_deleted_and_restored(client):
    r = await client.post(
        "/v1/templates",
        json={"name": "base", "description": "ram only", "config": RAM},
    )
    assert r.status_code == 201, r.text
    saved = {"name": "base", "description": "ram only", "config": RAM}
    assert r.json() == saved
    r = await client.post(
        "/v1/templates", json={"name": "base", "config": RAM}
    )
    assert r.status_code == 409
    assert (await client.get("/v1/templates")).json() == {"items": [saved]}
    assert (await client.get("/v1/templates/base")).json() == saved
    assert (await client.delete("/v1/templates/base")).status_code == 204
    assert (await client.get("/v1/templates/base")).status_code == 404
    r = await client.post("/v1/templates/base/restore")
    assert r.status_code == 200
    assert r.json() == saved
    r = await client.post("/v1/templates/base/restore")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_a_template_is_checked_when_saved(client):
    bad = {"name": "bad", "config": {"mounts": {"/": {"vfs": "ram"}}, "x": 1}}
    assert (await client.post("/v1/templates", json=bad)).status_code == 400
    r = await client.post("/v1/templates", json={"name": "Bad", "config": RAM})
    assert r.status_code == 400
    typo = {"name": "typo", "descripton": "d", "config": RAM}
    assert (await client.post("/v1/templates", json=typo)).status_code == 400
    pinned = {"name": "pinned", "config": {**RAM, "workspace_id": "one"}}
    assert (await client.post("/v1/templates", json=pinned)).status_code == 400
    unpinned = {"name": "unpinned", "config": {**RAM, "workspace_id": None}}
    r = await client.post("/v1/templates", json=unpinned)
    assert r.status_code == 201
    listed = (await client.get("/v1/templates")).json()["items"]
    names = [t["name"] for t in listed]
    assert names == ["unpinned"]


@pytest.mark.asyncio
async def test_a_workspace_is_created_from_a_copy_of_a_template(app, client):
    await client.post("/v1/templates", json={"name": "base", "config": RAM})
    r = await client.post(
        "/v1/workspaces", json={"id": "from-t", "template": "base"}
    )
    assert r.status_code == 201, r.text
    assert [m["prefix"] for m in r.json()["mounts"]] == ["/"]
    await app.state.resources.put_template(
        TemplateInput(name="base", config=TWO)
    )
    r = await client.get("/v1/workspaces/from-t")
    assert [m["prefix"] for m in r.json()["mounts"]] == ["/"]
    await client.delete("/v1/workspaces/from-t")


def _named(ref: str) -> dict:
    root = {"from": "strukto", "ref": ref, "key": "root"}
    return {
        "mounts": {
            "/": {"vfs": "ram", "mode": "WRITE"},
            "/host": {"vfs": "disk", "config": {"root": root}},
        }
    }


@pytest.mark.asyncio
async def test_a_template_builds_from_a_saved_connection(
    app, client, tmp_path
):
    (tmp_path / "hi.txt").write_text("hello\n")
    await app.state.resources.create_entry(
        "vfs",
        EntryInput(
            name="box", type="disk", fields={}, sealed={"root": str(tmp_path)}
        ),
    )
    await client.post(
        "/v1/templates", json={"name": "boxed", "config": _named("box")}
    )
    r = await client.post(
        "/v1/workspaces", json={"id": "boxed", "template": "boxed"}
    )
    assert r.status_code == 201, r.text
    ran = await client.post(
        "/v1/workspaces/boxed/shell", json={"command": "cat /host/hi.txt"}
    )
    assert ran.json()["stdout"] == "hello\n"
    await client.delete("/v1/workspaces/boxed")
    r = await client.post("/v1/workspaces", json={"config": _named("gone")})
    assert r.status_code == 400
    assert (
        r.json()["error"]["message"]
        == "gone is not saved as a VFS, CLI, runtime or machine"
    )


@pytest.mark.asyncio
async def test_a_template_runs_the_saved_policy_it_names(app, client):
    await app.state.resources.create_policy(
        Policy(
            name="guard.py",
            source=(
                "def pre_command(ctx):\n"
                '    if ctx["command"] == "rm":\n'
                '        return {"kind": "deny", '
                '"reason": "deletes are disabled"}\n'
            ),
        )
    )
    reviewer = {"policy": {"pre_command": [{"script": "guard.py"}]}}
    config = {
        "mounts": {"/": {"vfs": "ram", "mode": "WRITE"}},
        "profiles": {"reviewer": reviewer},
        "profile": "reviewer",
    }
    await client.post(
        "/v1/templates", json={"name": "guarded", "config": config}
    )
    r = await client.post(
        "/v1/workspaces", json={"id": "guarded", "template": "guarded"}
    )
    assert r.status_code == 201, r.text
    try:
        ran = await client.post(
            "/v1/workspaces/guarded/shell",
            json={"command": "touch /a && rm /a"},
        )
        assert ran.json()["refusal"]["reason"] == "deletes are disabled"
    finally:
        await client.delete("/v1/workspaces/guarded")


@pytest.mark.asyncio
async def test_a_managed_env_entry_reads_a_saved_field(app, client):
    await app.state.resources.create_entry(
        "vfs",
        EntryInput(
            name="gh",
            type="github",
            fields={"owner": "o"},
            sealed={"token": "t"},
        ),
    )
    env = {
        name: {"from": "strukto", "ref": "gh", "key": key, "readonly": True}
        for name, key in (("TOKEN", "token"), ("OWNER", "owner"))
    }
    config = {"mounts": {"/": {"vfs": "ram", "mode": "WRITE"}}, "env": env}
    r = await client.post(
        "/v1/workspaces", json={"id": "envd", "config": config}
    )
    assert r.status_code == 201, r.text
    ran = await client.post(
        "/v1/workspaces/envd/shell", json={"command": "echo $TOKEN $OWNER"}
    )
    assert ran.json()["stdout"] == "t o\n"
    await client.delete("/v1/workspaces/envd")


@pytest.mark.asyncio
async def test_a_create_names_one_known_template_or_a_config(app, client):
    r = await client.post("/v1/workspaces", json={"template": "nope"})
    assert r.status_code == 404
    await client.post("/v1/templates", json={"name": "base", "config": RAM})
    r = await client.post(
        "/v1/workspaces", json={"template": "base", "config": RAM}
    )
    assert r.status_code == 400
    assert (
        r.json()["error"]["message"] == "give a template or a config, not both"
    )
    assert (await client.post("/v1/workspaces", json={})).status_code == 400
    r = await client.post("/v1/workspaces", json={"template": ["base"]})
    assert r.status_code == 400
    await app.state.resources.put_template(
        TemplateInput(name="pinned", config={**RAM, "workspace_id": "one"})
    )
    r = await client.post("/v1/workspaces", json={"template": "pinned"})
    assert r.status_code == 400
    r = await client.post(
        "/v1/workspaces?explain=true", json={"template": "base"}
    )
    assert r.status_code == 200
    assert r.json()["outcome"] == "allow"


@pytest.mark.asyncio
async def test_a_server_of_many_accounts_keeps_no_templates(app, client):
    app.state.registry.accounts_required = True
    assert (await client.get("/v1/templates")).status_code == 501
    r = await client.post("/v1/templates", json={"name": "t", "config": RAM})
    assert r.status_code == 501
    r = await client.post("/v1/workspaces", json={"template": "t"})
    assert r.status_code == 501


@pytest.mark.asyncio
async def test_a_broken_record_lists_as_a_bad_request(tmp_path):
    (tmp_path / "template").mkdir()
    (tmp_path / "template" / "bad.yaml").write_text("config: [\n")
    app = build_app(
        idle_grace_seconds=10.0, resource_store=files_resource_store(tmp_path)
    )
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        assert (await c.get("/v1/templates")).status_code == 400

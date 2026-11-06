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
from mirage.resources.types import TemplateInput
from mirage.server import build_app

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
    assert (await client.get("/v1/templates")).json() == [saved]
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
    assert (await client.post("/v1/templates", json=bad)).status_code == 422
    r = await client.post("/v1/templates", json={"name": "Bad", "config": RAM})
    assert r.status_code == 400
    assert (await client.get("/v1/templates")).json() == []


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


@pytest.mark.asyncio
async def test_a_create_names_one_known_template_or_a_config(client):
    r = await client.post("/v1/workspaces", json={"template": "nope"})
    assert r.status_code == 404
    await client.post("/v1/templates", json={"name": "base", "config": RAM})
    r = await client.post(
        "/v1/workspaces", json={"template": "base", "config": RAM}
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "give a template or a config, not both"
    assert (await client.post("/v1/workspaces", json={})).status_code == 400
    r = await client.post(
        "/v1/workspaces?explain=true", json={"template": "base"}
    )
    assert r.status_code == 200
    assert r.json()["outcome"] == "allow"

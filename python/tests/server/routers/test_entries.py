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

from mirage.resources.base import ResourceStore
from mirage.resources.memory import memory_resource_store
from mirage.resources.types import TemplateInput
from mirage.server import build_app

GITHUB = {
    "name": "github",
    "type": "github",
    "fields": {"owner": "strukto-ai", "repo": "mirage", "token": "ghp_x"},
}


@pytest.fixture
def store() -> ResourceStore:
    return memory_resource_store()


@pytest.fixture
def app(store: ResourceStore) -> FastAPI:
    return build_app(idle_grace_seconds=10.0, resource_store=store)


@pytest_asyncio.fixture
async def client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c


@pytest.mark.asyncio
async def test_an_entry_answers_its_sealed_fields_by_name_only(client, store):
    r = await client.post("/v1/vfs", json=GITHUB)
    assert r.status_code == 201, r.text
    created = r.json()
    assert created["config"] == {"owner": "strukto-ai", "repo": "mirage"}
    assert "ghp_x" not in r.text
    assert created["id"] == "github"
    assert created["kind"] == "vfs"
    assert created["builtin"] is False
    r = await client.get("/v1/vfs/github")
    assert r.json()["sealed"] == ["token"]
    assert "ghp_x" not in r.text
    listed = (await client.get("/v1/vfs")).json()["items"]
    assert [i["name"] for i in listed] == ["github"]
    assert listed[0]["used_by"] == 0
    assert "sealed" not in listed[0]
    assert "ghp_x" not in str(listed)
    revealed = await store.reveal_entry("vfs", "github")
    assert revealed.sealed == {"token": "ghp_x"}


@pytest.mark.asyncio
async def test_a_name_is_taken_once_across_kinds(client):
    assert (await client.post("/v1/vfs", json=GITHUB)).status_code == 201
    r = await client.post("/v1/vfs", json=GITHUB)
    assert r.status_code == 409
    assert r.json()["error"]["message"] == "github already exists"
    gh = {"name": "github", "type": "gh", "fields": {"token": "t"}}
    assert (await client.post("/v1/clis", json=gh)).status_code == 409


@pytest.mark.asyncio
async def test_an_entry_answers_only_under_its_kind(client):
    await client.post("/v1/vfs", json=GITHUB)
    r = await client.get("/v1/clis/github")
    assert r.status_code == 404
    assert r.json()["error"]["message"] == "CLI not found"


@pytest.mark.asyncio
async def test_put_keeps_a_sealed_field_left_out_and_null_removes_it(
    client, store
):
    await client.post("/v1/vfs", json=GITHUB)
    r = await client.put("/v1/vfs/github", json={"fields": {"owner": "o"}})
    assert r.status_code == 200, r.text
    assert r.json()["config"] == {"owner": "o"}
    assert (await store.reveal_entry("vfs", "github")).sealed == {
        "token": "ghp_x"
    }
    r = await client.put("/v1/vfs/github", json={"fields": {"token": "ghp_y"}})
    assert (await store.reveal_entry("vfs", "github")).sealed == {
        "token": "ghp_y"
    }
    r = await client.put(
        "/v1/vfs/github", json={"fields": {"owner": "o", "token": None}}
    )
    assert r.status_code == 400
    assert r.json()["error"]["message"] == "token is required"
    await client.post(
        "/v1/clis",
        json={
            "name": "mcp1",
            "type": "mcp",
            "fields": {
                "url": "https://mcp.example.com",
                "auth.type": "bearer",
                "auth.token": "s",
            },
        },
    )
    r = await client.put(
        "/v1/clis/mcp1",
        json={
            "fields": {"url": "https://mcp.example.com", "auth.token": None}
        },
    )
    assert r.status_code == 200, r.text
    assert (await client.get("/v1/clis/mcp1")).json()["sealed"] == []


@pytest.mark.asyncio
async def test_fields_are_checked_against_the_type(client):
    cases = [
        ({"type": "nope", "fields": {}}, "type must be a vfs: "),
        (
            {"type": "github", "fields": {"owner": "o"}},
            "token is required",
        ),
        (
            {"type": "github", "fields": {"token": "t", "x": 1}},
            "github has no field x; it takes ",
        ),
        (
            {"type": "github", "fields": {"token": "t", "timeout": "1"}},
            "timeout must be a number",
        ),
        ({"type": "github", "fields": []}, "fields must be an object"),
    ]
    for body, detail in cases:
        r = await client.post("/v1/vfs", json={"name": "x", **body})
        assert r.status_code == 400, body
        assert r.json()["error"]["message"].startswith(detail), r.json()
    r = await client.post(
        "/v1/clis",
        json={"name": "m", "type": "mcp", "fields": {"url": "http://a.b"}},
    )
    assert (
        r.json()["error"]["message"]
        == "url must be the MCP server's https URL"
    )
    r = await client.post("/v1/vfs", json={**GITHUB, "name": "sec_x"})
    assert r.status_code == 400
    assert "not look like an id" in r.json()["error"]["message"]


@pytest.mark.asyncio
async def test_a_pointer_is_refused_until_its_store_is_saved(client):
    pointer = {"from": "aws", "ref": "gh", "key": "token"}
    body = {**GITHUB, "fields": {"token": pointer}}
    r = await client.post("/v1/vfs", json=body)
    assert r.status_code == 400
    assert r.json() == {
        "error": {
            "code": "invalid_request",
            "message": "add aws under Secret stores first",
            "missing": ["aws"],
        }
    }
    r = await client.get("/v1/stores")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_delete_wipes_and_is_refused_while_a_template_uses_it(
    client, store
):
    await client.post("/v1/vfs", json=GITHUB)
    config = {
        "mounts": {
            "/gh": {
                "vfs": "github",
                "config": {
                    "token": {
                        "from": "strukto",
                        "ref": "github",
                        "key": "token",
                    }
                },
            }
        }
    }
    await store.put_template(TemplateInput(name="agent", config=config))
    assert (await client.get("/v1/vfs")).json()["items"][0]["used_by"] == 1
    r = await client.delete("/v1/vfs/github")
    assert r.status_code == 409
    assert r.json()["error"]["message"] == "github is used by agent"
    await store.delete_template("agent")
    assert (await client.delete("/v1/vfs/github")).status_code == 204
    assert (await client.get("/v1/vfs/github")).status_code == 404
    assert (await client.delete("/v1/vfs/github")).status_code == 404
    await client.post("/v1/vfs", json={**GITHUB, "fields": {"token": "n"}})
    assert (await store.reveal_entry("vfs", "github")).sealed == {"token": "n"}


@pytest.mark.asyncio
async def test_list_filters_by_type_and_name(client):
    await client.post("/v1/vfs", json=GITHUB)
    await client.post(
        "/v1/vfs",
        json={"name": "work-gh", "type": "github", "fields": {"token": "t"}},
    )
    await client.post(
        "/v1/vfs",
        json={"name": "notes", "type": "notion", "fields": {"api_key": "k"}},
    )

    async def names(query: str) -> list[str]:
        items = (await client.get(f"/v1/vfs{query}")).json()["items"]
        return [i["name"] for i in items]

    assert await names("") == ["github", "notes", "work-gh"]
    assert await names("?type=github") == ["github", "work-gh"]
    assert await names("?q=GH") == ["work-gh"]
    assert await names("?q=%20&type=") == ["github", "notes", "work-gh"]


@pytest.mark.asyncio
async def test_types_are_read_off_the_config_schemas(client):
    vfs = (await client.get("/v1/vfs/types")).json()
    token = next(f for f in vfs["github"] if f["name"] == "token")
    assert token == {
        "name": "token",
        "type": "string",
        "secret": True,
        "required": True,
    }
    assert "ram" not in vfs
    clis = (await client.get("/v1/clis/types")).json()
    assert "git" not in clis
    auth = {f["name"]: f for f in clis["mcp"]}["auth.type"]
    assert auth["group"] == "auth"
    assert auth["options"] == ["bearer", "header"]
    machines = (await client.get("/v1/machines/types")).json()
    key = {f["name"]: f for f in machines["daytona"]}["api_key"]
    assert key["secret"] is True
    ssh = {f["name"]: f for f in machines["ssh"]}
    assert ssh["host"]["type"] == "string"
    assert ssh["host"]["required"] is True
    assert ssh["port"]["type"] == "number"
    assert ssh["port"]["required"] is False
    assert ssh["timeout"]["default"] == 30
    assert ssh["mount_type"]["options"] == ["ssh", "fuse", "both"]
    assert ssh["private_key"]["secret"] is True
    assert "env" not in ssh


@pytest.mark.asyncio
async def test_a_machine_is_checked_against_its_field_types(client):
    made = await client.post(
        "/v1/machines",
        json={
            "name": "box",
            "type": "ssh",
            "fields": {"host": "h", "port": 2222},
        },
    )
    assert made.status_code == 201, made.text
    assert made.json()["config"] == {"host": "h", "port": 2222}
    hostless = await client.post(
        "/v1/machines",
        json={"name": "box2", "type": "ssh", "fields": {"port": 22}},
    )
    assert hostless.status_code == 400


@pytest.mark.asyncio
async def test_a_machine_keeps_its_credential_sealed(client):
    r = await client.post(
        "/v1/machines",
        json={
            "name": "dt",
            "type": "daytona",
            "fields": {"sandbox_id": "s1", "api_key": "k"},
        },
    )
    assert r.status_code == 201, r.text
    assert r.json()["config"] == {"sandbox_id": "s1"}


@pytest.mark.asyncio
async def test_a_runtime_answers_with_captures(client):
    r = await client.post(
        "/v1/runtimes",
        json={"name": "py", "type": "monty", "fields": {}},
    )
    assert r.status_code == 201, r.text
    assert r.json()["captures"] == []

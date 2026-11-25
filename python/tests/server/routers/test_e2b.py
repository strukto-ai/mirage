import asyncio
import time
from contextlib import asynccontextmanager

import jwt
import pytest
from httpx import ASGITransport, AsyncClient

from mirage.policy.base import Policy
from mirage.policy.types import Deny
from mirage.resources.memory import memory_resource_store
from mirage.resources.types import TemplateInput
from mirage.server.app import build_app
from mirage.server.auth import AuthConfig, AuthMode, JWTConfig

TEMPLATE = "approved"
KEY = {"X-API-Key": "server-key"}
TOKEN = AuthConfig(mode=AuthMode.TOKEN, bearer_token=KEY["X-API-Key"])
CREATE = "/v2/sandboxes"
SECRET = "e2b-test-key-with-at-least-32-bytes"


@asynccontextmanager
async def server(tmp_path, **kwargs):
    resources = memory_resource_store()
    await resources.create_template(
        TemplateInput(
            name=TEMPLATE,
            config={
                "mounts": {"/home/user": {"vfs": "ram", "mode": "WRITE"}},
                "store": {"type": "disk", "root": str(tmp_path / "named")},
            },
        )
    )
    app = build_app(
        state_root=tmp_path / "daemon", resource_store=resources, **kwargs
    )
    async with (
        app.router.lifespan_context(app),
        AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client,
    ):
        yield app, client


def account_key(account):
    return jwt.encode(
        {"sub": account, "exp": int(time.time()) + 60},
        SECRET,
        algorithm="HS256",
    )


@pytest.mark.asyncio
async def test_opt_in_and_api_key_scope(tmp_path, monkeypatch):
    monkeypatch.delenv("MIRAGE_E2B_TEMPLATE", raising=False)
    async with server(tmp_path) as (_, client):
        assert (await client.post(CREATE, headers=KEY)).status_code == 404
    monkeypatch.setenv("MIRAGE_E2B_TEMPLATE", TEMPLATE)
    async with server(tmp_path) as (_, client):
        for headers in ({}, KEY):
            response = await client.post(CREATE, headers=headers)
            assert response.status_code == 401
            assert response.json() == {"code": 401, "message": "unauthorized"}
        assert (await client.get("/v1/workspaces")).status_code == 200
    async with server(tmp_path, auth_config=TOKEN) as (_, client):
        bearer = {"Authorization": "Bearer server-key"}
        response = await client.post(CREATE, headers=bearer)
        assert response.status_code == 401
        assert response.json()["code"] == 401
        response = await client.post(CREATE, headers={"X-API-Key": "wrong"})
        assert response.status_code == 401
        response = await client.get("/v1/workspaces", headers=KEY)
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "unauthorized"
        assert (await client.get("/v1/workspaces", headers=bearer)).is_success


@pytest.mark.asyncio
async def test_lifecycle_uses_template_capacity_and_owner(tmp_path):
    auth = AuthConfig(
        mode=AuthMode.JWT, jwt=JWTConfig(algorithm="HS256", key=SECRET)
    )
    async with server(
        tmp_path, e2b_template=TEMPLATE, auth_config=auth, max_workspaces=1
    ) as (app, client):
        alice_key = account_key("alice")
        alice = {"X-API-Key": alice_key}
        bob = {"X-API-Key": account_key("bob")}
        native = {"Authorization": f"Bearer {alice_key}"}
        response = await client.post(
            CREATE, headers=alice, json={"templateID": "unapproved"}
        )
        assert response.status_code == 404
        assert response.json()["code"] == 404
        response = await client.post(
            CREATE,
            headers=alice,
            json={"templateID": "base", "envVars": {"TEST": "value"}},
        )
        assert response.status_code == 201, response.text
        created = response.json()
        wid = created["sandboxID"]
        assert created["templateID"] == TEMPLATE
        assert created["clientID"]
        assert created["envdVersion"] == "0.5.6"
        assert created["envdAccessToken"]
        assert app.state.e2b.live(wid).env_vars == {"TEST": "value"}
        assert app.state.e2b.live(wid).session_id
        response = await client.get(f"/v1/workspaces/{wid}", headers=native)
        assert response.status_code == 200
        assert "/home/user/" in [
            mount["prefix"] for mount in response.json()["mounts"]
        ]
        assert (await client.post(CREATE, headers=alice)).status_code == 503
        connect = f"{CREATE}/{wid}/connect"
        kill = f"/sandboxes/{wid}"
        assert (await client.post(connect, headers=bob)).status_code == 404
        assert (await client.delete(kill, headers=bob)).status_code == 404
        response = await client.post(connect, headers=alice)
        assert response.status_code == 200
        assert response.json() == created
        assert (await client.delete(kill, headers=alice)).status_code == 204
        assert (await client.delete(kill, headers=alice)).status_code == 404
        assert (await client.post(connect, headers=alice)).status_code == 404
        assert (
            await client.get(f"/v1/workspaces/{wid}", headers=native)
        ).status_code == 404
        created_again = await client.post(
            CREATE, headers=alice, json={"templateID": TEMPLATE}
        )
        assert created_again.status_code == 201
        live_at_shutdown = created_again.json()["sandboxID"]
        assert live_at_shutdown != wid
        assert (
            created_again.json()["envdAccessToken"]
            != created["envdAccessToken"]
        )
        assert list(tmp_path.iterdir()) == []

    async with server(tmp_path, e2b_template=TEMPLATE, auth_config=auth) as (
        _,
        client,
    ):
        assert (
            await client.post(
                f"/v1/workspaces/{live_at_shutdown}/start", headers=native
            )
        ).status_code == 404
        assert (
            await client.post(
                f"{CREATE}/{live_at_shutdown}/connect", headers=alice
            )
        ).status_code == 404
        assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
async def test_reconnect_only_extends_and_expiry_removes_workspace(tmp_path):
    async with server(
        tmp_path, e2b_template=TEMPLATE, auth_config=TOKEN, max_workspaces=1
    ) as (app, client):
        created = await client.post(CREATE, headers=KEY, json={"timeout": 1})
        wid = created.json()["sandboxID"]
        connect = f"{CREATE}/{wid}/connect"
        await asyncio.sleep(0.2)
        assert (
            await client.post(connect, headers=KEY, json={"timeout": 2})
        ).status_code == 200
        assert (
            await client.post(connect, headers=KEY, json={"timeout": 1})
        ).status_code == 200
        await asyncio.sleep(1.1)
        assert wid in app.state.registry
        async with asyncio.timeout(3):
            while wid in app.state.registry:
                await asyncio.sleep(0.01)
        assert (await client.post(connect, headers=KEY)).status_code == 404
        assert (await client.post(CREATE, headers=KEY)).status_code == 201


@pytest.mark.asyncio
async def test_lifecycle_validates_sdk_input(tmp_path):
    async with server(tmp_path, e2b_template=TEMPLATE, auth_config=TOKEN) as (
        _,
        client,
    ):
        for timeout in (0, -1, True, None, "1", 1.5, 2**53):
            response = await client.post(
                CREATE, headers=KEY, json={"timeout": timeout}
            )
            assert response.status_code == 400
            assert response.json()["code"] == 400
        response = await client.post(
            CREATE, headers=KEY, json={"envVars": {"TEST": 1}}
        )
        assert response.status_code == 400


class DenyCreation(Policy):
    async def pre_workspace(self, ctx):
        return Deny("creation is disabled")


@pytest.mark.asyncio
async def test_lifecycle_respects_workspace_admission(tmp_path):
    async with server(
        tmp_path,
        e2b_template=TEMPLATE,
        auth_config=TOKEN,
        policies=[DenyCreation()],
    ) as (app, client):
        response = await client.post(CREATE, headers=KEY)
        assert response.status_code == 403
        assert response.json() == {
            "code": 403,
            "message": "creation is disabled",
        }
        assert not app.state.registry.list()

import asyncio
import base64
import json
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
PROCESS = "/process.Process/Start"
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


async def sandbox_headers(client, **options):
    created = await client.post(CREATE, headers=KEY, json=options)
    assert created.status_code == 201, created.text
    body = created.json()
    return {
        "e2b-sandbox-id": body["sandboxID"],
        "e2b-sandbox-port": "49983",
        "x-access-token": body["envdAccessToken"],
        "content-type": "application/connect+json",
        "authorization": "Basic dXNlcjo=",
    }


def start_body(command, **options):
    payload = json.dumps(
        {
            "process": {
                "cmd": "/bin/bash",
                "args": ["-l", "-c", command],
                **options,
            }
        }
    ).encode()
    return b"\0" + len(payload).to_bytes(4, "big") + payload


def envelopes(body):
    frames = []
    while body:
        size = int.from_bytes(body[1:5], "big")
        frames.append((body[0], json.loads(body[5 : 5 + size])))
        body = body[5 + size :]
    return frames


def output_of(response, stream):
    return b"".join(
        base64.b64decode(frame["event"]["data"][stream])
        for flags, frame in envelopes(response.content)
        if flags == 0 and stream in frame["event"].get("data", {})
    )


@pytest.mark.asyncio
async def test_process_streams_both_outputs_and_uses_per_call_environment(
    tmp_path,
):
    async with server(tmp_path, e2b_template=TEMPLATE, auth_config=TOKEN) as (
        _,
        client,
    ):
        headers = await sandbox_headers(
            client, envVars={"FROM_CREATE": "saved", "BOTH": "old"}
        )
        response = await client.post(
            PROCESS,
            content=start_body(
                'pwd; printf "%s/%s" "$FROM_CREATE" "$BOTH"; '
                "printf warning >&2; export ONLY_CALL=1; exit 7",
                envs={"BOTH": "new"},
            ),
            headers=headers,
        )
        assert response.status_code == 200
        assert response.headers["content-type"] == "application/connect+json"
        assert output_of(response, "stdout") == b"/home/user\nsaved/new"
        assert output_of(response, "stderr") == b"warning"
        frames = envelopes(response.content)
        assert frames[0][0] == 0 and frames[0][1]["event"]["start"]["pid"] > 0
        assert frames[-2] == (
            0,
            {
                "event": {
                    "end": {"exitCode": 7, "exited": True, "status": "exited"}
                }
            },
        )
        assert frames[-1] == (2, {})
        response = await client.post(
            PROCESS,
            content=start_body(
                'pwd; printf "%s/%s" "$BOTH" "$ONLY_CALL"', cwd="/"
            ),
            headers=headers,
        )
        assert output_of(response, "stdout") == b"/\nold/"


@pytest.mark.asyncio
async def test_process_requires_the_addressed_sandbox_token(tmp_path):
    async with server(tmp_path, e2b_template=TEMPLATE, auth_config=TOKEN) as (
        _,
        client,
    ):
        headers = await sandbox_headers(client)
        other = await sandbox_headers(client)
        good = start_body("printf OK")
        for changed in (
            {"x-access-token": ""},
            {"x-access-token": other["x-access-token"]},
            {"e2b-sandbox-id": "unknown"},
        ):
            response = await client.post(
                PROCESS, content=good, headers={**headers, **changed}
            )
            assert response.status_code == 401
            assert response.json()["code"] == "unauthenticated"
        response = await client.post(
            PROCESS,
            content=good,
            headers={**headers, "e2b-sandbox-port": "49999"},
        )
        assert response.status_code == 400
        assert response.json()["code"] == "invalid_argument"
        assert (
            await client.get("/v1/workspaces", headers=headers)
        ).status_code == 401
        assert (await client.get(PROCESS, headers=headers)).status_code == 401
        assert (
            await client.post(f"{PROCESS}/extra", headers=headers)
        ).status_code == 401
        assert (
            await client.post(PROCESS, content=good, headers=headers)
        ).status_code == 200
        sandbox_id = headers["e2b-sandbox-id"]
        assert (
            await client.delete(f"/sandboxes/{sandbox_id}", headers=KEY)
        ).status_code == 204
        assert (
            await client.post(PROCESS, content=good, headers=headers)
        ).status_code == 401


@pytest.mark.asyncio
async def test_process_checks_lease_again_after_the_upload(tmp_path):
    async with server(tmp_path, e2b_template=TEMPLATE, auth_config=TOKEN) as (
        _,
        client,
    ):
        headers = await sandbox_headers(client)
        path = f"/sandboxes/{headers['e2b-sandbox-id']}"
        command = start_body("printf ignored")

        async def upload():
            yield command[:4]
            assert (await client.delete(path, headers=KEY)).status_code == 204
            yield command[4:]

        response = await client.post(
            PROCESS, content=upload(), headers=headers
        )
        assert response.status_code == 401


@pytest.mark.asyncio
async def test_process_rejects_wrong_media_and_malformed_framing(tmp_path):
    async with server(tmp_path, e2b_template=TEMPLATE, auth_config=TOKEN) as (
        _,
        client,
    ):
        headers = await sandbox_headers(client)
        command = start_body("echo yes")
        response = await client.post(
            PROCESS,
            content=command,
            headers={**headers, "content-type": "application/json"},
        )
        assert response.status_code == 415
        response = await client.post(
            PROCESS, content=command[:-1], headers=headers
        )
        assert response.status_code == 400
        response = await client.post(
            PROCESS,
            content=command,
            headers={**headers, "connect-timeout-ms": "1.2"},
        )
        assert response.status_code == 400


@pytest.mark.asyncio
async def test_process_enforces_connect_deadline(tmp_path):
    async with server(tmp_path, e2b_template=TEMPLATE, auth_config=TOKEN) as (
        _,
        client,
    ):
        headers = await sandbox_headers(client)
        response = await client.post(
            PROCESS,
            content=start_body("printf ready; sleep 0.3; touch late"),
            headers={**headers, "connect-timeout-ms": "100"},
        )
        assert response.status_code == 200
        assert output_of(response, "stdout") == b"ready"
        assert envelopes(response.content)[-1] == (
            2,
            {
                "error": {
                    "code": "deadline_exceeded",
                    "message": "command deadline exceeded",
                }
            },
        )
        await asyncio.sleep(0.3)
        response = await client.post(
            PROCESS, content=start_body("test ! -e late"), headers=headers
        )
        assert (
            envelopes(response.content)[-2][1]["event"]["end"]["exitCode"] == 0
        )


@pytest.mark.asyncio
async def test_process_streams_before_completion_and_cancels_on_disconnect(
    tmp_path,
):
    async with server(tmp_path, e2b_template=TEMPLATE, auth_config=TOKEN) as (
        app,
        client,
    ):
        headers = await sandbox_headers(client)
        command = start_body("printf ready; sleep 0.3; touch disconnected")
        ready = asyncio.Event()
        received = iter(
            [
                {
                    "type": "http.request",
                    "body": command[:4],
                    "more_body": True,
                },
                {
                    "type": "http.request",
                    "body": command[4:],
                    "more_body": False,
                },
            ]
        )

        async def receive():
            message = next(received, None)
            if message is not None:
                return message
            await ready.wait()
            return {"type": "http.disconnect"}

        async def send(message):
            if message["type"] == "http.response.start":
                assert message["status"] == 200
                return
            for flags, payload in envelopes(message["body"]):
                assert flags == 0
                data = payload["event"].get("data")
                if data is not None:
                    assert base64.b64decode(data["stdout"]) == b"ready"
                    ready.set()

        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.4"},
            "method": "POST",
            "scheme": "http",
            "path": PROCESS,
            "query_string": b"",
            "headers": [
                (key.encode(), value.encode())
                for key, value in {**headers, "host": "test"}.items()
            ],
            "client": ("127.0.0.1", 10001),
            "server": ("test", 80),
        }
        async with asyncio.timeout(2):
            await app(scope, receive, send)
        assert ready.is_set()
        await asyncio.sleep(0.3)
        response = await client.post(
            PROCESS,
            content=start_body("test ! -e disconnected"),
            headers=headers,
        )
        assert (
            envelopes(response.content)[-2][1]["event"]["end"]["exitCode"] == 0
        )


class DenyTouch(Policy):
    async def pre_command(self, ctx):
        if ctx.command == "touch":
            return Deny("touch is disabled")


@pytest.mark.asyncio
async def test_process_respects_workspace_command_policy(tmp_path):
    async with server(
        tmp_path,
        e2b_template=TEMPLATE,
        auth_config=TOKEN,
        policies=[DenyTouch()],
    ) as (_, client):
        headers = await sandbox_headers(client)
        refused = await client.post(
            PROCESS, content=start_body("touch denied"), headers=headers
        )
        assert (
            envelopes(refused.content)[-2][1]["event"]["end"]["exitCode"] != 0
        )
        checked = await client.post(
            PROCESS, content=start_body("test ! -e denied"), headers=headers
        )
        assert (
            envelopes(checked.content)[-2][1]["event"]["end"]["exitCode"] == 0
        )

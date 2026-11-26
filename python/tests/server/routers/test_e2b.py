import asyncio
import base64

import pytest

from mirage.policy.base import Policy
from mirage.policy.types import Deny
from mirage.resources.memory import memory_resource_store
from mirage.resources.types import TemplateInput
from mirage.server.auth import AuthConfig, AuthMode, JWTConfig
from mirage.server.e2b.files import SandboxFiles
from mirage.workspace.dispatcher.dispatcher import Dispatcher
from mirage.workspace.files import Files
from tests.server.routers.e2b_test_support import (
    CREATE,
    KEY,
    NATIVE,
    PROCESS,
    SECRET,
    TEMPLATE,
    TOKEN,
    account_key,
    data_headers,
    envelopes,
    output_of,
    sandbox_headers,
    server,
    start_body,
)


@pytest.mark.asyncio
async def test_api_key_scope_and_explicit_disable(tmp_path, monkeypatch):
    monkeypatch.setenv("MIRAGE_E2B_TEMPLATE", TEMPLATE)
    async with server(tmp_path, e2b_template="") as (_, client):
        assert (await client.post(CREATE, headers=KEY)).status_code == 404
        assert (await client.get("/health")).status_code == 404
        assert (
            await client.post(
                "/sandboxes/missing/timeout", headers=KEY, json={"timeout": 1}
            )
        ).status_code == 404
    monkeypatch.delenv("MIRAGE_E2B_TEMPLATE")
    monkeypatch.delenv("MIRAGE_E2B_PORT", raising=False)
    async with server(tmp_path, e2b_port=None) as (app, client):
        assert app.state.e2b_app is None
        assert (await client.post(CREATE, headers=KEY)).status_code == 404
    async with server(tmp_path) as (_, client):
        for headers in ({}, KEY):
            response = await client.post(CREATE, headers=headers)
            assert response.status_code == 401
            assert response.json() == {"code": 401, "message": "unauthorized"}
        assert (await client.get(f"{NATIVE}/v1/workspaces")).status_code == 200
    async with server(tmp_path, auth_config=TOKEN) as (_, client):
        bearer = {"Authorization": "Bearer server-key"}
        response = await client.post(CREATE, headers=bearer)
        assert response.status_code == 401
        assert response.json()["code"] == 401
        response = await client.post(CREATE, headers={"X-API-Key": "wrong"})
        assert response.status_code == 401
        response = await client.get(f"{NATIVE}/v1/workspaces", headers=KEY)
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "unauthorized"
        assert (
            await client.get(f"{NATIVE}/v1/workspaces", headers=bearer)
        ).is_success
        assert (
            await client.get("/v1/workspaces", headers=bearer)
        ).status_code == 404
        assert (
            await client.post(NATIVE + CREATE, headers=bearer)
        ).status_code == 404


@pytest.mark.asyncio
async def test_environment_override_uses_the_saved_template(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("MIRAGE_E2B_TEMPLATE", f" {TEMPLATE} ")
    async with server(tmp_path, auth_config=TOKEN) as (_, client):
        created = await client.post(CREATE, headers=KEY)
        assert created.status_code == 201, created.text
        assert created.json()["templateID"] == TEMPLATE
    async with server(
        tmp_path, auth_config=TOKEN, resource_store=memory_resource_store()
    ) as (_, client):
        missing = await client.post(CREATE, headers=KEY)
        assert missing.status_code == 404
        assert missing.json()["code"] == 404


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
        response = await client.get(
            f"{NATIVE}/v1/workspaces/{wid}", headers=native
        )
        assert response.status_code == 200
        assert "/home/user/" in [
            mount["prefix"] for mount in response.json()["mounts"]
        ]
        assert (await client.post(CREATE, headers=alice)).status_code == 503
        connect = f"{CREATE}/{wid}/connect"
        kill = f"/sandboxes/{wid}"
        timeout = f"{kill}/timeout"
        assert (await client.post(connect, headers=bob)).status_code == 404
        assert (await client.delete(kill, headers=bob)).status_code == 404
        assert (
            await client.post(timeout, headers=bob, json={"timeout": 0})
        ).status_code == 404
        assert (
            await client.post(timeout, headers=alice, json={"timeout": 60})
        ).status_code == 204
        response = await client.post(connect, headers=alice)
        assert response.status_code == 200
        assert response.json() == created
        assert (await client.delete(kill, headers=alice)).status_code == 204
        assert (await client.delete(kill, headers=alice)).status_code == 404
        assert (await client.post(connect, headers=alice)).status_code == 404
        assert (
            await client.get(f"{NATIVE}/v1/workspaces/{wid}", headers=native)
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
                f"{NATIVE}/v1/workspaces/{live_at_shutdown}/start",
                headers=native,
            )
        ).status_code == 404
        assert (
            await client.post(
                f"{CREATE}/{live_at_shutdown}/connect", headers=alice
            )
        ).status_code == 404
        assert list(tmp_path.iterdir()) == []


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


@pytest.mark.parametrize("template_env", [None, "  "])
@pytest.mark.asyncio
async def test_builtin_base_has_a_fresh_writable_ram_mount(
    tmp_path, monkeypatch, template_env
):
    resources = memory_resource_store()
    if template_env is None:
        monkeypatch.delenv("MIRAGE_E2B_TEMPLATE", raising=False)
    else:
        monkeypatch.setenv("MIRAGE_E2B_TEMPLATE", template_env)
        await resources.create_template(
            TemplateInput(
                name="base", config={"mounts": {"/other": {"vfs": "ram"}}}
            )
        )
    async with server(
        tmp_path, auth_config=TOKEN, resource_store=resources
    ) as (_, client):
        created = await client.post(CREATE, headers=KEY)
        assert created.status_code == 201, created.text
        first = created.json()
        assert first["templateID"] == "base"
        wid = first["sandboxID"]
        reconnected = await client.post(f"{CREATE}/{wid}/connect", headers=KEY)
        assert reconnected.status_code == 200
        assert reconnected.json() == first
        detail = await client.get(
            f"{NATIVE}/v1/workspaces/{wid}",
            headers={"Authorization": "Bearer server-key"},
        )
        assert detail.status_code == 200, detail.text
        assert [
            (mount["prefix"], mount["vfs"], mount["mode"])
            for mount in detail.json()["mounts"]
        ] == [("/home/user/", "ram", "write"), ("/", "ram", "read")]
        headers = data_headers(first)
        written = await client.post(
            PROCESS,
            headers=headers,
            content=start_body("printf kept > state.txt"),
        )
        assert written.status_code == 200, written.text
        assert (
            envelopes(written.content)[-2][1]["event"]["end"]["exitCode"] == 0
        )
        path = {"path": "state.txt"}
        stored = await client.get("/files", headers=headers, params=path)
        assert stored.status_code == 200
        assert stored.content == b"kept"

        fresh = await client.post(
            CREATE, headers=KEY, json={"templateID": "base"}
        )
        assert fresh.status_code == 201, fresh.text
        second = fresh.json()
        assert second["templateID"] == "base"
        assert second["sandboxID"] != wid
        missing = await client.get(
            "/files", headers=data_headers(second), params=path
        )
        assert missing.status_code == 404
        assert list(tmp_path.iterdir()) == []


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
            await client.get(f"{NATIVE}/v1/workspaces", headers=headers)
        ).status_code == 401
        assert (await client.get(PROCESS, headers=headers)).status_code == 405
        assert (
            await client.post(f"{PROCESS}/extra", headers=headers)
        ).status_code == 404
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
@pytest.mark.parametrize("path", ["/files?path=fixture", PROCESS])
async def test_revocation_replies_while_the_request_body_is_incomplete(
    tmp_path, path
):
    async with server(tmp_path, auth_config=TOKEN) as (_, client):
        headers = await sandbox_headers(client)
        sandbox = headers["e2b-sandbox-id"]
        reading = asyncio.Event()
        if path == PROCESS:
            prefix = start_body("touch unexpected")[:4]
        else:
            headers["content-type"] = "multipart/form-data; boundary=partial"
            prefix = b'--partial\r\nContent-Disposition: form-data; name="file"\r\n\r\n'

        async def body():
            yield prefix
            reading.set()
            await asyncio.Event().wait()

        async with asyncio.timeout(2), asyncio.TaskGroup() as tasks:
            pending = tasks.create_task(
                client.post(path, content=body(), headers=headers)
            )
            await reading.wait()
            if path == PROCESS:
                retired = await client.post(
                    f"/sandboxes/{sandbox}/timeout",
                    headers=KEY,
                    json={"timeout": 0},
                )
            else:
                retired = await client.delete(
                    f"/sandboxes/{sandbox}", headers=KEY
                )
            assert retired.status_code == 204, retired.text
            response = await pending
        assert response.status_code == 401, response.text
        assert response.json()["code"] == (
            "unauthenticated" if path == PROCESS else 401
        )


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
        assert response.json() == {
            "code": "invalid_argument",
            "message": "invalid Connect start request",
        }
        response = await client.post(
            PROCESS,
            content=command,
            headers={**headers, "connect-timeout-ms": "1.2"},
        )
        assert response.status_code == 400


@pytest.mark.asyncio
async def test_process_refuses_new_commands_while_draining(tmp_path):
    async with server(tmp_path, e2b_template=TEMPLATE, auth_config=TOKEN) as (
        app,
        client,
    ):
        headers = await sandbox_headers(client)
        command = start_body("touch late")

        async def upload():
            yield command[:4]
            app.state.registry.draining = True
            yield command[4:]

        response = await client.post(
            PROCESS, content=upload(), headers=headers
        )
        assert response.status_code == 503
        assert response.json() == {
            "code": "unavailable",
            "message": "server is shutting down",
        }
        response = await client.post(
            "/filesystem.Filesystem/Stat",
            headers={
                key: value
                for key, value in headers.items()
                if key != "content-type"
            },
            json={"path": "late"},
        )
        assert response.status_code == 404


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
            await app.state.e2b_app(scope, receive, send)
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


@pytest.mark.asyncio
async def test_files_follow_the_same_live_lease_and_virtual_paths(tmp_path):
    async with server(tmp_path, auth_config=TOKEN, e2b_template=TEMPLATE) as (
        _,
        client,
    ):
        headers = {
            key: value
            for key, value in (await sandbox_headers(client)).items()
            if key.lower() != "content-type"
        }
        rpc = "/filesystem.Filesystem/"
        directory = {"path": "nested/dir"}
        response = await client.post(
            rpc + "MakeDir", headers=headers, json=directory
        )
        assert response.status_code == 200, response.text
        response = await client.post(
            rpc + "MakeDir", headers=headers, json=directory
        )
        assert response.json()["code"] == "already_exists"

        path = "nested/dir/fixture.bin"
        payload = b"\x00\xff\x82"
        response = await client.post(
            "/files",
            headers=headers,
            params={"path": path},
            files={
                "file": ("fixture.bin", payload, "application/octet-stream")
            },
        )
        assert response.status_code == 200, response.text
        assert response.json()[0]["path"] == "/home/user/" + path
        response = await client.get(
            "/files", headers=headers, params={"path": path}
        )
        assert response.content == payload

        response = await client.post(
            rpc + "Stat", headers=headers, json={"path": path}
        )
        assert response.json()["entry"]["size"] == str(len(payload))
        response = await client.post(
            rpc + "ListDir",
            headers=headers,
            json={"path": "nested", "depth": 2},
        )
        assert any(
            entry["name"] == "fixture.bin"
            for entry in response.json()["entries"]
        )

        denied = {
            key: value
            for key, value in headers.items()
            if key.lower() != "x-access-token"
        }
        response = await client.get(
            "/files", headers=denied, params={"path": path}
        )
        assert response.status_code == 401
        assert response.json()["code"] == 401
        other = await sandbox_headers(client)
        del other["content-type"]
        response = await client.post(
            "/files",
            headers=other,
            params={"path": path},
            files={
                "file": ("fixture.bin", payload, "application/octet-stream")
            },
        )
        assert response.status_code == 200, response.text
        response = await client.post(
            rpc + "Remove", headers=headers, json={"path": "nested"}
        )
        assert response.status_code == 200, response.text
        assert response.json() == {}
        assert (
            await client.get("/files", headers=other, params={"path": path})
        ).content == payload
        response = await client.post(
            rpc + "Stat", headers=headers, json={"path": "nested"}
        )
        assert response.json()["code"] == "not_found"


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["download", "write", "mkdir"])
async def test_kill_cancels_file_io_before_stopping_the_runner(
    tmp_path, monkeypatch, operation
):
    loop = asyncio.get_running_loop()
    active = asyncio.Event()
    finished = asyncio.Event()

    async def blocked(*_args):
        try:
            loop.call_soon_threadsafe(active.set)
            await asyncio.Event().wait()
        finally:
            loop.call_soon_threadsafe(finished.set)

    async def read(_files, _path):
        async def source():
            await blocked()
            yield b"unreachable"

        return source()

    monkeypatch.setattr(
        SandboxFiles,
        "read" if operation == "download" else operation,
        read if operation == "download" else blocked,
    )
    async with server(tmp_path, auth_config=TOKEN) as (app, client):
        created = await client.post(CREATE, headers=KEY)
        assert created.status_code == 201, created.text
        headers = data_headers(created.json())
        del headers["content-type"]
        wid = created.json()["sandboxID"]
        runner = app.state.e2b.live(wid).entry.runner
        stop = runner.stop

        async def stop_after_files(*, delete=False):
            assert finished.is_set()
            await stop(delete=delete)

        monkeypatch.setattr(runner, "stop", stop_after_files)

        async def download():
            with pytest.raises(ConnectionError, match="sandbox closed"):
                await client.get("/files?path=fixture", headers=headers)

        if operation == "download":
            request = download()
        elif operation == "write":
            request = client.post(
                "/files?path=fixture", headers=headers, files={"file": b"x"}
            )
        else:
            request = client.post(
                "/filesystem.Filesystem/MakeDir",
                headers=headers,
                json={"path": "fixture"},
            )

        async with asyncio.timeout(3), asyncio.TaskGroup() as tasks:
            response = tasks.create_task(request)
            await active.wait()
            killed = await client.delete(f"/sandboxes/{wid}", headers=KEY)
            assert killed.status_code == 204, killed.text
        if operation != "download":
            assert response.result().status_code == 401


@pytest.mark.asyncio
async def test_file_request_finishing_its_body_after_kill_is_refused(tmp_path):
    async with server(tmp_path, auth_config=TOKEN) as (_, client):
        created = await client.post(CREATE, headers=KEY)
        assert created.status_code == 201, created.text
        headers = data_headers(created.json())
        headers["content-type"] = "application/json"
        wid = created.json()["sandboxID"]
        reading = asyncio.Event()
        released = asyncio.Event()

        async def body():
            reading.set()
            await released.wait()
            yield b'{"path":"fixture"}'

        async with asyncio.timeout(3), asyncio.TaskGroup() as tasks:
            request = tasks.create_task(
                client.post(
                    "/filesystem.Filesystem/MakeDir",
                    headers=headers,
                    content=body(),
                )
            )
            await reading.wait()
            killed = await client.delete(f"/sandboxes/{wid}", headers=KEY)
            assert killed.status_code == 204, killed.text
            released.set()
        assert request.result().status_code == 401
        assert request.result().json()["code"] == "unauthenticated"


@pytest.mark.asyncio
async def test_files_protect_the_mount_a_directory_resolves_to(tmp_path):
    async with server(tmp_path, e2b_template=TEMPLATE, auth_config=TOKEN) as (
        _,
        client,
    ):
        headers = await sandbox_headers(client)
        prepared = await client.post(
            PROCESS,
            content=start_body(
                "touch keep.txt; ln -s /home/user workspace-link"
            ),
            headers=headers,
        )
        assert (
            envelopes(prepared.content)[-2][1]["event"]["end"]["exitCode"] == 0
        )
        del headers["content-type"]

        rpc = "/filesystem.Filesystem/"
        refused = await client.post(
            rpc + "Remove", headers=headers, json={"path": "workspace-link/"}
        )
        assert refused.status_code == 400
        assert refused.json() == {
            "code": "failed_precondition",
            "message": "cannot remove a mount",
        }
        removed = await client.post(
            rpc + "Remove", headers=headers, json={"path": "workspace-link"}
        )
        assert removed.status_code == 200
        kept = await client.post(
            rpc + "Stat", headers=headers, json={"path": "keep.txt"}
        )
        assert kept.status_code == 200


@pytest.mark.asyncio
async def test_recursive_remove_preserves_symlink_targets(tmp_path):
    async with server(tmp_path, auth_config=TOKEN) as (_, client):
        headers = await sandbox_headers(client)
        prepared = await client.post(
            PROCESS,
            content=start_body(
                "mkdir -p tree/nested outside; touch outside/keep; "
                "ln -s /home/user/outside tree/alias; "
                "ln -s /home/user outside-parent"
            ),
            headers=headers,
        )
        assert (
            envelopes(prepared.content)[-2][1]["event"]["end"]["exitCode"] == 0
        )
        del headers["content-type"]
        rpc = "/filesystem.Filesystem/"
        for path in ("tree/alias/", "outside-parent/outside"):
            refused = await client.post(
                rpc + "Remove", headers=headers, json={"path": path}
            )
            assert refused.status_code == 400, refused.text
            assert refused.json()["code"] == "failed_precondition"
        removed = await client.post(
            rpc + "Remove", headers=headers, json={"path": "tree"}
        )
        assert removed.status_code == 200, removed.text
        kept = await client.post(
            rpc + "Stat", headers=headers, json={"path": "outside/keep"}
        )
        assert kept.status_code == 200, kept.text


@pytest.mark.asyncio
async def test_recursive_remove_refuses_nested_mounts_and_other_backends(
    tmp_path,
):
    disk = tmp_path / "mounted"
    disk.mkdir()
    (disk / "tree").mkdir()
    (disk / "empty").mkdir()
    (disk / "tree" / "keep").write_text("kept")
    resources = memory_resource_store()
    await resources.create_template(
        TemplateInput(
            name=TEMPLATE,
            config={
                "mounts": {
                    "/home/user": {"vfs": "ram", "mode": "write"},
                    "/home/user/outer/nested": {
                        "vfs": "disk",
                        "mode": "write",
                        "config": {"root": str(disk)},
                    },
                }
            },
        )
    )
    async with server(
        tmp_path,
        auth_config=TOKEN,
        e2b_template=TEMPLATE,
        resource_store=resources,
    ) as (_, client):
        headers = await sandbox_headers(client)
        prepared = await client.post(
            PROCESS,
            content=start_body("mkdir -p outer; touch outer/keep"),
            headers=headers,
        )
        assert (
            envelopes(prepared.content)[-2][1]["event"]["end"]["exitCode"] == 0
        )
        del headers["content-type"]
        rpc = "/filesystem.Filesystem/"
        for path, code in (
            ("outer", "failed_precondition"),
            ("outer/nested", "failed_precondition"),
            ("outer/nested/tree", "failed_precondition"),
        ):
            refused = await client.post(
                rpc + "Remove", headers=headers, json={"path": path}
            )
            assert refused.json()["code"] == code, refused.text
        kept = await client.post(
            rpc + "Stat", headers=headers, json={"path": "outer/keep"}
        )
        assert kept.status_code == 200, kept.text
        assert (disk / "tree" / "keep").read_text() == "kept"
        empty = await client.post(
            rpc + "Remove",
            headers=headers,
            json={"path": "outer/nested/empty"},
        )
        assert empty.status_code == 200, empty.text
        assert not (disk / "empty").exists()


@pytest.mark.asyncio
async def test_recursive_remove_refuses_a_replacement_file(
    tmp_path, monkeypatch
):
    rm_r = Files.rm_r

    async def replace_directory(files, path):
        await files.rmdir(path)
        await files.write(path, b"replacement")
        await rm_r(files, path)

    monkeypatch.setattr(Files, "rm_r", replace_directory)
    async with server(tmp_path, auth_config=TOKEN) as (_, client):
        headers = await sandbox_headers(client)
        del headers["content-type"]
        rpc = "/filesystem.Filesystem/"
        created = await client.post(
            rpc + "MakeDir", headers=headers, json={"path": "tree"}
        )
        assert created.status_code == 200, created.text
        refused = await client.post(
            rpc + "Remove", headers=headers, json={"path": "tree"}
        )
        assert refused.status_code == 400, refused.text
        assert refused.json()["code"] == "failed_precondition"
        kept = await client.get(
            "/files", headers=headers, params={"path": "tree"}
        )
        assert kept.content == b"replacement"


@pytest.mark.asyncio
@pytest.mark.parametrize("recreate", [False, True])
async def test_recursive_remove_rechecks_the_directory_after_admission(
    tmp_path, monkeypatch, recreate
):
    admit = Dispatcher._admit

    async def change_directory(dispatcher, call, mount, mark, **kwargs):
        if call.name == "rm_r" and call.guarded_remove:
            await mount.call("rmdir", call.path.virtual)
            if recreate:
                await asyncio.sleep(0.001)
                await mount.call("mkdir", call.path.virtual)
                await mount.call("write", call.path.child("new"), data=b"keep")
        return await admit(dispatcher, call, mount, mark, **kwargs)

    monkeypatch.setattr(Dispatcher, "_admit", change_directory)
    async with server(tmp_path, auth_config=TOKEN) as (_, client):
        headers = await sandbox_headers(client)
        del headers["content-type"]
        rpc = "/filesystem.Filesystem/"
        response = await client.post(
            rpc + "MakeDir", headers=headers, json={"path": "tree"}
        )
        assert response.status_code == 200, response.text
        response = await client.post(
            rpc + "Remove", headers=headers, json={"path": "tree"}
        )
        if recreate:
            assert response.status_code == 400, response.text
            assert response.json()["code"] == "failed_precondition"
            kept = await client.get(
                "/files", headers=headers, params={"path": "tree/new"}
            )
            assert kept.content == b"keep"
        else:
            assert response.status_code == 200, response.text


@pytest.mark.asyncio
async def test_recursive_remove_keeps_namespace_entries_added_after_deletion(
    tmp_path, monkeypatch
):
    settle_write = Dispatcher._settle_write

    async def recreate_after_delete(
        dispatcher, mount, name, path, *args, **kwargs
    ):
        if name == "rm_r" and kwargs.get("removed_nodes") is not None:
            await mount.call("mkdir", path.virtual)
            namespace = dispatcher._namespace
            await namespace.unlink(path.child("replaced"))
            await namespace.symlink(
                path.child("replaced"), "/home/user/new", 0
            )
            await namespace.symlink(path.child("arrived"), "/home/user/new", 0)
            await namespace.symlink(
                path.child("converted"), "/home/user/new", 0
            )
        return await settle_write(
            dispatcher, mount, name, path, *args, **kwargs
        )

    monkeypatch.setattr(Dispatcher, "_settle_write", recreate_after_delete)
    async with server(tmp_path, auth_config=TOKEN) as (_, client):
        headers = await sandbox_headers(client)
        prepared = await client.post(
            PROCESS,
            content=start_body(
                "mkdir tree; ln -s /home/user/original tree/replaced; "
                "ln -s /home/user/original tree/old; "
                "touch tree/converted; setfattr -n user.before -v value tree/converted"
            ),
            headers=headers,
        )
        assert (
            envelopes(prepared.content)[-2][1]["event"]["end"]["exitCode"] == 0
        )
        del headers["content-type"]
        rpc = "/filesystem.Filesystem/"
        response = await client.post(
            rpc + "Remove", headers=headers, json={"path": "tree"}
        )
        assert response.status_code == 200, response.text
        response = await client.post(
            rpc + "ListDir", headers=headers, json={"path": "tree"}
        )
        assert {
            entry["name"]: entry["symlinkTarget"]
            for entry in response.json()["entries"]
        } == {
            "arrived": "/home/user/new",
            "converted": "/home/user/new",
            "replaced": "/home/user/new",
        }

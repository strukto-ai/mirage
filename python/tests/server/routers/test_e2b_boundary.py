import pytest

from mirage.resources.memory import memory_resource_store
from mirage.resources.types import TemplateInput
from mirage.server.auth import AuthConfig, AuthMode, JWTConfig
from mirage.server.rate_limit import RateLimit
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
    sandbox_headers,
    server,
    start_body,
)


@pytest.mark.asyncio
async def test_sandbox_account_limit_requires_a_valid_token(tmp_path):
    auth = AuthConfig(
        mode=AuthMode.JWT, jwt=JWTConfig(algorithm="HS256", key=SECRET)
    )
    async with server(
        tmp_path,
        auth_config=auth,
        rate_limits=[RateLimit("account", "3/minute")],
    ) as (_, client):

        async def create_for(account):
            created = await client.post(
                CREATE, headers={"X-API-Key": account_key(account)}
            )
            assert created.status_code == 201, created.text
            return data_headers(created.json())

        async def stat(headers):
            return await client.post(
                "/filesystem.Filesystem/Stat",
                headers={**headers, "content-type": "application/json"},
                json={"path": "/home/user"},
            )

        alice = await create_for("alice")
        bob = await create_for("bob")
        assert (
            await stat({**alice, "x-access-token": bob["x-access-token"]})
        ).status_code == 401
        assert (await stat(alice)).status_code == 200
        assert (
            await client.post(
                PROCESS, content=start_body("true"), headers=alice
            )
        ).status_code == 200
        limited = await stat(alice)
        assert limited.status_code == 429
        assert limited.json() == {
            "code": "resource_exhausted",
            "message": "too many requests",
        }
        assert int(limited.headers["Retry-After"]) > 0
        native = await client.get(
            f"{NATIVE}/v1/workspaces",
            headers={"Authorization": f"Bearer {account_key('alice')}"},
        )
        assert native.status_code == 429
        assert (await stat(bob)).status_code == 200


@pytest.mark.asyncio
async def test_verified_sandbox_routes_share_the_native_workspace_limit(
    tmp_path,
):
    auth = AuthConfig(
        mode=AuthMode.JWT, jwt=JWTConfig(algorithm="HS256", key=SECRET)
    )
    async with server(
        tmp_path,
        auth_config=auth,
        rate_limits=[RateLimit("workspace", "3/minute")],
    ) as (_, client):
        alice_key, bob_key = account_key("alice"), account_key("bob")
        alice_api = {"X-API-Key": alice_key}
        bob_api = {"X-API-Key": bob_key}
        native_auth = {"Authorization": f"Bearer {alice_key}"}

        async def create(headers):
            response = await client.post(CREATE, headers=headers)
            assert response.status_code == 201, response.text
            return data_headers(response.json())

        async def stat(headers):
            return await client.post(
                "/filesystem.Filesystem/Stat",
                headers={**headers, "content-type": "application/json"},
                json={"path": "/home/user"},
            )

        alice = await create(alice_api)
        bob = await create(bob_api)
        sandbox_id = alice["e2b-sandbox-id"]
        connect = f"{CREATE}/{sandbox_id}/connect"
        native = f"{NATIVE}/v1/workspaces/{sandbox_id}"
        spoofed = {**alice, "x-access-token": bob["x-access-token"]}
        assert (await stat(spoofed)).status_code == 401
        assert (await client.post(connect)).status_code == 401
        assert (await client.post(connect, headers=bob_api)).status_code == 404

        assert (
            await client.get(native, headers=native_auth)
        ).status_code == 200
        assert (await stat(alice)).status_code == 200
        assert (
            await client.post(
                f"/sandboxes/{sandbox_id}/timeout",
                headers=alice_api,
                json={"timeout": 300},
            )
        ).status_code == 204

        lifecycle_limit = await client.post(connect, headers=alice_api)
        assert lifecycle_limit.status_code == 429
        assert lifecycle_limit.json() == {
            "code": 429,
            "message": "too many requests",
        }
        assert int(lifecycle_limit.headers["Retry-After"]) > 0
        data_limit = await stat(alice)
        assert data_limit.status_code == 429
        assert data_limit.json()["code"] == "resource_exhausted"
        native_limit = await client.get(native, headers=native_auth)
        assert native_limit.status_code == 429
        assert native_limit.json()["error"]["code"] == "rate_limited"
        assert (await stat(spoofed)).status_code == 401
        assert (await client.post(connect, headers=bob_api)).status_code == 404
        assert (await stat(bob)).status_code == 200


@pytest.mark.asyncio
async def test_files_list_to_requested_depth_without_following_symlinks(
    tmp_path,
):
    async with server(tmp_path, e2b_template=TEMPLATE, auth_config=TOKEN) as (
        _,
        client,
    ):
        headers = await sandbox_headers(client)
        prepared = await client.post(
            PROCESS,
            content=start_body(
                "mkdir -p tree/a/b; touch tree/a/b/leaf; "
                "ln -s /home/user/tree tree/a/b/loop"
            ),
            headers=headers,
        )
        assert (
            envelopes(prepared.content)[-2][1]["event"]["end"]["exitCode"] == 0
        )
        del headers["content-type"]

        async def listing(**depth):
            return await client.post(
                "/filesystem.Filesystem/ListDir",
                headers=headers,
                json={"path": "tree", **depth},
            )

        for values, paths in (
            ({}, ["a"]),
            ({"depth": 2}, ["a", "a/b"]),
            ({"depth": 3}, ["a", "a/b", "a/b/leaf", "a/b/loop"]),
            ({"depth": 2**32 - 1}, ["a", "a/b", "a/b/leaf", "a/b/loop"]),
        ):
            response = await listing(**values)
            assert response.status_code == 200, response.text
            entries = response.json()["entries"]
            assert sorted(entry["path"] for entry in entries) == [
                "/home/user/tree/" + path for path in paths
            ]
            if len(paths) == 4:
                links = [entry for entry in entries if entry["name"] == "loop"]
                assert links[0]["type"] == "FILE_TYPE_SYMLINK"
                assert links[0]["symlinkTarget"] == "/home/user/tree"

        for invalid in (0, -1, 2**32, 1.5, True, "3"):
            response = await listing(depth=invalid)
            assert response.status_code == 400
            assert response.json()["code"] == "invalid_argument"


@pytest.mark.asyncio
async def test_move_reuses_workspace_rename(tmp_path):
    resources = memory_resource_store()
    await resources.create_template(
        TemplateInput(
            name=TEMPLATE,
            config={
                "mounts": {
                    "/home/user": {"vfs": "ram", "mode": "write"},
                    "/other": {"vfs": "ram", "mode": "write"},
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
            PROCESS, headers=headers, content=start_body("printf value > old")
        )
        assert prepared.status_code == 200
        del headers["content-type"]
        response = await client.post(
            "/filesystem.Filesystem/Move",
            headers=headers,
            json={"source": "old", "destination": "/other/new"},
        )
        assert response.json()["code"] == "failed_precondition"
        moved = await client.post(
            "/filesystem.Filesystem/Move",
            headers=headers,
            json={"source": "old", "destination": "new"},
        )
        assert moved.status_code == 200, moved.text
        assert moved.json()["entry"]["path"] == "/home/user/new"
        assert (
            await client.get("/files", params={"path": "old"}, headers=headers)
        ).status_code == 404
        assert (
            await client.get("/files", params={"path": "new"}, headers=headers)
        ).content == b"value"


@pytest.mark.asyncio
async def test_rejects_unsupported_requests_without_creating_a_workspace(
    tmp_path,
):
    async with server(tmp_path, auth_config=TOKEN) as (app, client):
        for field, value in (
            ("autoPause", True),
            ("allow_internet_access", False),
            ("network", {"allowPublicTraffic": False}),
            ("metadata", {"app": "example"}),
        ):
            response = await client.post(
                CREATE, headers=KEY, json={field: value}
            )
            assert response.status_code == 501
            assert field in response.json()["message"]
        response = await client.post(
            CREATE, headers={**KEY, "Idempotency-Key": "test"}
        )
        assert response.status_code == 501
        assert not app.state.registry.list()
        assert (await client.get(CREATE)).status_code == 401
        assert (await client.get(CREATE, headers=KEY)).status_code == 501
        created = await client.post(
            CREATE, headers=KEY, json={"metadata": {}, "autoPause": False}
        )
        assert created.status_code == 201, created.text
        reply = await client.post(
            "/filesystem.Filesystem/CreateWatcher",
            headers=data_headers(created.json()),
        )
        assert reply.status_code == 501
        assert reply.json()["code"] == "unimplemented"


@pytest.mark.asyncio
async def test_checks_lifecycle_bounds_and_data_options(tmp_path):
    async with server(tmp_path, auth_config=TOKEN) as (app, client):
        large = await client.post(
            CREATE, headers=KEY, json={"templateID": "x" * 1024**2}
        )
        assert large.status_code == 413, large.text
        assert not app.state.registry.list()

        created = await client.post(CREATE, headers=KEY)
        sandbox = created.json()
        via_base = await client.post(
            f"{CREATE}/{sandbox['sandboxID']}/connect",
            headers=KEY,
            json={"timeout": 300, "memory": False},
        )
        assert via_base.status_code == 501, via_base.text
        headers = data_headers(sandbox)
        wrong = {**headers, "x-access-token": "forged-token"}
        assert (await client.get("/health", headers=wrong)).status_code == 502
        assert (
            await client.get(
                "/health", headers={**wrong, "e2b-sandbox-id": "missing"}
            )
        ).status_code == 502

        root = await client.get(
            "/files",
            params={"path": "sample", "username": "root"},
            headers=headers,
        )
        assert root.status_code == 400
        assert "default sandbox user" in root.json()["message"]
        write = await client.post(
            "/files",
            params={"path": "sample"},
            headers={**headers, "X-Metadata-Label": "data"},
        )
        assert write.status_code == 501, write.text
        assert (
            await client.get(
                "/files", params={"path": "sample"}, headers=headers
            )
        ).status_code == 404


@pytest.mark.asyncio
async def test_shared_ip_limit_counts_both_listeners(tmp_path):
    async with server(
        tmp_path, auth_config=TOKEN, rate_limits=[RateLimit("ip", "1/minute")]
    ) as (_, client):
        response = await client.get(
            f"{NATIVE}/v1/workspaces",
            headers={"Authorization": "Bearer server-key"},
        )
        assert response.status_code == 200
        response = await client.post(CREATE, headers=KEY)
        assert response.status_code == 429
        assert response.json() == {"code": 429, "message": "too many requests"}

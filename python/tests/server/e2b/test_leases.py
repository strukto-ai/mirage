import asyncio

import pytest

from tests.server.routers.e2b_test_support import (
    CREATE,
    KEY,
    NATIVE,
    TOKEN,
    sandbox_headers,
    server,
)


@pytest.mark.asyncio
async def test_reconnect_only_extends_and_expiry_removes_workspace(tmp_path):
    async with server(tmp_path, auth_config=TOKEN, max_workspaces=1) as (
        app,
        client,
    ):
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
async def test_native_stop_retires_the_lease_without_another_request(tmp_path):
    async with server(tmp_path, auth_config=TOKEN) as (app, client):
        created = await client.post(CREATE, headers=KEY, json={"timeout": 600})
        assert created.status_code == 201, created.text
        wid = created.json()["sandboxID"]
        lease = app.state.e2b.live(wid)
        assert lease is not None and not lease.expiry.cancelled()

        stopped = await client.post(
            f"{NATIVE}/v1/workspaces/{wid}/stop",
            headers={"Authorization": "Bearer server-key"},
        )
        assert stopped.status_code == 200, stopped.text
        assert lease.expiry.cancelled()


@pytest.mark.asyncio
async def test_health_and_timeout_follow_the_same_workspace_lease(tmp_path):
    async with server(tmp_path, auth_config=TOKEN) as (
        app,
        client,
    ):
        headers = await sandbox_headers(client, timeout=1)
        wid = headers["e2b-sandbox-id"]
        timeout = f"/sandboxes/{wid}/timeout"
        response = await client.get("/health", headers=headers)
        assert response.status_code == 204
        assert response.content == b""
        assert (
            await client.get(
                "/health", headers={**headers, "e2b-sandbox-port": "49999"}
            )
        ).status_code == 400
        for token in ("", "wrong"):
            assert (
                await client.get(
                    "/health", headers={**headers, "x-access-token": token}
                )
            ).status_code == 502
        assert (
            await client.post(timeout, headers=headers, json={"timeout": 10})
        ).status_code == 401
        for payload in (
            {},
            {"timeout": -1},
            {"timeout": True},
            {"timeout": 2**31},
        ):
            assert (
                await client.post(timeout, headers=KEY, json=payload)
            ).status_code == 400

        assert (
            await client.post(timeout, headers=KEY, json={"timeout": 10})
        ).status_code == 204
        await asyncio.sleep(1.1)
        assert (
            await client.get("/health", headers=headers)
        ).status_code == 204
        assert wid in app.state.registry

        assert (
            await client.post(timeout, headers=KEY, json={"timeout": 0})
        ).status_code == 204
        assert (
            await client.get("/health", headers=headers)
        ).status_code == 502
        assert (
            await client.post(timeout, headers=KEY, json={"timeout": 10})
        ).status_code == 404
        async with asyncio.timeout(3):
            while wid in app.state.registry:
                await asyncio.sleep(0.01)

import logging
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient

from mirage import RAMVFS, MountMode, PathSpec
from mirage.server.app import build_app
from mirage.server.routers import vfs
from mirage.vfs.call import vfs_call
from mirage.vfs.types import Effect
from mirage.workspace.workspace import Session


@pytest.mark.asyncio
@pytest.mark.parametrize("route", ["vfs/read", "glob"])
@pytest.mark.parametrize(
    "exc, status, body",
    [
        (
            RuntimeError("backend token=secret"),
            500,
            {"detail": "internal server error"},
        ),
        (
            FileNotFoundError("backend token=secret"),
            404,
            {"detail": "No such file or directory", "errno": "ENOENT"},
        ),
    ],
)
async def test_failures_keep_private_details_in_logs(
    monkeypatch, caplog, route, exc, status, body
):
    app = build_app()
    async with app.router.lifespan_context(app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            created = await client.post(
                "/v1/workspaces",
                json={"config": {"mounts": {"/": {"vfs": "ram"}}}},
            )
            wid = created.json()["id"]
            monkeypatch.setattr(vfs, "answered", AsyncMock(side_effect=exc))
            monkeypatch.setattr(Session, "glob", AsyncMock(side_effect=exc))
            with caplog.at_level(logging.DEBUG, logger=vfs.__name__):
                response = await client.post(
                    f"/v1/workspaces/{wid}/{route}",
                    json={"path": "/file"}
                    if route == "vfs/read"
                    else {"pattern": "/*"},
                )
            assert response.status_code == status
            assert response.json() == body
            assert "backend token=secret" in caplog.text


class PeekVFS(RAMVFS):
    calls = 0

    @vfs_call(effect=Effect.READ)
    async def peek(self, path: PathSpec) -> str:
        self.calls += 1
        return path.virtual


@pytest.mark.asyncio
async def test_custom_functions_and_streams_keep_the_session_gate():
    app = build_app()
    async with app.router.lifespan_context(app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            created = await client.post(
                "/v1/workspaces",
                json={
                    "config": {
                        "mounts": {"/base": {"vfs": "ram"}},
                        "profiles": {
                            "agent": {"paths": {"hide": ["/data/secret"]}}
                        },
                    }
                },
            )
            assert created.status_code < 300, created.text
            wid = created.json()["id"]
            entry = app.state.registry.get(wid)
            backend = PeekVFS()
            data = b"abcdefgh" * 131072

            async def prepare():
                entry.runner.ws.add_mount("/data", backend, MountMode.WRITE)
                await entry.runner.ws.vfs.write("/data/visible", data)
                await entry.runner.ws.vfs.write("/data/secret", b"secret")
                await entry.runner.ws.session("agent", profile="agent")

            await entry.runner.call(prepare())
            base = f"/v1/workspaces/{wid}/vfs"
            reply = await client.post(
                base + "/peek?session_id=agent", json={"path": "/data/visible"}
            )
            assert reply.status_code == 200, reply.text
            assert reply.json() == "/data/visible"
            reply = await client.post(
                base + "/peek?session_id=agent", json={"path": "/data/secret"}
            )
            assert reply.status_code == 404, reply.text
            assert backend.calls == 1
            for reserved in ("session_id", "report", "admit_only", "stream"):
                reply = await client.post(
                    base + "/peek?session_id=agent",
                    json={
                        "path": "/data/secret",
                        "kwargs": {reserved: "default"},
                    },
                )
                assert reply.status_code == 400, reply.text
            reply = await client.post(
                base + "/copy?session_id=agent",
                json={"path": "/data/visible", "kwargs": {"dst": "/data/x"}},
            )
            assert reply.status_code == 400, reply.text
            reply = await client.post(
                base + "/read?session_id=agent",
                json={"path": "/data/visible", "stream": True},
            )
            assert reply.status_code == 200, reply.text[:200]
            assert reply.headers["content-type"] == "application/octet-stream"
            assert reply.content == data
            reply = await client.post(
                base + "/read?session_id=agent",
                json={"path": "/data/secret", "stream": True},
            )
            assert reply.status_code == 404
            reply = await client.post(
                base + "/read?session_id=agent",
                json={"path": "/data/visible", "stream": "yes"},
            )
            assert reply.status_code == 400

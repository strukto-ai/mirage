import errno
import logging
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient

from mirage import RAMVFS, MountMode, PathSpec
from mirage.errors.posix import posix_phrase
from mirage.errors.types import FileTooLargeError, FsCondition, StaleWriteError
from mirage.server.app import build_app
from mirage.server.routers import vfs
from mirage.vfs.call import vfs_call
from mirage.vfs.types import Effect


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "exc, status, body",
    [
        (
            RuntimeError("backend token=secret"),
            500,
            {
                "error": {
                    "code": "internal",
                    "message": "internal server error",
                }
            },
        ),
        (
            FileNotFoundError("backend token=secret"),
            404,
            {
                "error": {
                    "code": "not_found",
                    "message": "No such file or directory",
                    "errno": "ENOENT",
                }
            },
        ),
        (
            OSError(errno.EDQUOT, "backend token=secret"),
            403,
            {
                "error": {
                    "code": "storage_full",
                    "message": "Disk quota exceeded",
                    "errno": "EDQUOT",
                }
            },
        ),
        (
            StaleWriteError("backend token=secret"),
            409,
            {
                "error": {
                    "code": "stale_write",
                    "message": posix_phrase(FsCondition.STALE_WRITE),
                    "errno": "STALE_WRITE",
                }
            },
        ),
        (
            FileTooLargeError("backend token=secret"),
            400,
            {
                "error": {
                    "code": "invalid_request",
                    "message": "File too large",
                    "errno": "EFBIG",
                }
            },
        ),
    ],
)
async def test_failures_keep_private_details_in_logs(
    monkeypatch, caplog, exc, status, body
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
            with caplog.at_level(logging.DEBUG, logger=vfs.__name__):
                response = await client.post(
                    f"/v1/workspaces/{wid}/vfs/read", json={"path": "/file"}
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
            assert reply.json() == {"value": "/data/visible"}
            reply = await client.post(
                base + "/peek?session_id=agent", json={"path": "/data/secret"}
            )
            assert reply.status_code == 404, reply.text
            assert backend.calls == 1
            for reserved in (
                "session_id",
                "report",
                "admit_only",
                "retained",
                "stream",
            ):
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


@pytest.mark.asyncio
async def test_calls_answer_one_object_and_name_the_field_at_fault():
    app = build_app()
    async with app.router.lifespan_context(app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            created = await client.post(
                "/v1/workspaces",
                json={"config": {"mounts": {"/": {"vfs": "ram"}}}},
            )
            base = f"/v1/workspaces/{created.json()['id']}/vfs"
            written = await client.post(
                base + "/write", json={"path": "/a", "data": "aGkK"}
            )
            assert written.json() == {}
            listed = await client.post(
                base + "/list_files", json={"path": "/"}
            )
            assert "a" in listed.json()["items"]
            explained = await client.post(
                base + "/unlink?explain=true", json={"path": "/a"}
            )
            said = explained.json()["explanation"]
            assert (said["call"], said["outcome"]) == ("unlink", "allow")
            streamed = await client.post(
                base + "/read", json={"path": "/a", "stream": True}
            )
            assert streamed.headers["content-type"] == (
                "application/octet-stream"
            )
            assert streamed.content == b"hi\n"
            for body, error in (
                (
                    {"path": "/a"},
                    {
                        "code": "missing_field",
                        "message": "data is required",
                        "param": "data",
                    },
                ),
                (
                    {"path": "/a", "data": "", "mode": 1},
                    {
                        "code": "unknown_field",
                        "message": "mode is not a known field",
                        "param": "mode",
                    },
                ),
                (
                    {"path": 1, "data": ""},
                    {
                        "code": "invalid_value",
                        "message": "arguments do not fit vfs/write's schema",
                        "param": "path",
                    },
                ),
            ):
                refused = await client.post(base + "/write", json=body)
                assert refused.status_code == 400
                assert refused.json() == {"error": error}

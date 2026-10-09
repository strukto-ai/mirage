import logging
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient

from mirage.server.app import build_app
from mirage.server.routers import vfs
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

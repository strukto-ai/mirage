import pytest
from httpx import ASGITransport, AsyncClient

from mirage.server import build_app


async def _create_workspace(client: AsyncClient) -> str:
    r = await client.post(
        "/v1/workspaces",
        json={"config": {"mounts": {"/": {"vfs": "ram", "mode": "WRITE"}}}},
    )
    assert r.status_code == 201
    return r.json()["id"]


async def _tool(client: AsyncClient, wid: str, name: str, body: dict) -> dict:
    r = await client.post(f"/v1/workspaces/{wid}/tools/{name}", json=body)
    assert r.status_code == 200, r.text
    return r.json()


@pytest.mark.asyncio
async def test_every_tool_answers_over_http():
    app = build_app(idle_grace_seconds=10.0)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        written = await _tool(
            client, wid, "write", {"path": "/src/a.py", "content": "Needle\n"}
        )
        read = await _tool(client, wid, "read", {"path": "/src/a.py"})
        edited = await _tool(
            client,
            wid,
            "edit",
            {"path": "/src/a.py", "old_string": "Needle", "new_string": "pin"},
        )
        listed = await _tool(client, wid, "ls", {"path": "/src"})
        found = await _tool(
            client,
            wid,
            "grep",
            {"pattern": "PIN", "path": "/src", "ignore_case": True},
        )
        globbed = await _tool(client, wid, "glob", {"pattern": "**/*.py"})
        shelled = await _tool(client, wid, "shell", {"command": "echo hi"})
    assert written == {"text": "Written: /src/a.py", "is_error": False}
    assert read == {"text": "     1\tNeedle\n", "is_error": False}
    assert edited["is_error"] is False
    assert listed["text"] == "a.py\n"
    assert found == {"text": "/src/a.py:1:pin\n", "is_error": False}
    assert globbed == {"text": "/src/a.py\n", "is_error": False}
    assert shelled == {"text": "hi\n", "is_error": False}


@pytest.mark.asyncio
async def test_the_session_keeps_its_stamps_across_requests():
    app = build_app(idle_grace_seconds=10.0)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        await client.post(
            f"/v1/workspaces/{wid}/shell", json={"command": "echo one > /a"}
        )
        refused = await _tool(
            client, wid, "write", {"path": "/a", "content": "x"}
        )
        await _tool(client, wid, "read", {"path": "/a"})
        written = await _tool(
            client, wid, "write", {"path": "/a", "content": "x"}
        )
    assert refused["is_error"] is True
    assert written["is_error"] is False


@pytest.mark.asyncio
async def test_bad_arguments_and_unknown_targets_are_refused():
    app = build_app(idle_grace_seconds=10.0)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        bad = await client.post(f"/v1/workspaces/{wid}/tools/read", json={})
        workspace = await client.post(
            "/v1/workspaces/nope/tools/read", json={"path": "/a"}
        )
        session = await client.post(
            f"/v1/workspaces/{wid}/tools/read",
            params={"session_id": "nope"},
            json={"path": "/a"},
        )
    assert bad.status_code == 400
    assert bad.json()["detail"].startswith("Invalid arguments for tool read")
    assert workspace.status_code == 404
    assert workspace.json() == {"detail": "workspace not found"}
    assert session.status_code == 404
    assert session.json() == {"detail": "session not found"}


@pytest.mark.asyncio
async def test_a_body_over_the_limit_is_refused():
    app = build_app(idle_grace_seconds=10.0)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        wid = await _create_workspace(client)
        r = await client.post(
            f"/v1/workspaces/{wid}/tools/read", content=b" " * (4 * 1024 * 1024 + 1)
        )
        assert r.status_code == 413

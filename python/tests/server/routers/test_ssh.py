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

import asyncio
import socket
import sys
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import asyncssh
import jwt as pyjwt
import pytest
import uvicorn
from httpx import AsyncClient
from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus

from mirage.server import build_app
from mirage.server.auth.config import AuthConfig, JWTConfig
from mirage.server.ssh.config import SSHConfig

SECRET = "s" * 32
RAM = {"config": {"mounts": {"/": {"vfs": "ram", "mode": "WRITE"}}}}


def _token(sub: str) -> dict[str, str]:
    token = pyjwt.encode(
        {"sub": sub, "exp": int(time.time()) + 60}, SECRET, "HS256"
    )
    return {"Authorization": f"Bearer {token}"}


@asynccontextmanager
async def _serving(tmp_path: Path, jwt: bool = False) -> AsyncIterator[str]:
    auth = (
        AuthConfig(mode="jwt", jwt=JWTConfig(algorithm="HS256", key=SECRET))
        if jwt
        else None
    )
    app = build_app(
        idle_grace_seconds=10.0,
        auth_config=auth,
        state_root=tmp_path / "state",
        ssh_config=SSHConfig(
            port=None,
            host="127.0.0.1",
            host_key_file=tmp_path / "host_key",
            authorized_keys_file=tmp_path / "authorized_keys",
        ),
    )
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning")
    )
    task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.01)
    port = server.servers[0].sockets[0].getsockname()[1]
    try:
        yield f"127.0.0.1:{port}"
    finally:
        server.should_exit = True
        await task


@asynccontextmanager
async def _ssh(
    address: str, workspace: str, username: str, headers: dict[str, str]
) -> AsyncIterator[asyncssh.SSHClientConnection]:
    ws = await connect(
        f"ws://{address}/v1/workspaces/{workspace}/ssh",
        additional_headers=headers,
        max_size=None,
        compression=None,
    )
    ours, theirs = socket.socketpair()
    reader, writer = await asyncio.open_connection(sock=ours)

    async def up() -> None:
        while data := await reader.read(65536):
            await ws.send(data)

    async def down() -> None:
        async for message in ws:
            assert isinstance(message, bytes)
            writer.write(message)
            await writer.drain()

    pumps = [asyncio.create_task(up()), asyncio.create_task(down())]
    try:
        async with asyncssh.connect(
            "mirage",
            sock=theirs,
            username=username,
            known_hosts=None,
            client_keys=None,
            agent_path=None,
        ) as conn:
            yield conn
    finally:
        writer.close()
        await ws.close()
        for pump in pumps:
            pump.cancel()
        await asyncio.gather(*pumps, return_exceptions=True)


@pytest.mark.asyncio
async def test_a_line_runs_over_the_https_route(tmp_path):
    async with _serving(tmp_path) as address:
        async with AsyncClient(base_url=f"http://{address}") as client:
            r = await client.post("/v1/workspaces", json={**RAM, "id": "w"})
            assert r.status_code == 201, r.text
        async with _ssh(address, "w", "w", {}) as conn:
            result = await conn.run("echo over https")
        assert result.stdout == "over https\n"
        assert result.exit_status == 0


@pytest.mark.asyncio
async def test_the_login_must_name_the_routes_workspace(tmp_path):
    async with _serving(tmp_path) as address:
        async with AsyncClient(base_url=f"http://{address}") as client:
            for wid in ("w", "other"):
                r = await client.post(
                    "/v1/workspaces", json={**RAM, "id": wid}
                )
                assert r.status_code == 201, r.text
        with pytest.raises(asyncssh.PermissionDenied):
            async with _ssh(address, "w", "other", {}):
                pass


@pytest.mark.asyncio
async def test_an_account_reaches_only_its_own_workspace(tmp_path):
    async with _serving(tmp_path, jwt=True) as address:
        async with AsyncClient(
            base_url=f"http://{address}", headers=_token("alice")
        ) as alice:
            r = await alice.post("/v1/workspaces", json={**RAM, "id": "w"})
            assert r.status_code == 201, r.text
        with pytest.raises(InvalidStatus) as refused:
            async with _ssh(address, "w", "w", _token("bob")):
                pass
        assert refused.value.response.status_code == 404
        with pytest.raises(InvalidStatus) as anonymous:
            async with _ssh(address, "w", "w", {}):
                pass
        assert anonymous.value.response.status_code == 401
        async with _ssh(address, "w", "w", _token("alice")) as conn:
            result = await conn.run("echo mine")
        assert result.stdout == "mine\n"


@pytest.mark.asyncio
async def test_ssh_proxy_carries_ssh_for_the_cli(tmp_path, monkeypatch):
    async with _serving(tmp_path) as address:
        async with AsyncClient(base_url=f"http://{address}") as client:
            r = await client.post("/v1/workspaces", json={**RAM, "id": "w"})
            assert r.status_code == 201, r.text
        monkeypatch.setenv("MIRAGE_HOME", str(tmp_path / "home"))
        monkeypatch.setenv("MIRAGE_DAEMON_URL", f"http://{address}")
        mirage = str(Path(sys.executable).parent / "mirage")
        async with asyncssh.connect(
            "mirage",
            username="w",
            proxy_command=[mirage, "ssh-proxy", "w"],
            known_hosts=None,
            client_keys=None,
            agent_path=None,
        ) as conn:
            result = await conn.run("echo through the cli")
        assert result.stdout == "through the cli\n"

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

import logging

import asyncssh
import pytest
from asyncssh.gss import GSSError

from mirage.server.registry import WorkspaceRegistry
from mirage.server.ssh.config import SSHConfig
from mirage.server.ssh.server import MirageSSHServer, start_ssh_server


@pytest.mark.asyncio
async def test_an_authorized_key_logs_in(ssh):
    async with ssh.connect() as conn:
        result = await conn.run("echo in")
    assert result.stdout == "in\n"


@pytest.mark.asyncio
async def test_a_stranger_key_is_refused(ssh):
    stranger = asyncssh.generate_private_key("ssh-ed25519")
    with pytest.raises(asyncssh.PermissionDenied):
        async with ssh.connect(key=stranger):
            pass


@pytest.mark.asyncio
async def test_a_key_added_later_works_without_a_restart(ssh):
    late = asyncssh.generate_private_key("ssh-ed25519")
    with pytest.raises(asyncssh.PermissionDenied):
        async with ssh.connect(key=late):
            pass
    with open(ssh.config.authorized_keys_file, "ab") as f:
        f.write(late.export_public_key())
    async with ssh.connect(key=late) as conn:
        assert (await conn.run("echo late")).stdout == "late\n"


@pytest.mark.asyncio
async def test_passwords_are_never_offered(ssh):
    with pytest.raises(asyncssh.PermissionDenied):
        async with asyncssh.connect(
            "127.0.0.1",
            ssh.port,
            username="demo",
            password="anything",
            client_keys=None,
            known_hosts=None,
        ):
            pass
    assert (
        MirageSSHServer(
            ssh.config.authorized_keys_file
        ).password_auth_supported()
        is False
    )


@pytest.mark.asyncio
async def test_agent_forwarding_is_refused(ssh, tmp_path, monkeypatch):
    granted: list[bool] = []
    listen = asyncssh.SSHServerConnection.create_agent_listener

    async def recorded(conn: asyncssh.SSHServerConnection) -> bool:
        granted.append(await listen(conn))
        return granted[-1]

    monkeypatch.setattr(
        asyncssh.SSHServerConnection, "create_agent_listener", recorded
    )
    async with asyncssh.connect(
        "127.0.0.1",
        ssh.port,
        username="demo",
        client_keys=[ssh.key],
        known_hosts=None,
        agent_path=str(tmp_path / "agent"),
        agent_forwarding=True,
    ) as conn:
        assert (await conn.run("echo in")).stdout == "in\n"
    assert granted == [False]


@pytest.mark.asyncio
async def test_gssapi_is_never_offered(ssh, monkeypatch):
    hosts: list[str] = []

    def unavailable(host: str, store: None) -> None:
        hosts.append(host)
        raise GSSError(0, 0)

    monkeypatch.setattr(asyncssh.connection, "GSSServer", unavailable)
    async with ssh.connect() as conn:
        assert (await conn.run("echo in")).stdout == "in\n"
    assert hosts == []


@pytest.mark.asyncio
async def test_host_key_persists_across_restarts(tmp_path):
    config = SSHConfig(
        port=0,
        host="127.0.0.1",
        host_key_file=tmp_path / "host_key",
        authorized_keys_file=tmp_path / "authorized_keys",
    )
    registry = WorkspaceRegistry(idle_grace_seconds=0)
    first = await start_ssh_server(registry, config)
    first.close()
    await first.wait_closed()
    minted = config.host_key_file.read_bytes()
    second = await start_ssh_server(registry, config)
    second.close()
    await second.wait_closed()
    assert config.host_key_file.read_bytes() == minted


@pytest.mark.asyncio
async def test_missing_authorized_keys_warns_and_refuses(tmp_path, caplog):
    config = SSHConfig(
        port=0,
        host="127.0.0.1",
        host_key_file=tmp_path / "host_key",
        authorized_keys_file=tmp_path / "absent",
    )
    registry = WorkspaceRegistry(idle_grace_seconds=0)
    with caplog.at_level(logging.WARNING, logger="mirage.server.ssh.server"):
        acceptor = await start_ssh_server(registry, config)
    try:
        assert "every login will be refused" in caplog.text
        key = asyncssh.generate_private_key("ssh-ed25519")
        with pytest.raises(asyncssh.PermissionDenied):
            async with asyncssh.connect(
                "127.0.0.1",
                acceptor.get_port(),
                username="demo",
                client_keys=[key],
                known_hosts=None,
            ):
                pass
    finally:
        acceptor.close()
        await acceptor.wait_closed()

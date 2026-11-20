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
import os
import socket

import asyncssh
import pytest

from mirage import RAMVFS, MountMode, Workspace
from mirage.machine.handle import MachineHandle
from mirage.machine.program import run_program
from mirage.server.registry import WorkspaceRegistry
from mirage.server.ssh.config import SSHConfig
from mirage.server.ssh.server import serve_tunnel
from tests.server.ssh.conftest import start_harness, stop_harness


async def _echo_server() -> asyncio.Server:
    async def echo(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        while data := await reader.read(1024):
            writer.write(data)
            await writer.drain()
        writer.close()

    return await asyncio.start_server(echo, "127.0.0.1", 0)


class _Here(MachineHandle):
    """A machine whose exec runs each argv on this host, as a provider's
    exec runs it on its own."""

    provider = "box"

    async def connect(self) -> None:
        return None

    async def _exec_argv(self, argv, stdin, env, cwd, output, errors):
        return await run_program(
            argv[0],
            None,
            list(argv[1:]),
            stdin,
            env={**os.environ, **env},
            output=output,
            errors=errors,
        )


def _line_machine_workspace() -> Workspace:
    return Workspace(
        {"/": (RAMVFS(), MountMode.EXEC)},
        mode=MountMode.EXEC,
        machines={"here": _Here("here", {"captures": ["@line"]})},
    )


@pytest.mark.asyncio
async def test_a_forward_reaches_the_port_where_the_lines_run(tmp_path):
    server = await _echo_server()
    port = server.sockets[0].getsockname()[1]
    harness = await start_harness(tmp_path, _line_machine_workspace())
    try:
        async with harness.connect() as conn:
            reader, writer = await conn.open_connection("127.0.0.1", port)
            writer.write(b"ping\n")
            assert await asyncio.wait_for(reader.readline(), 30) == b"ping\n"
            writer.close()
    finally:
        await stop_harness(harness)
        server.close()


@pytest.mark.asyncio
async def test_a_forward_to_another_host_is_refused(ssh):
    async with ssh.connect() as conn:
        with pytest.raises(asyncssh.ChannelOpenError) as refused:
            await conn.open_connection("example.com", 80)
    assert refused.value.code == asyncssh.OPEN_ADMINISTRATIVELY_PROHIBITED


@pytest.mark.asyncio
async def test_a_forward_over_the_https_tunnel_reaches_the_port(tmp_path):
    server = await _echo_server()
    port = server.sockets[0].getsockname()[1]
    registry = WorkspaceRegistry(idle_grace_seconds=0)
    registry.add(_line_machine_workspace(), "demo")
    config = SSHConfig(
        port=None,
        host="127.0.0.1",
        host_key_file=tmp_path / "host_key",
        authorized_keys_file=tmp_path / "authorized_keys",
    )
    listener = socket.create_server(("127.0.0.1", 0))
    theirs = socket.create_connection(listener.getsockname())
    ours, _ = listener.accept()
    listener.close()
    try:
        tunnel, conn = await asyncio.gather(
            serve_tunnel(registry, config, ours, "demo", None),
            asyncssh.connect(
                sock=theirs,
                username="demo",
                known_hosts=None,
                client_keys=None,
            ),
        )
        async with conn:
            reader, writer = await conn.open_connection("127.0.0.1", port)
            writer.write(b"ping\n")
            assert await asyncio.wait_for(reader.readline(), 30) == b"ping\n"
            writer.close()
        tunnel.close()
        await tunnel.wait_closed()
    finally:
        await registry.close_all()
        server.close()

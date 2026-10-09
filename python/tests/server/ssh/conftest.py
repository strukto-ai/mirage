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

from contextlib import AbstractAsyncContextManager
from pathlib import Path

import asyncssh
import pytest_asyncio

from mirage import RAMVFS, MountMode, Workspace
from mirage.server.registry import WorkspaceEntry, WorkspaceRegistry
from mirage.server.ssh.config import SSHConfig
from mirage.server.ssh.server import start_ssh_server

WORKSPACE_ID = "demo"


class SSHHarness:
    """A daemon-shaped SSH endpoint on a free port, serving one RAM workspace.

    Args:
        registry (WorkspaceRegistry): the served workspaces.
        entry (WorkspaceEntry): the ``demo`` workspace.
        acceptor (asyncssh.SSHAcceptor): the running listener.
        key (asyncssh.SSHKey): a client key in the authorized keys.
        config (SSHConfig): the listener's config.
    """

    def __init__(
        self,
        registry: WorkspaceRegistry,
        entry: WorkspaceEntry,
        acceptor: asyncssh.SSHAcceptor,
        key: asyncssh.SSHKey,
        config: SSHConfig,
    ) -> None:
        self.registry = registry
        self.entry = entry
        self.acceptor = acceptor
        self.key = key
        self.config = config

    @property
    def port(self) -> int:
        return self.acceptor.get_port()

    def connect(
        self, username: str = WORKSPACE_ID, key: asyncssh.SSHKey | None = None
    ) -> AbstractAsyncContextManager[asyncssh.SSHClientConnection]:
        return asyncssh.connect(
            "127.0.0.1",
            self.port,
            username=username,
            client_keys=[key or self.key],
            known_hosts=None,
        )


def ram_workspace(mode: MountMode = MountMode.WRITE) -> Workspace:
    return Workspace({"/": (RAMVFS(), mode)})


async def start_harness(
    tmp_path: Path, workspace: Workspace | None = None
) -> SSHHarness:
    key = asyncssh.generate_private_key("ssh-ed25519")
    authorized = tmp_path / "authorized_keys"
    authorized.write_bytes(key.export_public_key())
    registry = WorkspaceRegistry(idle_grace_seconds=0)
    entry = registry.add(workspace or ram_workspace(), WORKSPACE_ID)
    config = SSHConfig(
        port=0,
        host="127.0.0.1",
        host_key_file=tmp_path / "host_key",
        authorized_keys_file=authorized,
    )
    acceptor = await start_ssh_server(registry, config)
    return SSHHarness(registry, entry, acceptor, key, config)


async def stop_harness(harness: SSHHarness) -> None:
    harness.acceptor.close()
    await harness.acceptor.wait_closed()
    await harness.registry.close_all()


@pytest_asyncio.fixture
async def ssh(tmp_path):
    harness = await start_harness(tmp_path)
    yield harness
    await stop_harness(harness)


@pytest_asyncio.fixture
async def ssh_readonly(tmp_path):
    harness = await start_harness(tmp_path, ram_workspace(MountMode.READ))
    yield harness
    await stop_harness(harness)


def bind_key(harness: SSHHarness, options: str) -> asyncssh.SSHKey:
    """Authorize a fresh client key whose line carries ``options``.

    Args:
        harness (SSHHarness): the running entry point; its keys file is read
            again on every login.
        options (str): the OpenSSH options field, e.g.
            ``mirage-profile="guarded"``.
    """
    key = asyncssh.generate_private_key("ssh-ed25519")
    public = key.export_public_key().decode().strip()
    with harness.config.authorized_keys_file.open("a") as keys:
        keys.write(f"{options} {public}\n")
    return key


async def vault_workspace() -> Workspace:
    """A workspace whose ``guarded`` profile seals ``/vault``."""
    ws = Workspace(
        {"/": (RAMVFS(), MountMode.WRITE)},
        profiles={
            "guarded": {
                "commands": {
                    "deny": [
                        {
                            "reason": "the vault is sealed",
                            "paths": ["/vault/*"],
                        }
                    ]
                }
            }
        },
    )
    await ws.shell("mkdir -p /vault && echo token > /vault/secret")
    return ws

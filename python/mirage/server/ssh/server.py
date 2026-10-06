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

import functools
import logging
import socket
from pathlib import Path
from typing import Any

import asyncssh

from mirage.concurrency.limiter import run_blocking
from mirage.server.registry import WorkspaceRegistry
from mirage.server.ssh.codex import serve_codex
from mirage.server.ssh.config import SSHConfig
from mirage.server.ssh.constants import (
    CODEX_SUBSYSTEM,
    KEEPALIVE_COUNT_MAX,
    KEEPALIVE_INTERVAL_SECONDS,
)
from mirage.server.ssh.keys import load_host_key
from mirage.server.ssh.session import TunnelSSHServer, handle_process
from mirage.server.ssh.sftp import MirageSFTPServer
from mirage.server.ssh.stream import ENCODING, ERRORS, MAX_TERMINAL_LINE

logger = logging.getLogger(__name__)


class MirageSSHServer(asyncssh.SSHServer):
    """Admits a connection whose public key is in the authorized keys.

    The file is read again for every connection, so a key added or
    revoked takes effect on the next login without a restart. Public
    key is the only method offered: no passwords, and nothing is
    forwarded (ports, agents, X11).

    Args:
        authorized_keys_file (Path): OpenSSH-format authorized keys.
    """

    def __init__(self, authorized_keys_file: Path) -> None:
        self._keys_file = authorized_keys_file
        self._conn: asyncssh.SSHServerConnection | None = None

    def connection_made(self, conn: asyncssh.SSHServerConnection) -> None:
        self._conn = conn

    async def begin_auth(self, username: str) -> bool:
        if self._conn is None:
            return True
        try:
            keys = await run_blocking(
                asyncssh.read_authorized_keys, str(self._keys_file)
            )
            self._conn.set_authorized_keys(keys)
        except (OSError, ValueError) as exc:
            logger.warning(
                "ssh: refusing %r, cannot read %s: %s",
                username,
                self._keys_file,
                exc,
            )
        return True

    def password_auth_supported(self) -> bool:
        return False


async def serve_channel(
    registry: WorkspaceRegistry,
    process: asyncssh.SSHServerProcess[str],
) -> None:
    """Route a session channel: the codex-exec subsystem to Codex's
    server, anything else to the shell.

    Args:
        registry (WorkspaceRegistry): the daemon's workspaces.
        process (asyncssh.SSHServerProcess[str]): the channel's process.
    """
    if process.subsystem == CODEX_SUBSYSTEM:
        await serve_codex(registry, process)
        return
    await handle_process(registry, process)


async def _server_options(
    registry: WorkspaceRegistry, config: SSHConfig
) -> dict[str, Any]:
    """What every SSH connection the daemon serves runs with.

    Args:
        registry (WorkspaceRegistry): the daemon's workspaces.
        config (SSHConfig): where the host key is kept.
    """
    return {
        "server_host_keys": [await load_host_key(config.host_key_file)],
        "process_factory": functools.partial(serve_channel, registry),
        "sftp_factory": functools.partial(MirageSFTPServer, registry),
        "allow_scp": True,
        "keepalive_interval": KEEPALIVE_INTERVAL_SECONDS,
        "keepalive_count_max": KEEPALIVE_COUNT_MAX,
        "max_line_length": MAX_TERMINAL_LINE,
        "agent_forwarding": False,
        "gss_host": None,
        "encoding": ENCODING,
        "errors": ERRORS,
    }


async def start_ssh_server(
    registry: WorkspaceRegistry,
    config: SSHConfig,
) -> asyncssh.SSHAcceptor:
    """Listen for SSH on the daemon's loop, serving its workspaces.

    ``ssh <workspace-id>@host`` opens a shell in that workspace,
    ``ssh <workspace-id>@host cmd`` runs one line, ``sftp``/``scp``
    reach its files, and the ``codex-exec`` subsystem serves Codex's
    tools.
    Each channel runs as a fresh mirage session under the profile its
    key is bound to (``mirage-profile`` in the authorized keys), else
    the workspace's default profile.

    Args:
        registry (WorkspaceRegistry): the daemon's workspaces.
        config (SSHConfig): where to listen and whom to admit.

    Returns:
        asyncssh.SSHAcceptor: the listener; ``close()`` stops it.

    Raises:
        ValueError: the config sets no port.
    """
    if config.port is None:
        raise ValueError("the SSH door needs ssh_port")
    if not await run_blocking(config.authorized_keys_file.exists):
        logger.warning(
            "ssh: %s does not exist; every login will be refused until "
            "it holds a public key",
            config.authorized_keys_file,
        )
    acceptor = await asyncssh.listen(
        config.host,
        config.port,
        server_factory=functools.partial(
            MirageSSHServer, config.authorized_keys_file
        ),
        **await _server_options(registry, config),
    )
    logger.info("ssh: listening on %s:%d", config.host, acceptor.get_port())
    return acceptor


async def serve_tunnel(
    registry: WorkspaceRegistry,
    config: SSHConfig,
    sock: socket.socket,
    workspace_id: str,
    account: str | None,
) -> asyncssh.SSHServerConnection:
    """Serve one SSH connection carried over ``sock`` by the HTTPS route.

    The route has checked the caller's token and that its account may
    use ``workspace_id``, so the login needs no key: it may only name
    that workspace, and runs as that account. Returns once the login is
    in; the connection then serves its channels like any other.

    Args:
        registry (WorkspaceRegistry): the daemon's workspaces.
        config (SSHConfig): where the host key is kept.
        sock (socket.socket): one end of the pair the route relays.
        workspace_id (str): the workspace the route admitted.
        account (str | None): the caller's account.
    """
    return await asyncssh.run_server(
        sock,
        server_factory=functools.partial(
            TunnelSSHServer, workspace_id, account
        ),
        **await _server_options(registry, config),
    )

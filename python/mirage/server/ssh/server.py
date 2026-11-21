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
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import asyncssh

from mirage.concurrency.limiter import run_blocking
from mirage.server.registry import WorkspaceRegistry
from mirage.server.ssh.codex import serve_codex
from mirage.server.ssh.config import SSHConfig
from mirage.server.ssh.constants import (
    CODEX_SUBSYSTEM,
    FORWARD_REFUSED,
    KEEPALIVE_COUNT_MAX,
    KEEPALIVE_INTERVAL_SECONDS,
    LOOPBACK_HOSTS,
    ROUTE_ACCOUNT,
)
from mirage.server.ssh.forward import serve_forward
from mirage.server.ssh.keys import load_host_key
from mirage.server.ssh.sftp import serve_sftp
from mirage.server.ssh.shell import handle_channel
from mirage.server.ssh.stream import MAX_TERMINAL_LINE

logger = logging.getLogger(__name__)


class LoginSSHServer(asyncssh.SSHServer):
    """A login's connection, besides its session channels: forwards to
    the loopback of the machine its lines run on.

    A forward to ``127.0.0.1`` or ``localhost`` runs as a line of a
    session of its own (``serve_forward``), so it reaches what a line the
    login ran there would reach, under the same profile and policies, as
    sshd's ``localhost`` is where the login's commands run. A forward to
    any other host is refused.

    Args:
        registry (WorkspaceRegistry): the daemon's workspaces.
    """

    def __init__(self, registry: WorkspaceRegistry) -> None:
        self._registry = registry
        self._conn: asyncssh.SSHServerConnection | None = None

    def connection_made(self, conn: asyncssh.SSHServerConnection) -> None:
        self._conn = conn

    def connection_requested(
        self, dest_host: str, dest_port: int, orig_host: str, orig_port: int
    ) -> tuple[
        asyncssh.SSHTCPChannel[bytes],
        Callable[
            [asyncssh.SSHReader[bytes], asyncssh.SSHWriter[bytes]],
            Awaitable[None],
        ],
    ]:
        conn = self._conn
        if conn is None or dest_host not in LOOPBACK_HOSTS:
            raise asyncssh.ChannelOpenError(
                asyncssh.OPEN_ADMINISTRATIVELY_PROHIBITED, FORWARD_REFUSED
            )
        return conn.create_tcp_channel(encoding=None), functools.partial(
            serve_forward, self._registry, conn, dest_port
        )


class MirageSSHServer(LoginSSHServer):
    """Admits a connection whose public key is in the authorized keys.

    The file is read again for every connection, so a key added or
    revoked takes effect on the next login without a restart. Public
    key is the only method offered: no passwords. Ports are forwarded
    as every login forwards them (``LoginSSHServer``); agents and X11
    never are.

    Args:
        registry (WorkspaceRegistry): the daemon's workspaces.
        authorized_keys_file (Path): OpenSSH-format authorized keys.
    """

    def __init__(
        self, registry: WorkspaceRegistry, authorized_keys_file: Path
    ) -> None:
        super().__init__(registry)
        self._keys_file = authorized_keys_file

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


class TunnelSSHServer(LoginSSHServer):
    """Admits a login the HTTPS route already authenticated.

    The route checked the caller's token and that its account may use
    the workspace its URL names, so the login needs no key. It may only
    name that workspace: another username is asked for a method this
    server offers none of, and is refused. The login runs as the
    route's account, which the connection carries (``ROUTE_ACCOUNT``).

    Args:
        registry (WorkspaceRegistry): the daemon's workspaces.
        workspace_id (str): the workspace the route admitted.
        account (str | None): the caller's account; None when the
            server's auth mode names none.
    """

    def __init__(
        self,
        registry: WorkspaceRegistry,
        workspace_id: str,
        account: str | None,
    ) -> None:
        super().__init__(registry)
        self.workspace_id = workspace_id
        self.account = account

    def connection_made(self, conn: asyncssh.SSHServerConnection) -> None:
        super().connection_made(conn)
        if self.account is not None:
            conn.set_extra_info(**{ROUTE_ACCOUNT: self.account})

    def begin_auth(self, username: str) -> bool:
        return username != self.workspace_id

    def password_auth_supported(self) -> bool:
        return False


async def _server_options(
    registry: WorkspaceRegistry, config: SSHConfig
) -> dict[str, Any]:
    """What every SSH connection the daemon serves runs with: a session
    channel's codex-exec subsystem goes to Codex's server, anything else
    to the shell.

    asyncssh runs its line editor only on a text channel, and
    surrogateescape is the one error policy under which every byte
    survives the str round trip, so binary input and output cross a
    text channel unchanged.

    Args:
        registry (WorkspaceRegistry): the daemon's workspaces.
        config (SSHConfig): where the host key is kept.
    """

    async def serve_channel(process: asyncssh.SSHServerProcess[str]) -> None:
        if process.subsystem == CODEX_SUBSYSTEM:
            await serve_codex(registry, process)
        else:
            await handle_channel(registry, process)

    return {
        "server_host_keys": [await load_host_key(config.host_key_file)],
        "process_factory": serve_channel,
        "sftp_factory": functools.partial(serve_sftp, registry),
        "allow_scp": True,
        "keepalive_interval": KEEPALIVE_INTERVAL_SECONDS,
        "keepalive_count_max": KEEPALIVE_COUNT_MAX,
        "max_line_length": MAX_TERMINAL_LINE,
        "agent_forwarding": False,
        "gss_host": None,
        "encoding": "utf-8",
        "errors": "surrogateescape",
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
        raise ValueError("the SSH endpoint needs ssh_port")
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
            MirageSSHServer, registry, config.authorized_keys_file
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
            TunnelSSHServer, registry, workspace_id, account
        ),
        **await _server_options(registry, config),
    )

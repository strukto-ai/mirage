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

from mirage.server.registry import WorkspaceRegistry
from mirage.server.ssh.constants import FORWARD_LINE
from mirage.server.ssh.errors import LoginRefusedError
from mirage.server.ssh.login import login_session
from mirage.server.ssh.pipe import serve_pipe

logger = logging.getLogger(__name__)


async def serve_forward(
    registry: WorkspaceRegistry,
    conn: asyncssh.SSHServerConnection,
    port: int,
    reader: asyncssh.SSHReader[bytes],
    writer: asyncssh.SSHWriter[bytes],
) -> None:
    """Carry one forward to ``port`` on the loopback of the machine the
    login's lines run on.

    The forward opens a session as a channel does (``login_session``)
    and pipes the channel through its one line, ``FORWARD_LINE``, which
    relays between its stdin and stdout and the port (``serve_pipe``).

    Args:
        registry (WorkspaceRegistry): the daemon's workspaces.
        conn (asyncssh.SSHServerConnection): the login's connection.
        port (int): the port the client asked for.
        reader (asyncssh.SSHReader[bytes]): the channel's input.
        writer (asyncssh.SSHWriter[bytes]): the channel's output.
    """
    try:
        entry, session_id = await login_session(
            registry, conn, None, "forward"
        )
    except LoginRefusedError as exc:
        logger.debug("ssh: forward to port %d refused: %s", port, exc)
        writer.close()
        return
    try:
        await serve_pipe(
            registry,
            entry,
            session_id,
            FORWARD_LINE.format(port=port),
            reader,
            writer,
            f"forward to port {port}",
        )
    finally:
        writer.close()

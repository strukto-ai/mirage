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

from collections.abc import Coroutine
from typing import Any

import asyncssh

from mirage.mount.core import MountCore
from mirage.mount.sftp import MirageSFTPServer
from mirage.server.registry import WorkspaceEntry, WorkspaceRegistry
from mirage.server.ssh.session import (
    key_profile,
    login_entry,
    new_session_id,
    open_session,
)


def serve_sftp(
    registry: WorkspaceRegistry, chan: asyncssh.SSHServerChannel[bytes]
) -> MirageSFTPServer:
    """SFTP (and scp) for one channel onto its workspace.

    The channel runs as a session of its own under the login key's
    profile, opened on the first request and closed when the client
    exits; every op runs on the workspace's own loop.

    Args:
        registry (WorkspaceRegistry): the daemon's workspaces; the SSH
            username names the one served.
        chan (asyncssh.SSHServerChannel[bytes]): the SFTP channel.
    """
    workspace_id: str = chan.get_extra_info("username")
    conn = chan.get_connection()
    session_id = new_session_id()
    entry: WorkspaceEntry | None = None

    async def make_core() -> MountCore:
        nonlocal entry
        found = login_entry(registry, conn, workspace_id)
        if found is None:
            raise asyncssh.SFTPNoSuchFile(f"no such workspace: {workspace_id}")
        ws = found.runner.ws
        await found.runner.call(
            open_session(ws, session_id, profile=key_profile(conn))
        )
        entry = found
        return MountCore(ws.vfs, session=ws.get_session(session_id))

    async def run(op: Coroutine[Any, Any, Any]) -> Any:
        assert entry is not None
        return await entry.runner.call(op)

    async def on_exit() -> None:
        try:
            if (
                entry is not None
                and entry.id in registry
                and (registry.get(entry.id) is entry)
            ):
                await entry.runner.call(
                    entry.runner.ws.close_session(session_id)
                )
        finally:
            # asyncssh ends an SFTP channel with no exit status, which
            # OpenSSH's ssh reports as 255 and scp (in its default SFTP
            # mode) as a failed copy. sshd's internal-sftp reports 0, so
            # this does too; after scp's own handler has already exited
            # the channel, it is a no-op.
            chan.exit(0)

    return MirageSFTPServer(chan, make_core, run, on_exit)

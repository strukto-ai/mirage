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
from typing import Any

import asyncssh

from mirage.accessor.base import Accessor
from mirage.concurrency.limiter import settle
from mirage.utils.ssh import connect_options
from mirage.vfs.secrets import reveal_secret
from mirage.vfs.ssh.config import SSHConfig


def _connect_kwargs(config: SSHConfig) -> dict[str, Any]:
    kwargs = connect_options(
        config.host,
        config.hostname,
        config.port,
        config.username,
        config.identity_file,
        config.timeout,
    )
    if config.password is not None:
        kwargs["password"] = reveal_secret(config.password)
    if config.identity_file:
        if config.passphrase is not None:
            kwargs["passphrase"] = reveal_secret(config.passphrase)
    kwargs["known_hosts"] = config.known_hosts
    return kwargs


class SSHAccessor(Accessor):
    def __init__(self, config: SSHConfig) -> None:
        self.config = config
        self._lock = asyncio.Lock()
        self._conn: asyncssh.SSHClientConnection | None = None
        self._sftp: asyncssh.SFTPClient | None = None

    @property
    def root(self) -> str:
        return self.config.root

    async def sftp(self) -> asyncssh.SFTPClient:
        """The SFTP client, connecting on first use and again after the
        server or the network ended the last connection.
        """
        async with self._lock:
            if self._conn is not None and self._conn.is_closed():
                self._conn = None
                self._sftp = None
            if self._sftp is None:
                conn = await asyncssh.connect(**_connect_kwargs(self.config))
                try:
                    self._sftp = await conn.start_sftp_client()
                except BaseException:
                    conn.close()
                    await settle(asyncio.ensure_future(conn.wait_closed()))
                    raise
                self._conn = conn
            return self._sftp

    async def run(self, command: str) -> tuple[int | None, bytes, bytes]:
        """Run ``command`` on the server over the mount's connection: its
        exit status (None when a signal ended it), its output and its
        error output.

        Args:
            command (str): the command line, as the server's shell reads it.
        """
        await self.sftp()
        conn = self._conn
        if conn is None:
            raise ConnectionError("the ssh connection closed")
        done = await conn.run(command, check=False, encoding=None)
        out, err = done.stdout, done.stderr
        return (
            done.exit_status,
            out if isinstance(out, bytes) else b"",
            err if isinstance(err, bytes) else b"",
        )

    async def close(self) -> None:
        async with self._lock:
            if self._conn is not None:
                self._conn.close()
                await self._conn.wait_closed()
                self._conn = None
                self._sftp = None

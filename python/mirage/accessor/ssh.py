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
from pathlib import Path
from typing import Any

import asyncssh

from mirage.accessor.base import Accessor
from mirage.concurrency.limiter import settle
from mirage.vfs.secrets import reveal_secret
from mirage.vfs.ssh.config import SSHConfig


def _connect_kwargs(config: SSHConfig) -> dict[str, Any]:
    kwargs: dict[str, Any] = {"host": config.host}
    if config.hostname:
        kwargs["host"] = config.hostname
    if config.port:
        kwargs["port"] = config.port
    if config.username:
        kwargs["username"] = config.username
    if config.password is not None:
        kwargs["password"] = reveal_secret(config.password)
    if config.identity_file:
        kwargs["client_keys"] = [str(Path(config.identity_file).expanduser())]
        if config.passphrase is not None:
            kwargs["passphrase"] = reveal_secret(config.passphrase)
    kwargs["known_hosts"] = config.known_hosts
    kwargs["login_timeout"] = config.timeout
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

    async def close(self) -> None:
        async with self._lock:
            if self._conn is not None:
                self._conn.close()
                await self._conn.wait_closed()
                self._conn = None
                self._sftp = None

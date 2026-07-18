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

import asyncssh

from mirage.accessor.base import Accessor
from mirage.core.ssh._client import _connect_kwargs
from mirage.core.ssh.config import SSHConfig


class SSHAccessor(Accessor):

    def __init__(self, config: SSHConfig) -> None:
        self.config = config
        self._conn: asyncssh.SSHClientConnection | None = None
        self._sftp: asyncssh.SFTPClient | None = None

    @property
    def root(self) -> str:
        return self.config.root

    async def sftp(self) -> asyncssh.SFTPClient:
        if self._sftp is not None:
            return self._sftp
        self._conn = await asyncssh.connect(**_connect_kwargs(self.config))
        self._sftp = await self._conn.start_sftp_client()
        return self._sftp

    async def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None
            self._sftp = None

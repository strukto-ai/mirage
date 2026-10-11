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

from mirage.accessor.base import Accessor
from mirage.accessor.imap import IMAPClient
from mirage.core.email.config import EmailConfig
from mirage.vfs.secrets import reveal_secret


class EmailAccessor(Accessor):
    def __init__(self, config: EmailConfig) -> None:
        self.config = config
        self._imap: IMAPClient | None = None
        # Held from a SELECT to the last command that reads the mailbox
        # it chose, so a concurrent task cannot select another in between.
        self.mailbox_lock = asyncio.Lock()

    async def get_imap(self) -> IMAPClient:
        """The connected IMAP client, connecting on first use and again
        after the last connection ended (a socket timeout or reset the
        server's side caused included).
        """
        if self._imap is None or not self._imap.alive:
            self._imap = None
            client = await IMAPClient.connect(
                self.config.imap_host,
                self.config.imap_port,
                self.config.use_ssl,
            )
            response = await client.login(
                self.config.username, reveal_secret(self.config.password)
            )
            if response.result != "OK":
                detail = " ".join(
                    bytes(line).decode(errors="replace")
                    for line in response.lines
                )
                await client.close()
                raise ConnectionError(
                    f"IMAP login failed for {self.config.username} on "
                    f"{self.config.imap_host}: {detail or response.result}"
                )
            self._imap = client
        return self._imap

    async def close(self) -> None:
        """Log out and drop the cached IMAP connection.

        Safe to call when no connection was ever opened; CLI verbs call
        this in a finally so a per-command accessor never leaks a socket.
        """
        if self._imap is not None and self._imap.alive:
            await self._imap.logout()
        self._imap = None

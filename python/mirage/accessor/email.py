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

import aioimaplib

from mirage.accessor.base import Accessor
from mirage.core.email.config import EmailConfig
from mirage.resource.secrets import reveal_secret


class EmailAccessor(Accessor):

    def __init__(self, config: EmailConfig) -> None:
        self.config = config
        self._imap: aioimaplib.IMAP4_SSL | None = None

    async def get_imap(self) -> aioimaplib.IMAP4_SSL:
        if self._imap is None or self._imap.protocol is None:
            if self.config.use_ssl:
                self._imap = aioimaplib.IMAP4_SSL(
                    host=self.config.imap_host,
                    port=self.config.imap_port,
                )
            else:
                self._imap = aioimaplib.IMAP4(
                    host=self.config.imap_host,
                    port=self.config.imap_port,
                )
            await self._imap.wait_hello_from_server()
            response = await self._imap.login(
                self.config.username, reveal_secret(self.config.password))
            if response.result != "OK":
                detail = " ".join(
                    line.decode(errors="replace") if isinstance(
                        line, (bytes, bytearray)) else str(line)
                    for line in (response.lines or []))
                self._imap = None
                raise ConnectionError(
                    f"IMAP login failed for {self.config.username} on "
                    f"{self.config.imap_host}: {detail or response.result}")
        return self._imap

    async def close(self) -> None:
        """Log out and drop the cached IMAP connection.

        Safe to call when no connection was ever opened; CLI verbs call
        this in a finally so a per-command accessor never leaks a socket.
        """
        if self._imap is not None and self._imap.protocol is not None:
            await self._imap.logout()
        self._imap = None

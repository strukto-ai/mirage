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

import pytest

from mirage.accessor.email import EmailAccessor
from mirage.core.email.config import EmailConfig


@pytest.mark.asyncio
async def test_a_reset_connection_is_dropped_and_the_next_access_reconnects():
    # The server greets, answers CAPABILITY, accepts LOGIN and then resets
    # the socket: the failure the TypeScript twin met as an uncaught
    # `error` event. Mirrored in email.test.ts.
    opened = 0

    async def serve(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        nonlocal opened
        opened += 1
        writer.write(b"* OK IMAP4rev1 ready\r\n")
        while line := await reader.readline():
            tag, _, rest = line.decode().partition(" ")
            if rest.upper().startswith("CAPABILITY"):
                writer.write(b"* CAPABILITY IMAP4rev1\r\n")
            writer.write(f"{tag} OK done\r\n".encode())
            if rest.upper().startswith("LOGIN"):
                await writer.drain()
                writer.transport.abort()
                return

    server = await asyncio.start_server(serve, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    accessor = EmailAccessor(
        EmailConfig(
            imap_host="127.0.0.1",
            imap_port=port,
            smtp_host="127.0.0.1",
            username="u",
            password="p",
            use_ssl=False,
        )
    )
    try:
        first = await accessor.get_imap()
        await asyncio.sleep(0.1)
        second = await accessor.get_imap()
        assert second is not first
        assert opened == 2
    finally:
        server.close()
        await server.wait_closed()

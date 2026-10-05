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
import base64
import hashlib
import sys

import pytest

BANNER = b"SSH-2.0-mirage\r\n"
GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
RELAY = (
    "import asyncio, sys\n"
    "from mirage.server.ssh.relay import relay_ssh\n"
    "asyncio.run(relay_ssh(sys.argv[1], {}))\n"
)


@pytest.mark.asyncio
async def test_relay_passes_on_a_first_frame_that_arrives_with_the_upgrade():
    # The 101 and the server's first frame go out in one write, so they
    # reach the relay in one read, as they do when its process is too busy
    # to read between them. The relay runs as the ProxyCommand does, on its
    # own stdio.
    writers: list[asyncio.StreamWriter] = []

    async def answer(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        writers.append(writer)
        request = await reader.readuntil(b"\r\n\r\n")
        key = next(
            line.split(b":", 1)[1].strip()
            for line in request.split(b"\r\n")
            if line.lower().startswith(b"sec-websocket-key:")
        )
        accept = base64.b64encode(hashlib.sha1(key + GUID).digest())
        writer.write(
            b"HTTP/1.1 101 Switching Protocols\r\n"
            b"Upgrade: websocket\r\nConnection: Upgrade\r\n"
            b"Sec-WebSocket-Accept: "
            + accept
            + b"\r\n\r\n"
            + bytes([0x82, len(BANNER)])
            + BANNER
        )
        await writer.drain()

    server = await asyncio.start_server(answer, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    child = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        RELAY,
        f"ws://127.0.0.1:{port}/",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
    )
    assert child.stdin is not None and child.stdout is not None
    try:
        banner = await asyncio.wait_for(
            child.stdout.readexactly(len(BANNER)), 30
        )
        assert banner == BANNER
    finally:
        for writer in writers:
            writer.close()
        child.stdin.close()
        await asyncio.wait_for(child.wait(), 30)
        server.close()
        await server.wait_closed()

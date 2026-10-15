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
import sys

from websockets.asyncio.client import ClientConnection, connect
from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed, InvalidStatus

from mirage.server.ssh.constants import TUNNEL_CHUNK


class TunnelRefused(Exception):
    """The server would not open the tunnel."""


async def relay_ssh(url: str, headers: dict[str, str]) -> None:
    """Carry this process's stdio over a workspace's SSH route.

    What an ssh ``ProxyCommand`` runs: ssh speaks on stdin and stdout,
    and the bytes travel over the server's HTTPS port, logged in by the
    bearer token instead of a key.

    Args:
        url (str): the workspace's ``/v1/workspaces/{id}/ssh`` URL, as
            ``ws://`` or ``wss://``.
        headers (dict[str, str]): request headers, the bearer token among
            them.

    Raises:
        TunnelRefused: the server answered the upgrade with an error.
    """
    try:
        ws = await connect(
            url, additional_headers=headers, max_size=None, compression=None
        )
    except InvalidStatus as exc:
        status = exc.response.status_code
        detail = exc.response.body.decode(errors="replace").strip()
        raise TunnelRefused(f"the server refused: {status} {detail}") from exc

    async def upload() -> None:
        loop = asyncio.get_running_loop()
        reader = asyncio.StreamReader()
        await loop.connect_read_pipe(
            lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer
        )
        while chunk := await reader.read(TUNNEL_CHUNK):
            await ws.send(chunk)
        await ws.close()

    async def download() -> None:
        async for message in ws:
            data = message if isinstance(message, bytes) else message.encode()
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()

    async with ws:
        tasks = [
            asyncio.create_task(upload()),
            asyncio.create_task(download()),
        ]
        _, pending = await asyncio.wait(
            tasks, return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()
        for task in tasks:
            try:
                await task
            except asyncio.CancelledError:
                continue
            except ConnectionClosed:
                continue


async def pump(
    source: ClientConnection | ServerConnection,
    sink: ClientConnection | ServerConnection,
) -> None:
    """Send every message ``source`` receives on to ``sink``, as it came.

    Args:
        source (ClientConnection | ServerConnection): where messages arrive.
        sink (ClientConnection | ServerConnection): where they go.
    """
    async for message in source:
        await sink.send(message)


async def relay_codex(
    host: str, port: int, url: str, headers: dict[str, str]
) -> None:
    """Serve ``codex exec-server forward`` on ``host:port``, until stopped.

    Each connection forward opens is carried to the workspace's
    codex-exec route, one message for one message, logged in by the
    bearer token forward cannot send itself.

    Args:
        host (str): the address to listen on.
        port (int): the port to listen on; 0 picks a free one.
        url (str): the workspace's ``/v1/workspaces/{id}/codex-exec``
            URL, as ``ws://`` or ``wss://``.
        headers (dict[str, str]): request headers, the bearer token among
            them.
    """

    async def carry(incoming: ServerConnection) -> None:
        try:
            upstream = await connect(
                url,
                additional_headers=headers,
                max_size=None,
                compression=None,
            )
        except InvalidStatus as exc:
            status = exc.response.status_code
            detail = exc.response.body.decode(errors="replace").strip()
            print(
                f"mirage: codex-exec: the server refused: {status} {detail}",
                file=sys.stderr,
            )
            await incoming.close(1011, f"the server refused: {status}")
            return
        async with upstream:
            tasks = [
                asyncio.create_task(pump(incoming, upstream)),
                asyncio.create_task(pump(upstream, incoming)),
            ]
            _, pending = await asyncio.wait(
                tasks, return_when=asyncio.FIRST_COMPLETED
            )
            for task in pending:
                task.cancel()
            for task in tasks:
                try:
                    await task
                except asyncio.CancelledError:
                    continue
                except ConnectionClosed:
                    continue

    async with serve(
        carry, host, port, max_size=None, compression=None
    ) as server:
        for sock in server.sockets:
            address, bound = sock.getsockname()[:2]
            if ":" in address:
                address = f"[{address}]"
            print(
                f"mirage: codex-exec: listening on ws://{address}:{bound}",
                file=sys.stderr,
            )
        await server.serve_forever()

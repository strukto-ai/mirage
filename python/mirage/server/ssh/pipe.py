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
import logging

import asyncssh

from mirage.concurrency.limiter import on_loop
from mirage.server.registry import WorkspaceEntry, WorkspaceRegistry
from mirage.server.ssh.constants import TUNNEL_CHUNK
from mirage.server.ssh.login import still_served
from mirage.server.ssh.stream import deliver
from mirage.server.stdin import LoopStdin

logger = logging.getLogger(__name__)


class PipeInput:
    """A piped channel's bytes, as the stdin its line reads.

    Args:
        reader (asyncssh.SSHReader[bytes]): the channel's input.
    """

    def __init__(self, reader: asyncssh.SSHReader[bytes]) -> None:
        self._reader = reader

    async def read(self) -> bytes:
        return await self._reader.read(TUNNEL_CHUNK)


async def serve_pipe(
    registry: WorkspaceRegistry,
    entry: WorkspaceEntry,
    session_id: str,
    line: str,
    reader: asyncssh.SSHReader[bytes],
    writer: asyncssh.SSHWriter[bytes],
    door: str,
) -> int:
    """Run ``line`` with a channel as its stdin and its stdout, as a
    login's lines run, so it reaches what they reach.

    The channel's bytes are the line's input and its output is the
    channel's, while its stderr is only logged. The pipe ends with the
    line, and the channel closing hangs the line up
    (``Workspace.hangup``). The session is the pipe's: it closes when
    the line has ended.

    Args:
        registry (WorkspaceRegistry): the daemon's workspaces.
        entry (WorkspaceEntry): the workspace the session opened in.
        session_id (str): the session the line runs as.
        line (str): the shell line.
        reader (asyncssh.SSHReader[bytes]): the channel's input.
        writer (asyncssh.SSHWriter[bytes]): the channel's output.
        door (str): what the pipe carries, for the log.

    Returns:
        int: the line's status; 1 when it failed to run.
    """
    runner = entry.runner
    loop = asyncio.get_running_loop()

    async def write(data: bytes) -> None:
        writer.write(data)
        await writer.drain()

    async def send(data: bytes, stderr: bool) -> None:
        if stderr:
            logger.debug("ssh: %s: %r", door, data)
            return
        await on_loop(write(data), loop)

    async def run() -> int:
        async with await runner.ws.shell(
            line,
            session_id=session_id,
            stdin=LoopStdin(PipeInput(reader), loop),
            record=False,
            stream=True,
        ) as execution:
            io = await deliver(execution, send)
        return io.exit_code

    async def hang_up() -> None:
        await writer.channel.wait_closed()
        if still_served(registry, entry):
            await runner.call(runner.ws.hangup(session_id))

    watch = asyncio.create_task(hang_up())
    try:
        status = await asyncio.wrap_future(
            asyncio.run_coroutine_threadsafe(run(), runner.loop)
        )
        logger.debug("ssh: %s ended: %d", door, status)
        return status
    except Exception as exc:
        logger.debug("ssh: %s ended: %r", door, exc)
        return 1
    finally:
        watch.cancel()
        await asyncio.wait([watch])
        if still_served(registry, entry):
            await runner.call(runner.ws.close_session(session_id))

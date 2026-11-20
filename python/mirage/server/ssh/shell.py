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
import concurrent.futures
import logging
from collections.abc import Callable, Coroutine
from typing import Any

import asyncssh
from opentelemetry import context

from mirage import Workspace
from mirage.concurrency.limiter import on_loop
from mirage.server.env import trace_headers
from mirage.server.registry import WorkspaceEntry, WorkspaceRegistry
from mirage.server.ssh.login import open_login, refuse, still_served
from mirage.server.ssh.stream import (
    ChannelInput,
    ChannelOutput,
    Mark,
    deliver,
)
from mirage.server.stdin import LoopStdin
from mirage.server.trace import request_context
from mirage.shell.bytes import decode_text, encode_text
from mirage.shell.constants import INTERRUPTED_STATUS
from mirage.utils.abort import MirageAbortError
from mirage.workspace.executor.statement import record_status

logger = logging.getLogger(__name__)

FALLBACK_PROMPT = "mirage$ "


def prompt(cwd: str) -> str:
    return f"mirage:{cwd}$ "


def ends_shell(line: str) -> bool:
    """Whether a typed line asks the interactive shell to leave.

    mirage contains ``exit`` within the line it runs, so the shell reads
    the words instead: ``exit`` or ``exit N`` leaves, while ``exit 1 2``
    is bash's "too many arguments" and stays.

    Args:
        line (str): the line as typed.
    """
    words = line.split()
    return bool(words) and words[0] == "exit" and len(words) <= 2


async def stamp_interrupt(ws: Workspace, session_id: str) -> None:
    """Leave ``$?`` at 130 after a Ctrl-C, as an interactive bash does.

    An aborted line puts ``$?`` back to what it found, because an
    abandoned invocation is the caller's outcome; an interactive shell
    is the caller here, and its outcome for an interrupted foreground
    line is 128 + SIGINT.

    Args:
        ws (Workspace): the workspace, on its own loop.
        session_id (str): the session the line ran as.
    """
    record_status(ws.get_session(session_id), INTERRUPTED_STATUS)


class ShellChannel:
    """One SSH session channel, run as one mirage session of its own.

    A command channel (``ssh host cmd``) runs its line and ends, and a
    shell channel reads lines until ``exit`` or end of input, printing a
    prompt when the client asked for a terminal. The session is fresh
    per channel, as each channel is a fresh process under sshd, so a
    ``cd`` never leaks from one channel to another and two channels
    never wait on each other's lines.

    A dropped connection ends the channel's lines as it ends a process
    under sshd: on a terminal it hangs them up, and without one it
    sends nothing, so the line runs on without input until it writes,
    where sshd's pipe would break, and is hung up then.

    Args:
        registry (WorkspaceRegistry): the daemon's workspaces.
        entry (WorkspaceEntry): the workspace this channel serves.
        session_id (str): the session the channel runs as.
        process (asyncssh.SSHServerProcess[str]): the channel's process.
    """

    def __init__(
        self,
        registry: WorkspaceRegistry,
        entry: WorkspaceEntry,
        session_id: str,
        process: asyncssh.SSHServerProcess[str],
    ) -> None:
        self._registry = registry
        self._entry = entry
        self._session_id = session_id
        self._process = process
        self._tty = process.term_type is not None
        self._input = ChannelInput(process)
        self._output = ChannelOutput(process, self._tty)
        self._running: concurrent.futures.Future[int] | None = None
        self._line: asyncio.Task[int] | None = None
        self._lost = False
        self._hung = False

    def _live(self) -> bool:
        return still_served(self._registry, self._entry)

    def _interrupt(self) -> None:
        line = self._line
        if line is not None:
            line.get_loop().call_soon_threadsafe(line.cancel)
        elif self._running is not None:
            self._running.cancel()

    async def _held(self, line: Callable[[], Coroutine[Any, Any, int]]) -> int:
        """Run a line as the task Ctrl-C cancels on the workspace loop.

        Cancelling that task, not the future the channel waits on, keeps
        the channel waiting until the line has ended: what the line
        leaves in ``$?`` as it unwinds lands before the interrupt's 130.

        Args:
            line (Callable[[], Coroutine[Any, Any, int]]): starts the line.
        """
        self._line = asyncio.current_task()
        try:
            return await line()
        finally:
            self._line = None

    async def _watch_close(self) -> None:
        await self._process.wait_closed()
        self._lost = True
        if not self._live():
            self._interrupt()
        elif self._tty:
            self._hang_up()

    def _hang_up(self) -> None:
        """Hang the channel's lines up (``Workspace.hangup``), once."""
        if self._hung or not self._live():
            return
        self._hung = True
        runner = self._entry.runner
        asyncio.run_coroutine_threadsafe(
            runner.ws.hangup(self._session_id), runner.loop
        ).add_done_callback(self._hung_up)

    def _hung_up(self, future: concurrent.futures.Future[int]) -> None:
        if not future.cancelled() and future.exception() is not None:
            logger.debug(
                "ssh: hangup of %s failed: %r",
                self._session_id,
                future.exception(),
            )

    def _prompt(self) -> str:
        if not self._live():
            return FALLBACK_PROMPT
        cwd = self._entry.runner.ws.get_session(self._session_id).cwd
        return prompt(cwd)

    async def serve(self) -> int:
        """Run the channel to its end.

        Returns:
            int: the exit status to report to the client.
        """
        self._input.start()
        watch = asyncio.create_task(self._watch_close())
        try:
            if self._process.command is not None:
                return await self.run(self._process.command)
            return await self.repl()
        finally:
            watch.cancel()
            await asyncio.wait([watch])
            await self._input.close()
            if self._live():
                runner = self._entry.runner
                await runner.call(runner.ws.close_session(self._session_id))

    async def run(self, line: str) -> int:
        """Run one line on the workspace's loop, streaming its output.

        Ctrl-C cancels the line where it is, and a dropped connection
        hangs it up (``Workspace.hangup``).
        Each write waits for the channel to drain, so a fast producer
        is paced by the client instead of buffered without bound. The
        status is read once the output has ended, because a streaming
        command settles it only then.

        Args:
            line (str): the shell line.

        Returns:
            int: the line's status; 130 when it was interrupted.
        """
        if not self._live():
            await self._output.write(
                b"mirage: the workspace is gone\n", stderr=True
            )
            return 1
        runner = self._entry.runner
        loop = asyncio.get_running_loop()

        async def send(data: bytes, stderr: bool) -> None:
            if self._lost:
                self._hang_up()
                return
            await on_loop(self._output.write(data, stderr), loop)

        async def run_line() -> int:
            try:
                async with await runner.ws.shell(
                    line,
                    session_id=self._session_id,
                    stdin=LoopStdin(self._input, loop),
                    stream=True,
                ) as execution:
                    io = await deliver(execution, send)
            except MirageAbortError:
                return INTERRUPTED_STATUS
            return io.exit_code

        self._running = asyncio.run_coroutine_threadsafe(
            self._held(run_line), runner.loop
        )
        self._input.on_interrupt(self._interrupt)
        try:
            return await asyncio.wrap_future(self._running)
        except asyncio.CancelledError:
            task = asyncio.current_task()
            if task is not None and task.cancelling():
                raise
            if self._lost:
                return INTERRUPTED_STATUS
            if self._live():
                await runner.call(stamp_interrupt(runner.ws, self._session_id))
            if self._tty:
                await self._output.write(b"^C\n")
            return INTERRUPTED_STATUS
        except Exception as exc:
            if self._lost:
                logger.debug("ssh: line ended with the connection: %r", exc)
                return 1
            logger.warning("ssh: line failed on %s: %r", self._entry.id, exc)
            await self._output.write(
                encode_text(f"mirage: {exc}\n"), stderr=True
            )
            return 1
        finally:
            self._input.on_interrupt(None)
            self._running = None

    async def repl(self) -> int:
        """Read and run lines until ``exit`` or end of input.

        Returns:
            int: the status of the last line run.
        """
        status = 0
        while not self._lost:
            if self._tty:
                await self._output.write(encode_text(self._prompt()))
            item = await self._input.readline()
            if item is Mark.LIMIT:
                await self._output.write(
                    b"mirage: shell input line too long\n", stderr=True
                )
                return 1
            if item is Mark.EOF:
                if self._tty:
                    await self._output.write(b"logout\n")
                return status
            if item is Mark.INTERRUPT:
                if self._tty:
                    await self._output.write(b"^C\n")
                status = INTERRUPTED_STATUS
                if self._live():
                    runner = self._entry.runner
                    await runner.call(
                        stamp_interrupt(runner.ws, self._session_id)
                    )
                continue
            line = decode_text(item).rstrip("\r\n")
            if not line.strip():
                continue
            status = await self.run(line)
            if ends_shell(line) or not self._live():
                return status
        return status


async def handle_channel(
    registry: WorkspaceRegistry, process: asyncssh.SSHServerProcess[str]
) -> None:
    """Serve one session channel: a command, or an interactive shell.

    The SSH username names the workspace. SFTP and scp never reach
    here: asyncssh hands them to the SFTP server.

    Args:
        registry (WorkspaceRegistry): the daemon's workspaces.
        process (asyncssh.SSHServerProcess[str]): the channel's process.
    """
    if process.subsystem is not None:
        refuse(process, f"unsupported subsystem: {process.subsystem}")
        return
    opened = await open_login(registry, process, "ssh")
    if opened is None:
        return
    entry, session_id = opened
    token = context.attach(request_context(trace_headers(process.env)))
    try:
        status = await ShellChannel(
            registry, entry, session_id, process
        ).serve()
    finally:
        context.detach(token)
    try:
        process.exit(status)
    except OSError as exc:
        logger.debug("ssh: channel closed before its status: %r", exc)

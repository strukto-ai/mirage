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
import uuid
from collections.abc import Awaitable, Callable

from mirage.context.session_context import current_caller
from mirage.io.stream import feed
from mirage.io.types import ByteSource
from mirage.machine.cloudflare_container.config import ContainerConfig
from mirage.machine.cloudflare_container.constants import (
    BOTH,
    CHECK_POLL_SECONDS,
    CLOSING,
    NO_CONTAINER,
    NOT_ANSWERING,
    SLEEP_RELAY,
    START_WAIT_SECONDS,
    STOPPED,
)
from mirage.machine.cloudflare_container.relay import RelayContainer
from mirage.machine.cloudflare_container.types import Container, ExecProcess
from mirage.machine.config import require_id
from mirage.machine.constants import (
    CHECK_LINE,
    EXEC_PRELUDE,
    PIPE_DIAGNOSTIC_BYTES,
    PIPE_DIAGNOSTIC_WAIT_SECONDS,
    PROCESS,
    STOP_GRACE_SECONDS,
    is_run,
    run_tag,
    stop_signal,
)
from mirage.machine.errors import ConnectionLostError
from mirage.machine.handle import MachineHandle
from mirage.machine.mixin import PipeTransportMixin, SleepableMixin
from mirage.machine.types import MachinePipe
from mirage.runtime.types import OutputFn, RunResult

logger = logging.getLogger(__name__)

READ_BYTES = 65536


def stopped(exc: BaseException) -> ConnectionLostError:
    """The lost connection a container that stopped under a line is.

    Args:
        exc (BaseException): what the container's call raised.
    """
    # shortcut: any exec failure counts as the container having stopped,
    # which Cloudflare's "not running" does; other failures are untested.
    logger.debug("cloudflare_container: the container stopped: %s", exc)
    return ConnectionLostError(
        STOPPED, b"", f"cloudflare_container: {STOPPED}\n".encode()
    )


async def drain(reader: asyncio.StreamReader, sink: OutputFn | None) -> bytes:
    """Read ``reader`` to its end: into ``sink``, or into the bytes
    returned when there is none. A read that fails is the connection
    lost.

    Args:
        reader (asyncio.StreamReader): one of the process's outputs.
        sink (OutputFn | None): receives each chunk; None keeps them for
            the result.
    """
    kept: list[bytes] = []
    while True:
        try:
            chunk = await reader.read(READ_BYTES)
        except Exception as exc:
            raise stopped(exc) from exc
        if not chunk:
            return b"".join(kept)
        if sink is None:
            kept.append(chunk)
        else:
            await sink(chunk)


class PipeInput:
    """A pipe command's stdin as a pipe writer. One write lands before
    the next is sent, and one that fails ends the command: bytes after a
    gap mean nothing.

    Args:
        proc (ExecProcess): the command.
        broken (Callable[[Exception], Awaitable[None]]): ends the command
            after a write that failed.
    """

    def __init__(
        self,
        proc: ExecProcess,
        broken: Callable[[Exception], Awaitable[None]],
    ) -> None:
        self._proc = proc
        self._broken = broken
        self._queue: asyncio.Queue[bytes | None] = asyncio.Queue()
        self._task = asyncio.create_task(self._send())

    def write(self, data: bytes) -> None:
        self._queue.put_nowait(bytes(data))

    def close(self) -> None:
        self._queue.put_nowait(None)

    async def _send(self) -> None:
        try:
            while (data := await self._queue.get()) is not None:
                await self._proc.stdin.write(data)
            await self._proc.stdin.close()
        except Exception as exc:
            await self._broken(exc)


class ContainerMachine(MachineHandle, PipeTransportMixin, SleepableMixin):
    """A Cloudflare Container, reached through a ``ContainerRelay``.

    ``url`` and ``token`` name a relay route (``RelayContainer``); the
    relay's Durable Object owns the container, and its image, instance
    type, network and quota are that Durable Object's, never config.
    Connecting starts the container, then waits for it to answer the
    check line. Every argv runs through the container's exec under
    ``EXEC_PRELUDE``, its stdin always piped and closed once the input
    ends, stdout and stderr as the program wrote them. A ``mount_type``
    serves the workspace over one more exec whose pipes carry SFTP.

    A host driving its own container may also give a ``sleep`` hook,
    which ``Workspace.sleep()`` runs after the handle closes: the host
    decides what sleep keeps and stops the container. A relay's container
    is the user's, so it takes no hook and sleep only disconnects it.

    Once the container stops, a line it cut short loses its connection
    (129), and the next line starts it again.

    Args:
        name (str): the machine's name, its key under ``machines:``.
        config (ContainerConfig | dict[str, Any] | None): the environment,
            how the container sees the workspace, and the relay.
        container (Container | None): a container to drive in place of
            a relay.
        start (Callable[[], Awaitable[None]] | None): starts that
            container when it is not running.
        sleep (Callable[[], Awaitable[None]] | None): what
            ``Workspace.sleep()`` does to that container once the handle
            has closed.
    """

    provider = "cloudflare_container"
    config_cls = ContainerConfig
    config: ContainerConfig

    def __init__(
        self,
        name: str,
        config: ContainerConfig | dict[str, str] | None = None,
        container: Container | None = None,
        start: Callable[[], Awaitable[None]] | None = None,
        sleep: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        super().__init__(name, config)
        # Watches the container the last connect reached until it exits.
        self._exited: asyncio.Task[None] | None = None
        # What each exec still running is told when the container exits,
        # and how many exits there have been.
        self._running: set[asyncio.Event] = set()
        self._exits = 0
        # Set while the workspace closes, when nothing starts a container.
        self._closing = False
        self._relay: RelayContainer | None = None
        self._container = container
        self._start = start
        self._sleep = sleep
        url, token = self.config.url, self.config.token
        if url is None:
            return
        if container is not None:
            raise ValueError(BOTH)
        if sleep is not None:
            raise ValueError(SLEEP_RELAY)
        require_id(self.provider, "url", url)
        require_id(self.provider, "token", token or "")
        self._relay = RelayContainer(url, token or "")
        self._container = self._relay
        self._start = self._relay.start

    async def connect(self) -> None:
        if self._container is None:
            raise RuntimeError(NO_CONTAINER)
        if self._closing:
            raise RuntimeError(f"cloudflare_container: {CLOSING}")
        if self._start is not None:
            await self._start()
        # shortcut: a start that never comes up fails this line after the
        # wait and the next line starts again; whether starting again at
        # once recovers is untested.
        last: BaseException | None = None
        try:
            async with asyncio.timeout(START_WAIT_SECONDS):
                while True:
                    try:
                        await self._exec(
                            ("/bin/sh", "-c", CHECK_LINE),
                            None,
                            dict(self.config.env),
                            "/",
                            None,
                            None,
                        )
                        # Only now: a container still starting refuses its
                        # calls, monitor() among them.
                        self._watch_exit(self._container)
                        return
                    except Exception as exc:
                        last = exc
                    await asyncio.sleep(CHECK_POLL_SECONDS)
        except TimeoutError as exc:
            raise RuntimeError(f"cloudflare_container: {NOT_ANSWERING}") from (
                last or exc
            )

    def _watch_exit(self, container: Container) -> None:
        """Have the next line connect, and so start the container, once
        ``container`` has exited.

        Args:
            container (Container): the container connect reached.
        """

        async def watch() -> None:
            try:
                await container.monitor()
            except Exception as exc:
                logger.debug(
                    "cloudflare_container: the container exited: %s", exc
                )
            if self._exited is not task:
                return
            self._exits += 1
            self._disconnected()
            for cut in self._running:
                cut.set()

        task = asyncio.create_task(watch())
        self._exited = task

    async def _exec(
        self,
        argv: tuple[str, ...],
        stdin: ByteSource | None,
        env: dict[str, str],
        cwd: str,
        output: OutputFn | None,
        errors: OutputFn | None,
    ) -> RunResult:
        """Run one argv in the container. What the container itself
        fails, its exec, its streams or its exit, is the connection lost
        (``ConnectionLostError``); the latch is the caller's to drop.

        Args:
            argv (tuple[str, ...]): the program and its arguments.
            stdin (ByteSource | None): the input; None for none.
            env (dict[str, str]): the merged environment.
            cwd (str): the working directory, passed through verbatim.
            output (OutputFn | None): receives stdout as it arrives.
            errors (OutputFn | None): receives stderr as it arrives.
        """
        if self._container is None:
            raise RuntimeError(NO_CONTAINER)
        runner = current_caller().process
        exits = self._exits
        try:
            proc = await self._container.exec(
                ["/bin/sh", "-c", EXEC_PRELUDE, "sh", cwd, *argv], env
            )
        except Exception as exc:
            raise stopped(exc) from exc
        exited = False
        cut = asyncio.Event()
        self._running.add(cut)
        # The container may have exited while exec was starting, before
        # this one listened.
        if self._exits != exits:
            cut.set()

        async def status() -> int:
            try:
                # Shielded: a line let go stops waiting; the process's
                # status is not its to cancel.
                return await asyncio.shield(proc.exit_code)
            except Exception as exc:
                raise stopped(exc) from exc

        async def finish() -> RunResult:
            out, err, code = await asyncio.gather(
                drain(proc.stdout, output),
                drain(proc.stderr, errors),
                status(),
            )
            return RunResult(stdout=out, stderr=err, exit_code=code)

        # A program may close its input early (head): its exit status ends
        # the line, not a write it refused.
        feeding = asyncio.create_task(
            feed(
                stdin,
                proc.stdin.write,
                proc.stdin.close,
                lambda: exited,
                lambda exc: True,
            )
        )
        finishing = asyncio.create_task(finish())
        cutting = asyncio.create_task(cut.wait())
        try:
            waiting = {finishing, cutting, feeding}
            while True:
                done, _ = await asyncio.wait(
                    waiting, return_when=asyncio.FIRST_COMPLETED
                )
                if finishing in done:
                    return finishing.result()
                if cutting in done:
                    raise stopped(RuntimeError("the container exited"))
                feeding.result()
                waiting.discard(feeding)
        except ConnectionLostError:
            raise
        except BaseException as exc:
            try:
                # A tagged command a gentler kill stopped is left to the
                # caller's stop, which sends that signal first.
                if (
                    not (PROCESS in env or is_run(argv))
                    or stop_signal(runner) is None
                ):
                    await proc.kill(9)
            except Exception as cleanup:
                logger.debug(
                    "cloudflare_container: the command was not killed: %s",
                    cleanup,
                )
            # The kill stops only the process exec started; the caller
            # stops a cancel.
            tag = run_tag(argv) if is_run(argv) else env.get(PROCESS)
            if tag is not None and not isinstance(exc, asyncio.CancelledError):
                await self.stop(tag, 15)
            raise
        finally:
            exited = True
            self._running.discard(cut)
            for task in (feeding, finishing, cutting):
                if not task.done():
                    task.cancel()
            await asyncio.gather(
                feeding, finishing, cutting, return_exceptions=True
            )
            # A line let go stops reading: a child its program left may
            # hold the output open.
            proc.release()

    async def _exec_argv(
        self,
        argv: tuple[str, ...],
        stdin: ByteSource | None,
        env: dict[str, str],
        cwd: str,
        output: OutputFn | None,
        errors: OutputFn | None,
    ) -> RunResult:
        try:
            return await self._exec(argv, stdin, env, cwd, output, errors)
        except ConnectionLostError:
            self._disconnected()
            raise

    async def exec_line(
        self,
        line: str,
        stdin: ByteSource | None,
        env: dict[str, str],
        cwd: str,
    ) -> RunResult:
        """Execute one shell line, under a ``PROCESS`` tag of its own
        when the caller gave none: a cancel kills only the shell exec
        started, so a cancelled line is stopped by that tag.

        Args:
            line (str): the raw shell line.
            stdin (ByteSource | None): bytes piped into the line.
            env (dict[str, str]): the merged environment.
            cwd (str): the working directory, passed through verbatim.
        """
        if PROCESS in env:
            return await super().exec_line(line, stdin, env, cwd)
        tag = uuid.uuid4().hex
        try:
            return await super().exec_line(
                line, stdin, {**env, PROCESS: tag}, cwd
            )
        except asyncio.CancelledError:
            await asyncio.shield(self.stop(tag, 15))
            raise

    async def close(self) -> None:
        """Unmount what the container was served, as any machine does,
        without starting a container that has stopped: what a close
        would clean up there went with its disk. The relay's session
        closes with it."""
        self._closing = True
        try:
            await super().close()
        finally:
            self._closing = False
            if (watching := self._exited) is not None:
                self._exited = None
                watching.cancel()
                await asyncio.gather(watching, return_exceptions=True)
            if self._relay is not None:
                await self._relay.close()

    async def sleep(self) -> None:
        """Run the host's sleep hook, if it gave one; without one, sleep
        only disconnects."""
        if self._sleep is not None:
            await self._sleep()

    async def open_pipe(self, command: str) -> MachinePipe:
        if self._container is None:
            raise RuntimeError(NO_CONTAINER)
        try:
            proc = await self._container.exec(["/bin/sh", "-c", command], {})
        except Exception as exc:
            self._disconnected()
            raise stopped(exc) from exc

        async def kill(signum: int) -> None:
            try:
                await proc.kill(signum)
            except Exception as exc:
                logger.debug(
                    "cloudflare_container: %s was not stopped: %s",
                    command,
                    exc,
                )

        async def broken(exc: Exception) -> None:
            logger.debug(
                "cloudflare_container: %s took no input: %s", command, exc
            )
            await kill(15)

        said = bytearray()

        async def keep(data: bytes) -> None:
            said.extend(data)
            del said[:-PIPE_DIAGNOSTIC_BYTES]

        async def wait() -> None:
            try:
                await asyncio.gather(
                    drain(proc.stderr, keep), asyncio.shield(proc.exit_code)
                )
            except Exception as exc:
                logger.debug(
                    "cloudflare_container: %s ended: %s", command, exc
                )

        exited = asyncio.create_task(wait())
        writer = PipeInput(proc, broken)

        async def stop() -> None:
            for signum in (15, 9):
                await kill(signum)
                done, _ = await asyncio.wait(
                    {exited}, timeout=STOP_GRACE_SECONDS
                )
                if done:
                    return
            logger.debug("cloudflare_container: %s did not exit", command)

        async def diagnostic() -> str:
            await asyncio.wait({exited}, timeout=PIPE_DIAGNOSTIC_WAIT_SECONDS)
            return said.decode(errors="replace").strip()

        return MachinePipe(proc.stdout, writer, stop, diagnostic)

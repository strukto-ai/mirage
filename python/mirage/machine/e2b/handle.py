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
from typing import Any

from mirage.context.session_context import current_caller
from mirage.io.stream import feed
from mirage.io.types import ByteSource
from mirage.machine.constants import (
    PROCESS,
    decode_output,
    encode_output,
    is_run,
    not_running_hint,
    run_tag,
    stop_signal,
    wrap_line,
)
from mirage.machine.e2b import sdk
from mirage.machine.e2b.config import E2BConfig
from mirage.machine.e2b.constants import (
    CLOSED_INPUT,
    PTY_MARK,
    PTY_RAW,
    SANDBOX_GONE,
)
from mirage.machine.errors import ConnectionLostError
from mirage.machine.handle import MachineHandle
from mirage.machine.mixin import PipeTransportMixin, SleepableMixin
from mirage.machine.types import MachinePipe
from mirage.runtime.constants import sdk_install_hint
from mirage.runtime.types import OutputFn, RunResult

logger = logging.getLogger(__name__)


def past_mark(data: bytes) -> int:
    """Where the PTY marker ends in ``data``, or -1 while it has not come.

    Args:
        data (bytes): the PTY's output so far.
    """
    at = data.find(PTY_MARK)
    return -1 if at < 0 else at + len(PTY_MARK)


class LineDecoder:
    """The bytes in output an ``encode_output`` command streams, decoded
    a whole line at a time as its text arrives."""

    def __init__(self) -> None:
        self._held = ""

    def feed(self, text: str) -> bytes:
        lines, _, self._held = (self._held + text).rpartition("\n")
        return decode_output(lines)

    def flush(self) -> bytes:
        held, self._held = self._held, ""
        return decode_output(held)


class PtyWriter:
    """A PTY's stdin as a pipe writer.

    Writes queue, and one task sends what has queued in one E2B call, in
    order: each call is a round trip, so a reply split into many writes
    would otherwise cost one trip per write. A send that fails hands its
    error to ``fail`` and sends nothing more.

    Args:
        pty (Any): the sandbox's ``pty`` API.
        pid (int): the PTY's process.
        fail (Callable[[Exception], Awaitable[None]]): ends the pipe with
            the send's error.
    """

    def __init__(
        self,
        pty: Any,
        pid: int,
        fail: Callable[[Exception], Awaitable[None]],
    ) -> None:
        self._pty = pty
        self._pid = pid
        self._fail = fail
        self._queue: asyncio.Queue[bytes | None] = asyncio.Queue()
        self._task = asyncio.create_task(self._send())

    def write(self, data: bytes) -> None:
        self._queue.put_nowait(bytes(data))

    def close(self) -> None:
        self._queue.put_nowait(None)

    async def _send(self) -> None:
        while (data := await self._queue.get()) is not None:
            chunks = [data]
            ended = False
            while not ended and not self._queue.empty():
                more = self._queue.get_nowait()
                if more is None:
                    ended = True
                else:
                    chunks.append(more)
            try:
                await self._pty.send_stdin(self._pid, b"".join(chunks))
            except Exception as exc:
                await self._fail(exc)
                return
            if ended:
                return


class E2BMachine(MachineHandle, PipeTransportMixin, SleepableMixin):
    """A running E2B sandbox, reached through its SDK.

    You create the sandbox yourself (`e2b sandbox spawn` or the SDK);
    mirage only connects by ``sandbox_id`` and execs lines.
    ``api_key`` falls back to E2B_API_KEY. E2B's exec reports stdout
    and stderr separately, stdout as it arrives when streamed, each
    base64-encoded in the sandbox since the exec decodes output as text
    (``encode_output``: the sandbox needs dd and base64). Piped
    bytes use native stdin, chunk by chunk, followed by an explicit EOF;
    no input closes stdin when the command starts. The SDK's own
    command timeout is off: a command runs until mirage's limits stop
    it. A ``mount_type`` serves the workspace over a PTY, since E2B's
    exec decodes output as text.

    The sandbox is yours: Mirage never kills it, and pauses it only when
    its config says ``on_sleep: pause`` and the workspace sleeps. Once
    the SDK says it is gone, connecting fails with how to replace it, and a line
    it cut short loses its connection (129) with the same advice; the
    next line connects again.

    Args:
        name (str): the machine's name, its key under ``machines:``.
        config (E2BConfig | dict[str, Any] | None): how to reach the sandbox.
    """

    provider = "e2b"
    config_cls = E2BConfig
    config: E2BConfig

    _sandbox: Any = None
    # Set once a connect reaches the sandbox; sleep pauses only then.
    _reached: bool = False

    @property
    def instance(self) -> str:
        """The sandbox's id at E2B."""
        return self.config.sandbox_id

    def _api_params(self) -> dict[str, Any]:
        api_key = self.config.api_key
        return {"api_key": api_key} if api_key is not None else {}

    async def connect(self) -> None:
        if sdk.AsyncSandbox is None:
            raise ImportError(sdk_install_hint("e2b"))
        try:
            self._sandbox = await sdk.AsyncSandbox.connect(
                self.config.sandbox_id, **self._api_params()
            )
        except Exception as exc:
            if (hint := self._gone(exc)) is None:
                raise
            raise RuntimeError(hint) from exc
        self._reached = True

    async def sleep(self) -> None:
        """Pause the sandbox when the config says ``on_sleep: pause`` and
        this handle reached it, keeping its disk and memory; the next
        connect resumes it. A sandbox already gone has nothing to pause."""
        if self.config.on_sleep != "pause" or not self._reached:
            return
        try:
            await sdk.AsyncSandbox.pause(
                self.config.sandbox_id, **self._api_params()
            )
        except sdk.SandboxNotFoundException:
            logger.debug(
                "%s: sandbox already gone, nothing to pause",
                self.machine,
                exc_info=True,
            )

    def _gone(self, exc: BaseException) -> str | None:
        """How to replace the sandbox when ``exc`` says it is gone, else
        None.

        Args:
            exc (BaseException): what an SDK call raised.
        """
        if isinstance(exc, sdk.SandboxNotFoundException):
            state = "deleted"
        elif isinstance(exc, sdk.SandboxNotRunningException):
            state = "ended"
        else:
            return None
        return not_running_hint(
            "sandbox", self.config.sandbox_id, state, SANDBOX_GONE
        )

    def _lost(self, exc: BaseException) -> ConnectionLostError | None:
        """The lost connection ``exc`` is when it says the sandbox is
        gone, which also lets the next line connect again; None otherwise.

        Args:
            exc (BaseException): what an SDK call raised.
        """
        if (hint := self._gone(exc)) is None:
            return None
        self._disconnected()
        return ConnectionLostError(hint, b"", f"e2b: {hint}\n".encode())

    async def _exec_argv(
        self,
        argv: tuple[str, ...],
        stdin: ByteSource | None,
        env: dict[str, str],
        cwd: str,
        output: OutputFn | None,
        errors: OutputFn | None,
    ) -> RunResult:
        out, err = LineDecoder(), LineDecoder()

        async def emit(text: str) -> None:
            assert output is not None
            if data := out.feed(text):
                await output(data)

        async def emit_errors(text: str) -> None:
            assert errors is not None
            if data := err.feed(text):
                await errors(data)

        try:
            handle = await self._sandbox.commands.run(
                encode_output(wrap_line(argv, env, cwd)),
                background=True,
                stdin=stdin is not None,
                on_stdout=emit if output is not None else None,
                on_stderr=emit_errors if errors is not None else None,
                timeout=0,
            )
        except Exception as exc:
            if (lost := self._lost(exc)) is None:
                raise
            raise lost from exc
        exited = asyncio.Event()

        async def write(chunk: bytes) -> None:
            if chunk:
                await handle.send_stdin(chunk)

        async def end() -> None:
            if stdin is not None:
                await handle.close_stdin()

        # The command may exit before the input RPC arrives, or close its
        # input while it runs (head): its real exit status decides.
        feeding = asyncio.create_task(
            feed(
                stdin,
                write,
                end,
                exited.is_set,
                lambda exc: (
                    self._gone(exc) is None
                    and (
                        isinstance(exc, sdk.NotFoundException)
                        or (
                            isinstance(exc, sdk.SandboxException)
                            and any(
                                message in str(exc) for message in CLOSED_INPUT
                            )
                        )
                    )
                ),
            )
        )

        async def wait_exit() -> Any:
            # The command may end without reading all its input (head), so
            # its exit, not the end of the input, ends the line.
            try:
                result = await handle.wait()
            except sdk.CommandExitException as exc:
                result = exc
            exited.set()
            if not feeding.done():
                feeding.cancel()
            return result

        exiting = asyncio.create_task(wait_exit())
        try:
            await asyncio.gather(feeding, exiting)
            result = exiting.result()
        except BaseException as exc:
            if (lost := self._lost(exc)) is not None:
                raise lost from exc
            # A tagged command a kill stopped with a gentler signal is left
            # to the caller's stop, which sends it that signal first.
            try:
                if (
                    not (PROCESS in env or is_run(argv))
                    or stop_signal(current_caller().process) is None
                ):
                    await handle.kill()
            except Exception:
                logger.warning("Failed to stop the E2B command", exc_info=True)
            # The kill stops only the encoding shell; the caller stops a cancel.
            tag = run_tag(argv) if is_run(argv) else env.get(PROCESS)
            if tag is not None and not isinstance(exc, asyncio.CancelledError):
                await self.stop(tag, 15)
            raise
        finally:
            for task in (feeding, exiting):
                if not task.done():
                    task.cancel()
            await asyncio.gather(feeding, exiting, return_exceptions=True)
            await handle.disconnect()
        if output is not None and (data := out.flush()):
            await output(data)
        if errors is not None and (data := err.flush()):
            await errors(data)
        return RunResult(
            stdout=decode_output(str(result.stdout))
            if output is None
            else b"",
            stderr=decode_output(str(result.stderr))
            if errors is None
            else b"",
            exit_code=int(result.exit_code),
        )

    async def exec_line(
        self,
        line: str,
        stdin: ByteSource | None,
        env: dict[str, str],
        cwd: str,
    ) -> RunResult:
        """Execute one shell line, under a ``PROCESS`` tag of its own
        when the caller gave none: a cancel kills only the encoding shell,
        so a cancelled line is stopped by that tag.

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

    async def open_pipe(self, command: str) -> MachinePipe:
        reader = asyncio.StreamReader()
        head = bytearray()
        started = False

        def on_data(data: bytes) -> None:
            nonlocal started
            if started:
                reader.feed_data(data)
                return
            head.extend(data)
            past = past_mark(bytes(head))
            if past >= 0:
                started = True
                rest = bytes(head[past:])
                if rest:
                    reader.feed_data(rest)

        pty = self._sandbox.pty
        try:
            handle = await pty.create(
                sdk.PtySize(rows=24, cols=80), on_data=on_data, timeout=0
            )
        except Exception as exc:
            if (lost := self._lost(exc)) is None:
                raise
            raise lost from exc

        async def fail(exc: Exception) -> None:
            reader.set_exception(exc)
            try:
                await stop()
            except Exception:
                logger.debug(
                    "e2b: stopping the PTY for %r failed",
                    command,
                    exc_info=True,
                )

        writer = PtyWriter(pty, handle.pid, fail)

        async def wait() -> None:
            try:
                await handle.wait()
            except Exception as exc:
                logger.debug("e2b: the PTY for %r ended: %s", command, exc)
            finally:
                reader.feed_eof()
                writer.close()

        waiter = asyncio.create_task(wait())

        async def stop() -> None:
            if not waiter.done():
                await pty.kill(handle.pid)
            await waiter

        try:
            await pty.send_stdin(handle.pid, f"{PTY_RAW}{command}\n".encode())
        except BaseException as exc:
            try:
                await stop()
            except Exception:
                logger.debug(
                    "e2b: stopping the PTY for %r failed",
                    command,
                    exc_info=True,
                )
            if (lost := self._lost(exc)) is not None:
                raise lost from exc
            raise
        return MachinePipe(reader, writer, stop)

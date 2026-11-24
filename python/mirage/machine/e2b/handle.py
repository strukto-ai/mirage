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
from functools import cached_property
from math import ceil
from time import monotonic
from typing import Any, cast

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
from mirage.machine.e2b.config import E2BConfig
from mirage.machine.e2b.constants import (
    BUSY_REFRESH_SECONDS,
    BUSY_TIMEOUT_SECONDS,
    CLOSED_INPUT,
    DEFAULT_TEMPLATE,
    IDLE_MARGIN_SECONDS,
    IDLE_TIMEOUT_SECONDS,
    PTY_MARK,
    PTY_RAW,
    SANDBOX_GONE,
)
from mirage.machine.e2b.sdk import E2bSdk
from mirage.machine.errors import ConnectionLostError
from mirage.machine.handle import MachineHandle
from mirage.machine.mixin import PipeTransportMixin
from mirage.machine.types import MachinePipe
from mirage.runtime.types import OutputFn, RunAnswer, RunResult

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


class E2BMachine(MachineHandle, PipeTransportMixin):
    """An E2B sandbox, reached through its SDK.

    Yours, by ``sandbox_id`` (`e2b sandbox spawn` or the SDK), or,
    without one, a sandbox Mirage starts from ``template`` at the first
    run that needs it and keeps in the workspace's memory: a later build
    connects to it again (resuming it when paused), and one that is gone
    is started anew. Mirage pauses a sandbox it started as the workspace
    closes and kills it as the workspace is deleted. While Mirage has work
    there (a program's run or one of its own lines) the sandbox's E2B
    timeout is ``BUSY_TIMEOUT_SECONDS``, pushed out every
    ``BUSY_REFRESH_SECONDS``; once the work ends it is ``idle_timeout``,
    after which E2B pauses the sandbox itself, and the next work resumes
    it. ``api_key`` falls back to E2B_API_KEY.
    E2B's exec reports stdout and stderr separately, stdout as it arrives
    when streamed, each base64-encoded in the sandbox since the exec
    decodes output as text (``encode_output``: the sandbox needs dd and
    base64). Piped bytes use native stdin, chunk by chunk, followed by an
    explicit EOF;
    no input closes stdin when the command starts. The SDK's own
    command timeout is off: a command runs until mirage's limits stop
    it. A ``mount_type`` serves the workspace over a PTY, since E2B's
    exec decodes output as text.

    A sandbox you brought is yours: Mirage never kills it, and pauses it
    only when the workspace pauses and its config says ``on_pause:
    pause`` or the call names it. Once
    the SDK says it is gone, connecting fails with how to replace it, and a line
    it cut short loses its connection (129) with the same advice; the
    next line connects again.

    Args:
        name (str): the machine's name, its key under ``machines:``.
        config (E2BConfig | dict[str, Any] | None): how to reach the sandbox.
    """

    provider = "e2b"
    pauses = True
    config_cls = E2BConfig
    config: E2BConfig

    @cached_property
    def _sdk(self) -> E2bSdk:
        return cast(E2bSdk, self._load_sdk("e2b", E2bSdk))

    _sandbox: Any = None

    def __init__(
        self, name: str, config: E2BConfig | dict[str, Any] | None = None
    ) -> None:
        super().__init__(name, config)
        # The sandbox this handle reaches: the config's, or the one Mirage
        # started; None before that.
        self._sandbox_id: str | None = self.config.sandbox_id
        # When Mirage's last work here ended, monotonic; None while it has
        # work or had none.
        self._idle_at: float | None = None
        # Pushes the busy timeout out again while Mirage's work here lasts.
        self._refresher: asyncio.Task[None] | None = None
        # The timeout, in seconds, still to send E2B, and the sending under
        # way.
        self._wanted: float | None = None
        self._pushing: asyncio.Task[None] | None = None
        # Whether the last timeout sent failed to arrive.
        self._missed = False
        # Whether the sandbox Mirage started here is one the workspace
        # failed to remember and that could not be killed either: the next
        # connect saves it.
        self._unsaved = False
        # Whether work that came out of idle found its busy timeout missed:
        # the sandbox may have paused first, so the next connect reaches it
        # anew.
        self._asleep = False

    @property
    def instance(self) -> str:
        """The sandbox's id at E2B; its name before Mirage starts one."""
        return self._sandbox_id if self._sandbox_id is not None else self.name

    def _api_params(self) -> dict[str, Any]:
        api_key = self.config.api_key
        return {"api_key": api_key} if api_key is not None else {}

    async def connect(self) -> None:
        """Connect to the config's sandbox, or to the one Mirage started
        for this workspace (resuming it when paused), or start one: from
        ``template``, set to pause itself on its timeout and stay paused
        until a connect resumes it (a call that reaches it paused, such as
        the SDK's own health check, leaves it paused), and remembered. A
        connect comes with work, so a started one's timeout is
        ``BUSY_TIMEOUT_SECONDS``. A started one that is
        gone is forgotten and started anew; the config's fails with how to
        replace it."""
        sandbox = self._sdk.AsyncSandbox
        if self.config.sandbox_id is None and self._sandbox_id is None:
            if self._memory is not None:
                self._sandbox_id = await self._memory.recall(self.name)
            self._started_here = self._sandbox_id is not None
        if self._sandbox_id is not None:
            params = self._api_params()
            if self._started_here:
                params["timeout"] = BUSY_TIMEOUT_SECONDS
            try:
                self._sandbox = await sandbox.connect(
                    self._sandbox_id, **params
                )
                if self._unsaved and self._memory is not None:
                    await self._memory.remember(self.name, self._sandbox_id)
                self._unsaved = False
                self._reached = True
                return
            except Exception as exc:
                if (hint := self._gone(exc)) is None:
                    raise
                if not self._started_here:
                    raise RuntimeError(hint) from exc
                if self._memory is not None:
                    await self._memory.forget(self.name)
                self._sandbox_id = None
        self._sandbox = await sandbox.create(
            self.config.template or DEFAULT_TEMPLATE,
            timeout=BUSY_TIMEOUT_SECONDS,
            lifecycle={"on_timeout": "pause", "auto_resume": False},
            metadata={"mirage_machine": self.name},
            **self._api_params(),
        )
        self._sandbox_id = self._sandbox.sandbox_id
        self._started_here = True
        if self._memory is not None:
            try:
                await self._memory.remember(self.name, self._sandbox_id)
            except Exception:
                await self._drop_unkept()
                raise
        self._reached = True

    async def _drop_unkept(self) -> None:
        """Kill a sandbox just started that the workspace could not keep:
        no later build would reach it, so it would outlive the workspace
        unseen. The next connect starts another. One the kill misses stays
        this handle's, so the next connect reaches it and saves it, and a
        delete removes it."""
        sandbox_id = self._sandbox_id
        self._sandbox = None
        if sandbox_id is None:
            return
        try:
            await self._sdk.AsyncSandbox.kill(sandbox_id, **self._api_params())
        except Exception:
            self._unsaved = True
            logger.debug(
                "%s: unkept sandbox %s not killed",
                self.machine,
                sandbox_id,
                exc_info=True,
            )
            return
        self._sandbox_id = None
        self._started_here = False

    async def _became_busy(self) -> None:
        """Keep a sandbox Mirage manages up while Mirage has work there:
        its E2B timeout goes to ``BUSY_TIMEOUT_SECONDS``, pushed out again
        every ``BUSY_REFRESH_SECONDS``. One whose idle timeout has passed
        has paused, and gets its timeout as the work's connect resumes it
        (``_stale``). Work that comes while the idle timeout runs waits for
        the busy one to land, or the sandbox could pause under it; when it
        misses, the sandbox may have paused first, and the work's connect
        reaches it anew."""
        if self.config.sandbox_id is not None:
            return
        if not self._lapsed():
            waking = self._idle_at is not None
            self._idle_at = None
            self._push(BUSY_TIMEOUT_SECONDS)
            if waking and self._pushing is not None:
                await asyncio.shield(self._pushing)
                if self._missed:
                    self._asleep = True
        if self._refresher is None:
            self._refresher = asyncio.get_running_loop().create_task(
                self._refresh()
            )

    def _became_idle(self) -> None:
        """Let a sandbox Mirage manages pause itself ``idle_timeout``
        after its work ends."""
        if self.config.sandbox_id is not None:
            return
        self._idle_at = monotonic()
        self._stop_refresher()
        self._push(self._idle_seconds())

    def _stale(self) -> bool:
        """A sandbox Mirage manages whose idle timeout has passed has
        paused: the next connect resumes it and reads its mounts anew."""
        if self.config.sandbox_id is not None or (
            not self._asleep and not self._lapsed()
        ):
            return False
        self._asleep = False
        self._idle_at = None
        return True

    def _lapsed(self) -> bool:
        """Whether the idle timeout has passed since Mirage's last work
        ended."""
        return (
            self._idle_at is not None
            and monotonic() - self._idle_at
            >= self._idle_seconds() - IDLE_MARGIN_SECONDS
        )

    def _idle_seconds(self) -> float:
        """Seconds the sandbox stays up once Mirage's work there ends."""
        idle = self.config.idle_timeout
        return idle if idle is not None else IDLE_TIMEOUT_SECONDS

    async def _refresh(self) -> None:
        """Push the busy timeout out every ``BUSY_REFRESH_SECONDS`` until
        the work ends."""
        while True:
            await asyncio.sleep(BUSY_REFRESH_SECONDS)
            self._push(BUSY_TIMEOUT_SECONDS)

    def _stop_refresher(self) -> None:
        if self._refresher is None:
            return
        self._refresher.cancel()
        self._refresher = None

    def _push(self, seconds: float) -> None:
        """Set a started sandbox's E2B timeout to ``seconds`` from now,
        without holding the work up. The timeouts go out one at a time,
        the newest asked replacing any not yet sent; a sandbox not started
        yet gets its timeout as it starts, and one that fails to arrive
        leaves the sandbox on the timeout it had (``_missed``).

        Args:
            seconds (float): the timeout from now.
        """
        if self._sandbox_id is None or not self._started_here:
            return
        self._wanted = seconds
        if self._pushing is None:
            self._pushing = asyncio.get_running_loop().create_task(
                self._send_timeouts()
            )

    async def _send_timeouts(self) -> None:
        try:
            while self._wanted is not None:
                seconds, self._wanted = self._wanted, None
                sandbox_id = self._sandbox_id
                if sandbox_id is None or not self._started_here:
                    continue
                try:
                    await self._sdk.AsyncSandbox.set_timeout(
                        sandbox_id, ceil(seconds), **self._api_params()
                    )
                    self._missed = False
                except Exception:
                    self._missed = True
                    logger.debug(
                        "%s: timeout not set", self.machine, exc_info=True
                    )
        finally:
            self._pushing = None

    async def destroy(self) -> None:
        """Kill the sandbox Mirage started for this workspace, as the
        workspace is deleted, and forget it; one the config names stays,
        with the mounts the workspace left there released. Reaches the one
        the workspace remembers when this build never connected."""
        if self.config.sandbox_id is not None:
            await self._release_mounts()
            return
        self._stop_refresher()
        sandbox_id = self._sandbox_id
        if sandbox_id is None and self._memory is not None:
            sandbox_id = await self._memory.recall(self.name)
        if sandbox_id is None:
            return
        await self._sdk.AsyncSandbox.kill(sandbox_id, **self._api_params())
        if self._memory is not None:
            await self._memory.forget(self.name)
        self._sandbox_id = None
        self._started_here = False

    def config_asks_to_pause(self) -> bool:
        """Whether the config says ``on_pause: pause``."""
        return self.config.on_pause == "pause"

    async def _pause_machine(self) -> None:
        """Pause the sandbox, keeping its disk and memory; the next connect
        resumes it. A sandbox already gone has nothing to pause."""
        self._stop_refresher()
        if self._sandbox_id is None:
            return
        try:
            await self._sdk.AsyncSandbox.pause(
                self._sandbox_id, **self._api_params()
            )
        except self._sdk.SandboxNotFoundException:
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
        if isinstance(exc, self._sdk.SandboxNotFoundException):
            state = "deleted"
        elif isinstance(exc, self._sdk.SandboxNotRunningException):
            state = "ended"
        else:
            return None
        return not_running_hint("sandbox", self.instance, state, SANDBOX_GONE)

    def _lost(self, exc: BaseException) -> ConnectionLostError | None:
        """The lost connection ``exc`` is when it says the sandbox is
        gone, which also lets the next line connect again; None otherwise.

        Args:
            exc (BaseException): what an SDK call raised.
        """
        if (hint := self._gone(exc)) is None:
            return None
        self._disconnected()
        return ConnectionLostError(hint)

    async def _exec_argv(
        self,
        argv: tuple[str, ...],
        stdin: ByteSource | None,
        env: dict[str, str],
        cwd: str,
        output: OutputFn,
        errors: OutputFn,
    ) -> RunResult:
        out, err = LineDecoder(), LineDecoder()

        async def emit(text: str) -> None:
            if data := out.feed(text):
                await output(data)

        async def emit_errors(text: str) -> None:
            if data := err.feed(text):
                await errors(data)

        try:
            handle = await self._sandbox.commands.run(
                encode_output(wrap_line(argv, env, cwd)),
                background=True,
                stdin=stdin is not None,
                on_stdout=emit,
                on_stderr=emit_errors,
                timeout=0,
            )
        except Exception as exc:
            if (lost := self._lost(exc)) is None:
                raise
            await errors(f"e2b: {lost}\n".encode())
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
                        isinstance(exc, self._sdk.NotFoundException)
                        or (
                            isinstance(exc, self._sdk.SandboxException)
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
            except self._sdk.CommandExitException as exc:
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
                await errors(f"e2b: {lost}\n".encode())
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
        if data := out.flush():
            await output(data)
        if data := err.flush():
            await errors(data)
        return RunResult(exit_code=int(result.exit_code))

    async def exec_line(
        self,
        line: str,
        stdin: ByteSource | None,
        env: dict[str, str],
        cwd: str,
        *,
        bounded: bool = False,
    ) -> RunAnswer:
        """Execute one shell line, under a ``PROCESS`` tag of its own
        when the caller gave none: a cancel kills only the encoding shell,
        so a cancelled line is stopped by that tag.

        Args:
            line (str): the raw shell line.
            stdin (ByteSource | None): bytes piped into the line.
            env (dict[str, str]): the merged environment.
            cwd (str): the working directory, passed through verbatim.
            bounded (bool): hold what it keeps to the workspace's memory
                room, for a line that reads a file's content.
        """
        if PROCESS in env:
            return await super().exec_line(
                line, stdin, env, cwd, bounded=bounded
            )
        tag = uuid.uuid4().hex
        try:
            return await super().exec_line(
                line, stdin, {**env, PROCESS: tag}, cwd, bounded=bounded
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
                self._sdk.PtySize(rows=24, cols=80), on_data=on_data, timeout=0
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

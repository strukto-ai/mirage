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
from collections.abc import Awaitable, Callable
from typing import Any

from mirage.io.stream import async_chain
from mirage.io.types import ByteSource
from mirage.runtime.sandbox.base import RemoteSandbox
from mirage.runtime.sandbox.constants import sdk_install_hint, wrap_line
from mirage.runtime.sandbox.e2b import sdk
from mirage.runtime.sandbox.e2b.config import E2BConfig
from mirage.runtime.sandbox.e2b.constants import BROKEN_PIPE, PTY_MARK, PTY_RAW
from mirage.runtime.sandbox.mixin import PipeTransportMixin
from mirage.runtime.types import OutputFn, RunResult, SandboxPipe

logger = logging.getLogger(__name__)


def past_mark(data: bytes) -> int:
    """Where the PTY marker ends in ``data``, or -1 while it has not come.

    Args:
        data (bytes): the PTY's output so far.
    """
    at = data.find(PTY_MARK)
    return -1 if at < 0 else at + len(PTY_MARK)


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


class E2BRuntime(RemoteSandbox, PipeTransportMixin):
    """An E2B sandbox the user runs as a whole-line runtime.

    You create the sandbox yourself (`e2b sandbox spawn` or the SDK);
    mirage only connects by ``sandbox_id`` and execs lines.
    ``api_key`` falls back to E2B_API_KEY. E2B's exec reports stdout
    and stderr separately, stdout as it arrives when streamed. Piped
    bytes use native stdin, chunk by chunk, followed by an explicit EOF;
    no input closes stdin when the command starts. The SDK's own
    command timeout is off: a command runs until mirage's limits stop
    it. A ``mount_type`` serves the workspace over a PTY, since E2B's
    exec decodes output as text.

    Args:
        captures (Sequence[str] | None): commands routed to this runtime.
        config (E2BConfig | dict[str, Any] | None): how to reach the sandbox.
    """

    name = "e2b"
    config_cls = E2BConfig
    config: E2BConfig
    _sandbox: Any = None

    def _api_params(self) -> dict[str, Any]:
        api_key = self.config.api_key
        return {"api_key": api_key} if api_key is not None else {}

    async def connect(self) -> None:
        if sdk.AsyncSandbox is None:
            raise ImportError(sdk_install_hint("e2b"))
        self._sandbox = await sdk.AsyncSandbox.connect(
            self.config.sandbox_id, **self._api_params()
        )

    async def _exec_argv(
        self,
        argv: tuple[str, ...],
        stdin: ByteSource | None,
        env: dict[str, str],
        cwd: str,
        output: OutputFn | None,
    ) -> RunResult:
        async def emit(text: str) -> None:
            assert output is not None
            await output(text.encode())

        handle = await self._sandbox.commands.run(
            wrap_line(argv, env, cwd),
            background=True,
            stdin=stdin is not None,
            on_stdout=emit if output is not None else None,
            timeout=0,
        )
        exited = asyncio.Event()

        async def feed() -> None:
            try:
                async for chunk in async_chain(
                    [stdin] if stdin is not None else []
                ):
                    if chunk:
                        await handle.send_stdin(chunk)
                if stdin is not None:
                    await handle.close_stdin()
            except asyncio.CancelledError:
                if not exited.is_set():
                    raise
                logger.debug("e2b command ended before consuming its input")
            except sdk.NotFoundException:
                # A command may exit before the input RPC arrives. Its exit
                # status, including nonzero exits, still determines the result.
                logger.debug("e2b command exited before its input arrived")
            except sdk.SandboxException as exc:
                if BROKEN_PIPE not in str(exc):
                    raise
                logger.debug("e2b command closed its input")

        feeding = asyncio.create_task(feed())

        async def reap() -> Any:
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

        reaping = asyncio.create_task(reap())
        try:
            await asyncio.gather(feeding, reaping)
            result = reaping.result()
        except BaseException:
            try:
                await handle.kill()
            except Exception:
                logger.warning("Failed to stop the E2B command", exc_info=True)
            raise
        finally:
            for task in (feeding, reaping):
                if not task.done():
                    task.cancel()
            await asyncio.gather(feeding, reaping, return_exceptions=True)
            await handle.disconnect()
        return RunResult(
            stdout=str(result.stdout).encode() if output is None else b"",
            stderr=str(result.stderr).encode(),
            exit_code=int(result.exit_code),
        )

    async def open_pipe(self, command: str) -> SandboxPipe:
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
        handle = await pty.create(
            sdk.PtySize(rows=24, cols=80), on_data=on_data, timeout=0
        )

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
            except sdk.CommandExitException as exc:
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
        except BaseException:
            try:
                await stop()
            except Exception:
                logger.debug(
                    "e2b: stopping the PTY for %r failed",
                    command,
                    exc_info=True,
                )
            raise
        return SandboxPipe(reader, writer, stop)

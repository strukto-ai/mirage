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
from typing import Any

from mirage.context.session_context import current_caller
from mirage.io.stream import async_chain
from mirage.io.types import ByteSource
from mirage.runtime.sandbox.base import RemoteSandbox
from mirage.runtime.sandbox.cli import STREAM_LIMIT
from mirage.runtime.sandbox.constants import wrap_line
from mirage.runtime.sandbox.mixin import PipeTransportMixin
from mirage.runtime.sandbox.ssh import sdk
from mirage.runtime.sandbox.ssh.config import SSHRuntimeConfig
from mirage.runtime.types import OutputFn, RunResult, SandboxPipe
from mirage.utils.ssh import connect_options

logger = logging.getLogger(__name__)


class SSHRuntime(RemoteSandbox, PipeTransportMixin):
    """A machine reached over SSH as a whole-line runtime.

    You run the machine and its sshd yourself; mirage only connects
    (keys or agent, never a password) and execs lines. One connection
    opens on the first captured line and is reused; each line is one
    exec channel with real byte stdin and separated stderr, streamed
    both ways, the merged environment and session cwd dressed onto the
    command by wrap_line, because SSH exec has no docker-style
    ``-w``/``-e``.

    This is the one provider whose machine usually IS the fileserver:
    mount the same host's directory over the ssh VFS at a prefix
    equal to its remote absolute path, and captured lines read and
    write those files natively, with no FUSE and no mirage installed
    remotely. Host keys are not verified (the TypeScript twin's ssh2
    transport never does), so treat the network path as trusted.

    Args:
        captures (Sequence[str] | None): commands routed to this runtime.
        config (SSHRuntimeConfig | dict[str, Any] | None): how to reach the sandbox.
    """

    name = "ssh"
    config_cls = SSHRuntimeConfig
    config: SSHRuntimeConfig
    _conn: Any = None

    def _connect_kwargs(self) -> dict[str, Any]:
        config = self.config
        kwargs = connect_options(
            config.host,
            config.hostname,
            config.port,
            config.username,
            config.identity_file,
            config.timeout,
        )
        kwargs["known_hosts"] = None
        return kwargs

    async def _ensure_connected(self) -> None:
        async with self._connect_lock:
            if self._conn is None or self._conn.is_closed():
                await self.connect()

    async def connect(self) -> None:
        if sdk.connect is None:
            raise ImportError(sdk.ASYNCSSH_HINT)
        self._conn = await sdk.connect(**self._connect_kwargs())

    async def _exec_argv(
        self,
        argv: tuple[str, ...],
        stdin: ByteSource | None,
        env: dict[str, str],
        cwd: str,
        output: OutputFn | None,
    ) -> RunResult:
        stdout, stderr, code = await self._ssh(
            wrap_line(argv, env, cwd), stdin, output
        )
        return RunResult(stdout=stdout, stderr=stderr, exit_code=code)

    async def _ssh(
        self,
        command: str,
        stdin: ByteSource | None,
        output: OutputFn | None = None,
    ) -> tuple[bytes, bytes, int]:
        """One exec channel on the connection; the seam tests override.

        Input is written as it is read, and closed at its end, or at once
        when nothing is piped: a finite command waits for that EOF.
        Output goes to ``output`` as it arrives when one is given. A line
        abandoned to a timeout, or whose reader went away, returns now:
        the command is signalled and its channel closed, with no wait
        for the remote side to finish; any other failure closes the
        channel.

        Args:
            command (str): the dressed command line.
            stdin (ByteSource | None): the input, or None for none.
            output (OutputFn | None): receives stdout as it arrives.
        """
        process = await self._conn.create_process(command, encoding=None)
        exited = asyncio.Event()

        async def feed() -> None:
            try:
                async for chunk in async_chain(
                    [stdin] if stdin is not None else []
                ):
                    process.stdin.write(chunk)
                    await process.stdin.drain()
                process.stdin.write_eof()
            except asyncio.CancelledError:
                if not exited.is_set():
                    raise
                logger.debug("ssh command ended before consuming its input")
            except (BrokenPipeError, ConnectionResetError):
                logger.debug("ssh command closed its input")

        async def read() -> bytes:
            parts: list[bytes] = []
            while chunk := await process.stdout.read(STREAM_LIMIT):
                if output is None:
                    parts.append(chunk)
                else:
                    await output(chunk)
            return b"".join(parts)

        feeding = asyncio.create_task(feed())

        async def reap() -> Any:
            result = await process.wait(check=False)
            exited.set()
            if not feeding.done():
                feeding.cancel()
            return result

        try:
            stdout, stderr, _, result = await asyncio.gather(
                read(), process.stderr.read(), feeding, reap()
            )
        except asyncio.CancelledError:
            # A kill that named a gentler signal leaves the command to the
            # reap, which sends it that signal first.
            runner = current_caller().process
            if runner is None or runner.signal in (None, 9):
                process.kill()
            raise
        finally:
            if not feeding.done():
                feeding.cancel()
            await asyncio.gather(feeding, return_exceptions=True)
            process.close()
        await process.wait_closed()
        code = result.returncode if result.returncode is not None else 1
        return stdout, stderr, 128 - code if code < 0 else code

    async def open_pipe(self, command: str) -> SandboxPipe:
        process = await self._conn.create_process(
            command, encoding=None, stderr=asyncio.subprocess.DEVNULL
        )

        async def stop() -> None:
            process.close()
            await process.wait_closed()

        return SandboxPipe(process.stdout, process.stdin, stop)

    async def close(self) -> None:
        await super().close()
        if self._conn is not None:
            self._conn.close()
            await self._conn.wait_closed()
            self._conn = None

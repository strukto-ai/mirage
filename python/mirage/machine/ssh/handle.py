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
from mirage.io.stream import feed
from mirage.io.types import ByteSource
from mirage.machine.constants import is_run, stop_signal, wrap_line
from mirage.machine.errors import ConnectionLostError
from mirage.machine.handle import MachineHandle
from mirage.machine.mixin import PipeTransportMixin
from mirage.machine.program import read_into
from mirage.machine.ssh import sdk
from mirage.machine.ssh.config import SSHMachineConfig
from mirage.machine.types import MachinePipe
from mirage.runtime.types import OutputFn, RunResult
from mirage.utils.ssh import connect_options

logger = logging.getLogger(__name__)


class SSHMachine(MachineHandle, PipeTransportMixin):
    """A host reached over SSH.

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
        name (str): the machine's name, its key under ``machines:``.
        config (SSHMachineConfig | dict[str, Any] | None): how to reach
            the machine.
    """

    provider = "ssh"
    config_cls = SSHMachineConfig
    config: SSHMachineConfig

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
            config.private_key,
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
        errors: OutputFn | None,
    ) -> RunResult:
        return await self._ssh(
            wrap_line(argv, env, cwd),
            stdin,
            output,
            errors,
            tagged=is_run(argv),
        )

    async def _ssh(
        self,
        command: str,
        stdin: ByteSource | None,
        output: OutputFn | None = None,
        errors: OutputFn | None = None,
        tagged: bool = False,
    ) -> RunResult:
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
            errors (OutputFn | None): receives stderr as it arrives.
            tagged (bool): whether the command is a program's run, so a
                cancelled run's stop ends it.
        """
        process = await self._conn.create_process(command, encoding=None)
        exited = asyncio.Event()

        async def write(chunk: bytes) -> None:
            process.stdin.write(chunk)
            await process.stdin.drain()

        async def end() -> None:
            process.stdin.write_eof()

        feeding = asyncio.create_task(feed(stdin, write, end, exited.is_set))

        async def wait_exit() -> Any:
            result = await process.wait(check=False)
            exited.set()
            if not feeding.done():
                feeding.cancel()
            return result

        # Kept here rather than by read_into, so a drop mid-read keeps them.
        out: list[bytes] = []
        err: list[bytes] = []

        async def keep_out(chunk: bytes) -> None:
            out.append(chunk)

        async def keep_err(chunk: bytes) -> None:
            err.append(chunk)

        try:
            _, _, _, result = await asyncio.gather(
                read_into(process.stdout, output or keep_out),
                read_into(process.stderr, errors or keep_err),
                feeding,
                wait_exit(),
            )
        except asyncio.CancelledError:
            # A run a kill stopped with a gentler signal is left to the
            # stop, which sends it that signal first.
            if not tagged or stop_signal(current_caller().process) is None:
                process.kill()
            raise
        except sdk.DisconnectError as exc:
            raise ConnectionLostError(
                f"the connection closed: {exc}",
                b"".join(out),
                b"".join(err) or None,
            ) from exc
        finally:
            if not feeding.done():
                feeding.cancel()
            await asyncio.gather(feeding, return_exceptions=True)
            process.close()
        await process.wait_closed()
        stdout, stderr = b"".join(out), b"".join(err) or None
        if result.returncode is None:
            raise ConnectionLostError(
                "the channel closed with no exit status", stdout, stderr
            )
        code = result.returncode
        return RunResult(
            stdout=stdout,
            stderr=stderr,
            exit_code=128 - code if code < 0 else code,
        )

    async def open_pipe(self, command: str) -> MachinePipe:
        process = await self._conn.create_process(
            command, encoding=None, stderr=asyncio.subprocess.DEVNULL
        )

        async def stop() -> None:
            process.close()
            await process.wait_closed()

        return MachinePipe(process.stdout, process.stdin, stop)

    async def close(self) -> None:
        await super().close()
        if self._conn is not None:
            self._conn.close()
            await self._conn.wait_closed()
            self._conn = None

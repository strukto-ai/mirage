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
from typing import Any

from mirage.context.session_context import current_caller
from mirage.io.stream import feed
from mirage.io.types import ByteSource
from mirage.io.yield_budget import YieldBudget
from mirage.machine.boxd import sdk
from mirage.machine.boxd.config import BoxdConfig
from mirage.machine.boxd.constants import MACHINE_GONE
from mirage.machine.constants import (
    PROCESS,
    is_run,
    not_running_hint,
    run_tag,
    stop_signal,
    wrap_line,
)
from mirage.machine.errors import ConnectionLostError
from mirage.machine.handle import MachineHandle
from mirage.runtime.constants import sdk_install_hint
from mirage.runtime.types import OutputFn, RunResult


class BoxdMachine(MachineHandle):
    """A boxd machine, reached through its SDK.

    You create the machine yourself (`boxd machine new`, the console or
    the SDK); mirage only connects by ``machine_id`` and execs lines.
    ``api_key`` falls back to BOXD_API_KEY and ``region`` to
    BOXD_REGION. Each line is one streamed exec: stdin is sent as it is
    read and then closed, and stdout and stderr come back separately,
    byte for byte, as the program writes them. No input closes stdin
    when the command starts. Ending the stream ends the command's
    process group. It takes no ``mount_type``: put the files the
    programs need on the machine yourself.

    The machine is yours: Mirage never starts, stops or deletes it. A
    machine in standby or hibernated wakes on the first line. Once boxd
    says it is gone or stopped, connecting fails with what to do, and a
    line it cut short loses its connection (129) with the same advice;
    the next line connects again. close() releases the SDK client.

    Args:
        name (str): the machine's name, its key under ``machines:``.
        config (BoxdConfig | dict[str, Any] | None): how to reach the machine.
    """

    provider = "boxd"
    config_cls = BoxdConfig
    config: BoxdConfig

    _client: Any = None

    @property
    def instance(self) -> str:
        """The machine's id at boxd."""
        return self.config.machine_id

    async def connect(self) -> None:
        if sdk.AsyncBoxd is None:
            raise ImportError(sdk_install_hint("boxd"))
        if self._client is None:
            self._client = sdk.AsyncBoxd(
                api_key=self.config.api_key, region=self.config.region
            )
        try:
            machine = await self._client.machines.get(self.config.machine_id)
        except Exception as exc:
            if (hint := self._gone(exc)) is None:
                raise
            raise RuntimeError(hint) from exc
        state = str(machine.status)
        if state in MACHINE_GONE:
            raise RuntimeError(
                not_running_hint(
                    "machine", self.config.machine_id, state, MACHINE_GONE
                )
            )

    def _gone(self, exc: BaseException) -> str | None:
        """What to do when ``exc`` says the machine is gone, else None.

        Args:
            exc (BaseException): what an SDK call raised.
        """
        if not isinstance(exc, sdk.NotFoundError):
            return None
        return not_running_hint(
            "machine", self.config.machine_id, "deleted", MACHINE_GONE
        )

    def _lost(
        self, exc: BaseException, stdout: bytes, stderr: bytes
    ) -> ConnectionLostError | None:
        """The lost connection ``exc`` is when the machine went or boxd
        could not be reached, which also lets the next line connect again;
        None otherwise.

        Args:
            exc (BaseException): what an SDK call raised.
            stdout (bytes): the output the line kept before the drop.
            stderr (bytes): the errors the line kept before the drop.
        """
        hint = self._gone(exc)
        if hint is None and isinstance(
            exc, (sdk.APIConnectionError, sdk.ConflictError)
        ):
            hint = str(exc)
        if hint is None:
            return None
        self._connected = False
        return ConnectionLostError(
            hint, stdout, stderr + f"boxd: {hint}\n".encode()
        )

    async def _exec_argv(
        self,
        argv: tuple[str, ...],
        stdin: ByteSource | None,
        env: dict[str, str],
        cwd: str,
        output: OutputFn | None,
        errors: OutputFn | None,
    ) -> RunResult:
        stream = self._client.machines.stream_exec(
            self.config.machine_id,
            command=wrap_line(argv, env, cwd),
            close_stdin=stdin is None,
        )
        out, err = bytearray(), bytearray()
        exited = asyncio.Event()

        async def read() -> int:
            async for chunk in stream.iter_chunks():
                if chunk.is_stderr:
                    if errors is None:
                        err.extend(chunk.data)
                    else:
                        await errors(chunk.data)
                elif output is None:
                    out.extend(chunk.data)
                else:
                    await output(chunk.data)
            exited.set()
            # As boxd's TypeScript SDK reads a stream that ended with no
            # chunk at all.
            code: int | None = stream.exit_code
            return -1 if code is None else code

        budget = YieldBudget()

        async def write(chunk: bytes) -> None:
            # The SDK queues input without waiting, so an input that is
            # always ready would never let the output or a cancel in.
            await stream.write(chunk)
            await budget.run()

        async def end() -> None:
            await stream.write_eof()

        reading = asyncio.create_task(read())
        feeding = (
            asyncio.create_task(feed(stdin, write, end, exited.is_set))
            if stdin is not None
            else None
        )
        try:
            # The command may end without reading all its input (head), so
            # its exit, not the end of the input, ends the line; an input
            # that fails as it is read ends it too.
            pending: set[asyncio.Task[Any]] = {reading}
            if feeding is not None:
                pending.add(feeding)
            while reading in pending:
                done, pending = await asyncio.wait(
                    pending, return_when=asyncio.FIRST_COMPLETED
                )
                if feeding in done:
                    feeding.result()
            exit_code = reading.result()
        except BaseException as exc:
            if feeding is not None:
                feeding.cancel()
                await asyncio.gather(feeding, return_exceptions=True)
            lost = self._lost(exc, bytes(out), bytes(err))
            # Ending the stream, or the read of it, ends the command with
            # TERM; a run a kill stopped with a gentler signal gets that
            # signal first.
            tag = run_tag(argv) if is_run(argv) else env.get(PROCESS)
            signum = stop_signal(current_caller().process)
            if lost is None and tag is not None and signum is not None:
                await asyncio.shield(self.stop(tag, signum))
            reading.cancel()
            await asyncio.gather(reading, return_exceptions=True)
            await stream.close()
            if lost is not None:
                raise lost from exc
            if tag is not None and not isinstance(exc, asyncio.CancelledError):
                await self.stop(tag, 15)
            raise
        if feeding is not None:
            feeding.cancel()
            await asyncio.gather(feeding, return_exceptions=True)
        await stream.close()
        return RunResult(
            stdout=bytes(out) if output is None else b"",
            stderr=bytes(err) if errors is None else b"",
            exit_code=exit_code,
        )

    async def close(self) -> None:
        """Release the SDK client; the machine itself is the user's."""
        try:
            await super().close()
        finally:
            if self._client is not None:
                client, self._client = self._client, None
                await client.close()

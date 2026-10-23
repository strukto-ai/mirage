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
import shlex
from collections.abc import AsyncIterator
from typing import Any

from mirage.commands.builtin.general.interpreter import run_output
from mirage.commands.builtin.utils.limit import run_with_timeout
from mirage.commands.config import Context
from mirage.context.session_context import current_caller, with_caller
from mirage.errors.types import CommandTimeoutError
from mirage.io import IOResult
from mirage.io.pipe import BytePipe
from mirage.io.stream import OutputStream, close_quietly
from mirage.io.types import ByteSource, OutputState, materialize
from mirage.policy import resolve_limit
from mirage.runtime.base import Runtime
from mirage.runtime.constants import EXTERNAL_COMMANDS
from mirage.runtime.mixin import ProcessExecutorMixin
from mirage.runtime.routing.types import RouteDecision
from mirage.runtime.types import ExecutionKind, OutputFn, RunResult
from mirage.shell.bytes import encode_text
from mirage.shell.console import Channel, JobConsole
from mirage.types import PathSpec, Producer
from mirage.utils.abort import MirageAbortError
from mirage.workspace.executor.command.run import admission_denial
from mirage.workspace.expand.argv import Argv
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import SessionState, env_snapshot
from mirage.workspace.types import ExecutionNode

logger = logging.getLogger(__name__)


async def run_external(
    argv: Argv,
    stdin: ByteSource | None,
    session: SessionState,
    registry: MountRegistry,
    routing: RouteDecision[Runtime[Any]],
    sink: JobConsole | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Execute one admitted program; its surrounding shell stays in Mirage.

    A program a process runtime streams writes its stderr into ``sink``
    as it arrives, where the statement it runs in writes (a job's
    console, a redirect, a compound body), so it lands beside its stdout
    and stays when the program is stopped; without one it comes back in
    the result.
    """
    bindings = routing.bindings
    runtime = bindings.get(argv.name, bindings.get(EXTERNAL_COMMANDS))
    command = shlex.join(argv.tokens)
    if runtime is None:
        denied = admission_denial(argv.name)
        err = await denied.materialize_stderr()
        return (
            None,
            denied,
            ExecutionNode(command=command, exit_code=126, stderr=err),
        )
    cwd = PathSpec.from_str_path(session.cwd)
    env = env_snapshot(session)
    guard = resolve_limit(
        argv.name,
        registry.mounts(),
        workspace_limits=registry.command_limits,
        profile_limits=session.command_limits,
    )

    if isinstance(runtime, ProcessExecutorMixin):
        return _stream_external(
            runtime,
            argv,
            stdin,
            cwd,
            env,
            registry,
            guard.timeout_seconds if guard is not None else None,
            sink,
        )

    async def execute() -> RunResult:
        data = await materialize(stdin) if stdin is not None else None
        ctx = Context(cwd=cwd, env=env, stdin=data, flags={"c": command})
        return await _execute_program(runtime, argv.name, [], ctx, "line")

    try:
        result = await run_with_timeout(
            execute(),
            guard.timeout_seconds if guard is not None else None,
            argv.name,
        )
    finally:
        await registry.settle(runtime)
    stdout, io = run_output(
        result,
        Producer(
            command=argv.name,
            prefixes=tuple(m.prefix for m in registry.mounts()),
        ),
    )
    return (
        stdout,
        io,
        ExecutionNode(
            command=command,
            exit_code=result.exit_code,
            stderr=result.stderr or b"",
        ),
    )


def _stream_external(
    runtime: Runtime[Any],
    argv: Argv,
    stdin: ByteSource | None,
    cwd: PathSpec,
    env: dict[str, str],
    registry: MountRegistry,
    timeout: float | None,
    sink: JobConsole | None,
) -> tuple[ByteSource, IOResult, ExecutionNode]:
    """Keep a process and its deadline alive until its bounded output is closed."""
    pipe = BytePipe()
    caller = current_caller()
    io = IOResult(
        producer=Producer(
            command=argv.name,
            prefixes=tuple(m.prefix for m in registry.mounts()),
            native=True,
        )
    )
    io.output = state = OutputState()
    node = ExecutionNode(command=shlex.join(argv.tokens), exit_code=0)
    task: asyncio.Task[None] | None = None
    settled = False
    closing: asyncio.Task[None] | None = None
    said: list[bytes] = []

    async def errors(chunk: bytes) -> None:
        # Stdout written before this chunk reaches the sink first, so the
        # two keep the order the program wrote them in (`> f 2>&1`); the
        # command's record keeps a copy for the policies that read it.
        said.append(chunk)
        assert sink is not None
        await pipe.drain()
        await sink.emit(Channel.STDERR, chunk)

    async def execute() -> None:
        nonlocal settled
        try:
            result = await run_with_timeout(
                _execute_program(
                    runtime,
                    argv.name,
                    list(argv.tokens),
                    Context(cwd=cwd, env=env, stdin=stdin),
                    "process",
                    pipe.write,
                    errors if sink is not None else None,
                ),
                timeout,
                argv.name,
            )
            if result.stdout:
                await pipe.write(result.stdout)
            io.exit_code = node.exit_code = result.exit_code
            io.stderr = result.stderr or b""
            node.stderr = b"".join(said) or io.stderr
            pipe.end()
        except BaseException as exc:
            pipe.end(exc)
            raise
        finally:
            settled = True
            await registry.settle(runtime)

    async def finalize() -> None:
        pipe.close_reader()
        if task is not None:
            if not task.done() and not settled:
                task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                current = asyncio.current_task()
                if current is not None and current.cancelling():
                    raise
                io.exit_code = node.exit_code = 141
            except Exception as exc:
                logger.debug("external stream ended: %s", exc)
        await close_quietly(stdin)
        state.finish()

    async def close() -> None:
        nonlocal closing
        if closing is None:
            closing = asyncio.create_task(finalize())
        await closing

    async def output() -> AsyncIterator[bytes]:
        nonlocal task
        task = asyncio.create_task(execute())
        try:
            async for chunk in pipe.stream():
                yield chunk
            await task
        finally:
            await close()

    return OutputStream(with_caller(output(), caller), close), io, node


async def _execute_program(
    runtime: Runtime[Any],
    name: str,
    texts: list[str],
    ctx: Context,
    kind: ExecutionKind,
    output: OutputFn | None = None,
    errors: OutputFn | None = None,
) -> RunResult:
    """Keep an ordinary launch failure within the command that caused it.

    Args:
        runtime (Runtime[Any]): the runtime the line routed to.
        name (str): the program's name, for a launch failure's message.
        texts (list[str]): the argv, or nothing for a line.
        ctx (Context): the run's context.
        kind (ExecutionKind): a process or a line.
        output (OutputFn | None): where a streamed process writes.
        errors (OutputFn | None): where it writes its stderr.
    """
    try:
        return await runtime.execute(
            [], texts, ctx, kind=kind, output=output, errors=errors
        )
    except (CommandTimeoutError, MirageAbortError):
        raise
    except Exception as exc:
        logger.debug("external program failed", exc_info=True)
        return RunResult(
            stdout=b"", stderr=encode_text(f"{name}: {exc}\n"), exit_code=1
        )

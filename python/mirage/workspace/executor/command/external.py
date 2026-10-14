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

from mirage.commands.builtin.utils.limit import run_with_timeout
from mirage.errors.types import CommandTimeoutError
from mirage.io import IOResult
from mirage.io.pipe import BytePipe
from mirage.io.stream import OutputStream, close_quietly
from mirage.io.types import ByteSource, OutputState, materialize
from mirage.policy import resolve_limit
from mirage.runtime.base import Runtime
from mirage.runtime.constants import EXTERNAL_COMMANDS
from mirage.runtime.mixin import ProcessExecutorMixin, StreamingProcessMixin
from mirage.runtime.routing.types import RouteDecision
from mirage.runtime.types import (
    ExecutionRequest,
    ProcessExecution,
    RunResult,
    ShellRequest,
    StreamExecution,
)
from mirage.shell.bytes import encode_text
from mirage.types import PathSpec, Producer
from mirage.utils.abort import MirageAbortError
from mirage.utils.context_scope import ContextScope
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
    routing: RouteDecision[Runtime] | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Execute one admitted program; its surrounding shell stays in Mirage."""
    bindings = (
        routing.bindings if routing is not None else registry.runtime_bindings
    )
    runtime = bindings.get(argv.name, bindings.get(EXTERNAL_COMMANDS))
    command = shlex.join(argv.tokens)
    if runtime is None:
        err = encode_text(f"{argv.name}: no runtime accepted this line\n")
        return (
            None,
            IOResult(exit_code=126, stderr=err),
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

    if isinstance(runtime, StreamingProcessMixin):
        return _stream_external(
            runtime,
            argv,
            stdin,
            cwd,
            env,
            registry,
            guard.timeout_seconds if guard is not None else None,
        )

    async def execute() -> RunResult:
        data = await materialize(stdin) if stdin is not None else None
        if isinstance(runtime, ProcessExecutorMixin):
            return await _execute_program(
                runtime,
                argv.name,
                ProcessExecution(
                    argv=argv.tokens, cwd=cwd, env=env, stdin=data
                ),
            )
        return await _execute_program(
            runtime,
            argv.name,
            ShellRequest(line=command, cwd=cwd, env=env, stdin=data),
        )

    try:
        result = await run_with_timeout(
            execute(),
            guard.timeout_seconds if guard is not None else None,
            argv.name,
        )
    finally:
        if not runtime.file_effects_dispatched:
            await registry.invalidate_after_external()
    io = IOResult(
        exit_code=result.exit_code,
        stderr=result.stderr or b"",
        producer=Producer(
            command=argv.name,
            prefixes=tuple(m.prefix for m in registry.mounts()),
        ),
    )
    return (
        result.stdout,
        io,
        ExecutionNode(
            command=command,
            exit_code=result.exit_code,
            stderr=result.stderr or b"",
        ),
    )


def _stream_external(
    runtime: Runtime,
    argv: Argv,
    stdin: ByteSource | None,
    cwd: PathSpec,
    env: dict[str, str],
    registry: MountRegistry,
    timeout: float | None,
) -> tuple[ByteSource, IOResult, ExecutionNode]:
    """Keep a process and its deadline alive until its bounded output is closed."""
    pipe = BytePipe()
    scope = ContextScope()
    io = IOResult(
        producer=Producer(
            command=argv.name,
            prefixes=tuple(m.prefix for m in registry.mounts()),
        )
    )
    io.output = state = OutputState()
    node = ExecutionNode(command=shlex.join(argv.tokens), exit_code=0)
    task: asyncio.Task[None] | None = None
    closing: asyncio.Task[None] | None = None

    async def execute() -> None:
        try:
            result = await run_with_timeout(
                _execute_program(
                    runtime,
                    argv.name,
                    StreamExecution(
                        argv=argv.tokens,
                        cwd=cwd,
                        env=env,
                        stdin=stdin,
                        output=pipe.write,
                    ),
                ),
                timeout,
                argv.name,
            )
            if result.stdout:
                await pipe.write(result.stdout)
            io.exit_code = node.exit_code = result.exit_code
            io.stderr = node.stderr = result.stderr or b""
            pipe.end()
        except BaseException as exc:
            pipe.end(exc)
            raise
        finally:
            if not runtime.file_effects_dispatched:
                await registry.invalidate_after_external()

    async def finalize() -> None:
        pipe.close_reader()
        if task is not None:
            if not task.done():
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

    return OutputStream(scope.stream(output()), close), io, node


async def _execute_program(
    runtime: Runtime, name: str, request: ExecutionRequest
) -> RunResult:
    """Keep an ordinary launch failure within the command that caused it."""
    try:
        return await runtime.execute(request)
    except (CommandTimeoutError, MirageAbortError):
        raise
    except Exception as exc:
        logger.debug("external program failed", exc_info=True)
        return RunResult(
            stdout=b"", stderr=encode_text(f"{name}: {exc}\n"), exit_code=1
        )

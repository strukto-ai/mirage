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
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

from mirage.commands.config import Context
from mirage.context.session_context import current_caller, with_caller
from mirage.io.pipe import BytePipe
from mirage.io.stream import OutputStream, close_quietly
from mirage.io.types import (
    ByteSource,
    CommandOutput,
    IOResult,
    OutputState,
    materialize,
)
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.types import CommandRuntime, OutputFn, RunResult
from mirage.types import PathSpec, Producer

logger = logging.getLogger(__name__)


def run_output(
    run: Callable[[OutputFn, OutputFn], Awaitable[RunResult]],
    producer: Producer | None = None,
    errors: OutputFn | None = None,
    stdin: ByteSource | None = None,
) -> CommandOutput:
    """A runtime run as a command's output, handed over as it runs.

    The one mapping from a run to a command's output shape: the
    interpreter commands, a script CLI, a program a runtime captured and
    a whole line all answer through here. The run starts when its output
    is first read and writes stdout into a bounded pipe, so a reader that
    falls behind holds the program back and the output is never held
    whole; what a transport could not stream lands at the end. The
    status, and the stderr the run returned, settle on the result as the
    output ends (``IOResult.output``), stderr after what the result
    already held. A reader that stops early stops the run, which then
    exits 141, as SIGPIPE leaves a program, and keeps the stderr it had
    written.

    Args:
        run (Callable[[OutputFn, OutputFn], Awaitable[RunResult]]):
            starts the run, given where it writes stdout and where it
            writes stderr.
        producer (Producer | None): what made the output, for a program
            run past the workspace's own commands.
        errors (OutputFn | None): takes stderr as the run writes it,
            after the stdout written before it has been read; None lands
            it on the result's stderr.
        stdin (ByteSource | None): the run's input, closed once the
            output ends.
    """
    pipe = BytePipe()
    caller = current_caller()
    io = IOResult(producer=producer)
    io.output = state = OutputState()
    task: asyncio.Task[None] | None = None
    settled = False
    closing: asyncio.Task[None] | None = None
    kept: list[bytes] = []

    async def ordered(chunk: bytes) -> None:
        # Stdout written before this chunk reaches its reader first, so
        # the two keep the order the program wrote them in (`2>&1`).
        assert errors is not None
        await pipe.drain()
        await errors(chunk)

    async def keep(chunk: bytes) -> None:
        kept.append(chunk)

    async def execute() -> None:
        nonlocal settled
        try:
            result = await run(
                pipe.write, ordered if errors is not None else keep
            )
            if result.stderr:
                kept.append(result.stderr)
            if result.stdout:
                await pipe.write(result.stdout)
            io.exit_code = result.exit_code
            pipe.end()
        except BaseException as exc:
            pipe.end(exc)
            raise
        finally:
            settled = True

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
                io.exit_code = 141
            except Exception as exc:
                logger.debug("runtime output ended: %s", exc)
        if kept:
            io.stderr = await materialize(io.stderr) + b"".join(kept)
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
        finally:
            await close()

    return OutputStream(with_caller(output(), caller), close), io


def run_interpreter(
    runtime: LanguageRuntime[Any],
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> CommandOutput:
    """Run an interpreter command's operands on its bound runtime, the
    program's output handed over as it runs (``run_output``).

    Args:
        runtime (LanguageRuntime[Any]): the runtime bound to the command.
        paths (list[PathSpec]): the path operands.
        texts (list[str]): the text operands.
        ctx (Context): the command's context, its flags the runtime's
            switches.
    """

    async def run(output: OutputFn, errors: OutputFn) -> RunResult:
        try:
            return await runtime.execute(
                paths, texts, ctx, output=output, errors=errors
            )
        finally:
            # The program may have written past the dispatcher.
            if ctx.runtime is not None and ctx.runtime.settle is not None:
                await ctx.runtime.settle()

    return run_output(run, stdin=ctx.stdin)


def not_bound(label: str, unavailable: str | None) -> CommandOutput:
    """The answer of an interpreter command no runtime runs.

    GNU wording (bash prints ``bash: python3: command not found``; the
    shell prefix is dropped workspace-wide), exit 127 whatever the
    operands say, unless the default world recorded why the entry failed
    to build. A bound entry without the interpreter entry point (not a
    ``LanguageRuntime``) is refused the same way: there is nothing to
    run code on. Mirrors TS ``notBound``.

    Args:
        label (str): the command name used in the message.
        unavailable (str | None): the dispatcher-recorded reason this
            command has no runtime (a default entry's build error),
            None when nothing captures it at all.
    """
    hint = unavailable or "command not found"
    return None, IOResult(exit_code=127, stderr=f"{label}: {hint}\n".encode())


async def runtime_version(
    runtime: LanguageRuntime[Any], env: dict[str, str] | None
) -> CommandOutput:
    async def run(output: OutputFn, errors: OutputFn) -> RunResult:
        return await runtime.version(env or {})

    return run_output(run)


def exec_refusal(
    label: str, script: PathSpec | None, placement: CommandRuntime
) -> CommandOutput | None:
    """Why policy will not let an interpreter command run its program;
    None when it may.

    The ``x`` check follows the program's entry point. A script operand
    asks ``exec_path_allowed`` about the script's own path, so a session
    whose only ``x`` grant is one show subtree runs scripts there and
    nowhere else; inline code (-c/-e), -m and stdin keep the
    whole-session rule (``exec_allowed``: any ``x`` grant), since no
    path holds them. Outside a workspace no entry point is wired and
    ``exec_allowed`` answers for files too.

    Args:
        label (str): the command name used in the message.
        script (PathSpec | None): the script operand, None for a program
            from -c, -m or stdin (``script_operand``).
        placement (CommandRuntime): the command's exec policy.
    """
    if script is not None:
        allowed = (
            placement.exec_path_allowed(script.virtual)
            if placement.exec_path_allowed is not None
            else placement.exec_allowed
        )
        if allowed:
            return None
        display = script.raw_path or script.virtual
        err = f"{label}: {display}: not in EXEC mode\n".encode()
        return None, IOResult(exit_code=126, stderr=err)
    if placement.exec_allowed:
        return None
    err = f"{label}: root mount '/' is not in EXEC mode\n".encode()
    return None, IOResult(exit_code=126, stderr=err)

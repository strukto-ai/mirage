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

import logging
import shlex
from typing import Any

from mirage.commands.builtin.general.interpreter import run_output
from mirage.commands.builtin.utils.limit import run_with_timeout
from mirage.commands.config import Context
from mirage.errors.types import CommandTimeoutError
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.policy import resolve_limit
from mirage.runtime.base import Runtime
from mirage.runtime.constants import EXTERNAL_COMMANDS
from mirage.runtime.mixin import ProcessExecutorMixin
from mirage.runtime.types import (
    ExecutionKind,
    OutputFn,
    RouteDecision,
    RunResult,
    RuntimeIdentity,
)
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
    routing: RouteDecision[RuntimeIdentity],
    sink: JobConsole | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Execute one admitted program; its surrounding shell stays in Mirage.

    Its output is handed over as it runs (``run_output``), within the
    program's deadline, kept alive until the output is closed. A program
    writes its stderr into ``sink`` as it arrives, where the statement it
    runs in writes (a job's console, a redirect, a compound body), so it
    lands beside its stdout and stays when the program is stopped;
    without one it comes back in the result.
    """
    bindings = routing.bindings
    entry = bindings.get(argv.name, bindings.get(EXTERNAL_COMMANDS))
    command = shlex.join(argv.tokens)
    if entry is None:
        denied = admission_denial(argv.name)
        err = await denied.materialize_stderr()
        return (
            None,
            denied,
            ExecutionNode(command=command, exit_code=126, stderr=err),
        )
    runtime = Runtime.require(entry)
    guard = resolve_limit(
        argv.name,
        registry.mounts(),
        workspace_limits=registry.command_limits,
        profile_limits=session.command_limits,
    )
    timeout = guard.timeout_seconds if guard is not None else None
    # A runtime that runs an argv gets one; a line runtime gets the
    # program as one quoted line.
    process = isinstance(runtime, ProcessExecutorMixin)
    kind: ExecutionKind = "process" if process else "line"
    ctx = Context(
        cwd=PathSpec.from_str_path(session.cwd),
        env=env_snapshot(session),
        stdin=stdin,
        flags={} if process else {"c": command},
    )
    node = ExecutionNode(command=command, exit_code=0)
    said: list[bytes] = []

    async def to_sink(chunk: bytes) -> None:
        # The command's record keeps a copy for the policies that read it.
        said.append(chunk)
        assert sink is not None
        await sink.emit(Channel.STDERR, chunk)

    async def run(output: OutputFn, errors: OutputFn | None) -> RunResult:
        try:
            result = await run_with_timeout(
                _execute_program(
                    runtime,
                    argv.name,
                    list(argv.tokens) if process else [],
                    ctx,
                    kind,
                    output,
                    errors,
                ),
                timeout,
                argv.name,
            )
        finally:
            await registry.settle(runtime)
        node.stderr = b"".join(said) or result.stderr or b""
        return result

    def settled() -> None:
        # The record takes the status the output settles with: 141 for a
        # reader that stopped early.
        node.exit_code = io.exit_code

    stdout, io = run_output(
        run,
        Producer(
            command=argv.name,
            prefixes=tuple(m.prefix for m in registry.mounts()),
            native=True,
        ),
        to_sink if sink is not None else None,
        stdin,
    )
    if io.output is not None:
        io.output.callbacks.append(settled)
    return stdout, io, node


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

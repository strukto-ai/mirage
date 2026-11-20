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
from mirage.commands.config import Context
from mirage.context import bind_caller, current_caller, reset_caller
from mirage.errors.types import CommandTimeoutError
from mirage.execution.process.types import ProcessTraits
from mirage.execution.types import MachineName
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.runtime.base import Runtime
from mirage.runtime.constants import WORKSPACE_PROVIDERS
from mirage.runtime.mixin import ProcessExecutorMixin
from mirage.runtime.types import (
    ExecutionKind,
    OutputFn,
    RunResult,
    RuntimeIdentity,
)
from mirage.shell.bytes import encode_text
from mirage.shell.console import Channel, JobConsole
from mirage.shell.constants import CANNOT_EXECUTE_STATUS
from mirage.types import PathSpec, Producer
from mirage.utils.abort import MirageAbortError
from mirage.workspace.executor.command.run import admission_denial
from mirage.workspace.expand.argv import Argv
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import SessionState, env_snapshot
from mirage.workspace.types import ExecutionNode

logger = logging.getLogger(__name__)


def handed_tokens(
    tokens: tuple[str, ...],
    traits: ProcessTraits,
    machine: MachineName | None,
) -> tuple[str, ...]:
    """The words a machine is handed for a program: on one with processes
    of its own, the wrappers around the program first (``nice -n 5
    gcc``), so they make their change there, with ``--`` before a program
    named like an option; Mirage's own ``in_process`` machine keeps them
    in the process it runs the program as.

    Args:
        tokens (tuple[str, ...]): the program's words.
        traits (ProcessTraits): what the wrappers around it changed.
        machine (MachineName | None): the machine that runs it.
    """
    if (
        not traits.wrappers
        or machine is None
        or machine.provider in WORKSPACE_PROVIDERS
    ):
        return tokens
    if tokens and tokens[0].startswith("-"):
        return (*traits.wrappers, "--", *tokens)
    return (*traits.wrappers, *tokens)


async def run_external(
    argv: Argv,
    stdin: ByteSource | None,
    session: SessionState,
    registry: MountRegistry,
    entry: RuntimeIdentity | None,
    sink: JobConsole | None = None,
    cwd: str | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Execute one admitted program; its surrounding shell stays in Mirage.

    Its output is handed over as it runs (``run_output``), within the
    program's deadline, kept alive until the output is closed. A program
    writes its stderr into ``sink`` as it arrives, where the statement it
    runs in writes (a job's console, a redirect, a compound body), so it
    lands beside its stdout and stays when the program is stopped;
    without one it lands on the result, kept as it arrives all the same.
    Where its stderr goes where its stdout goes (``2>&1``), the runtime
    is told so (``Caller.joins_errors``): a machine joins the two where
    the program writes them, so they keep the order it wrote them in. An
    ``exec`` that points either stream elsewhere inside the redirect
    (``{ exec 2>f; prog; } 2>&1``) parts them again, so the run is not
    joined while one holds.

    Args:
        argv (Argv): the program's words.
        stdin (ByteSource | None): what is piped into it.
        session (SessionState): the session it runs in.
        registry (MountRegistry): the workspace's mounts and runtimes.
        entry (RuntimeIdentity | None): the runtime; None for one the
            line's placement refuses.
        sink (JobConsole | None): where its stderr goes as it arrives.
        cwd (str | None): the folder it runs from; None for the
            session's own.
    """
    if entry is None:
        denied = admission_denial(argv.name)
        err = await denied.materialize_stderr()
        return (
            None,
            denied,
            ExecutionNode(
                command=shlex.join(argv.tokens),
                exit_code=CANNOT_EXECUTE_STATUS,
                stderr=err,
            ),
        )
    runtime = Runtime.require(entry)
    tokens = handed_tokens(
        argv.tokens, current_caller().traits, runtime.machine
    )
    command = shlex.join(tokens)
    # A runtime that runs an argv gets one; a line runtime gets the
    # program as one quoted line.
    process = isinstance(runtime, ProcessExecutorMixin)
    kind: ExecutionKind = "process" if process else "line"
    ctx = Context(
        cwd=PathSpec.from_str_path(session.cwd if cwd is None else cwd),
        env=env_snapshot(session),
        stdin=stdin,
        flags={} if process else {"c": command},
    )
    node = ExecutionNode(command=command, exit_code=0)
    said: list[bytes] = []

    async def to_sink(chunk: bytes) -> None:
        assert sink is not None
        await sink.emit(Channel.STDERR, chunk)

    async def run(output: OutputFn, errors: OutputFn) -> RunResult:
        async def told(chunk: bytes) -> None:
            # The command's record keeps a copy for the policies that
            # read it.
            said.append(chunk)
            await errors(chunk)

        joined = (
            bind_caller(current_caller().changed({"joins_errors": True}))
            if sink is not None
            and sink.joins_errors
            and session.exec_stdout is None
            and session.exec_stderr is None
            else None
        )
        try:
            result = await _execute_program(
                runtime,
                argv.name,
                list(tokens) if process else [],
                ctx,
                kind,
                output,
                told,
            )
        finally:
            if joined is not None:
                reset_caller(joined)
            await registry.settle(runtime)
        node.stderr = b"".join(said)
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
    output: OutputFn,
    errors: OutputFn,
) -> RunResult:
    """Keep an ordinary launch failure within the command that caused it.

    Args:
        runtime (Runtime[Any]): the runtime the line routed to.
        name (str): the program's name, for a launch failure's message.
        texts (list[str]): the argv, or nothing for a line.
        ctx (Context): the run's context.
        kind (ExecutionKind): a process or a line.
        output (OutputFn): where the process writes.
        errors (OutputFn): where it writes its stderr.
    """
    try:
        return await runtime.execute(
            [], texts, ctx, kind=kind, output=output, errors=errors
        )
    except (CommandTimeoutError, MirageAbortError):
        raise
    except Exception as exc:
        logger.debug("external program failed", exc_info=True)
        await errors(encode_text(f"{name}: {exc}\n"))
        return RunResult(exit_code=1)

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
from dataclasses import fields
from typing import Any

from mirage.commands.builtin.general.interpreter import run_output
from mirage.commands.builtin.utils.limit import (
    guard_io,
    guard_output,
    run_with_timeout,
)
from mirage.commands.config import Context
from mirage.io import IOResult
from mirage.io.types import ByteSource, materialize
from mirage.policy import (
    Claimant,
    ExecuteResultContext,
    post_execute_gate,
    refusal_of,
    render_deny,
    resolve_limit,
)
from mirage.policy.builtin.output_cap import LINE_NAME
from mirage.policy.types import RouteContext
from mirage.runtime.base import Runtime
from mirage.runtime.mixin import LineExecutorMixin
from mirage.runtime.types import OutputFn, RunResult
from mirage.shell.console import Channel, JobConsole
from mirage.types import Limit, PathSpec, Producer
from mirage.workspace.executor.jobs import pump
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import SessionState, env_snapshot
from mirage.workspace.types import ExecutionNode
from mirage.workspace.workspace.utils import command_name


async def run_whole_line(
    runtime: LineExecutorMixin[Any],
    command: str,
    stdin: ByteSource | None,
    session: SessionState,
    registry: MountRegistry,
    claimant: Claimant | None = None,
    cancel: asyncio.Event | None = None,
    route: RouteContext | None = None,
    sink: JobConsole | None = None,
    timeout: float | None = None,
    start: float | None = None,
) -> IOResult:
    """Hand the raw line to one runtime instead of walking its tree.

    A whole line is a command like any other: the same boundary
    consultation as the tree, so its deadline answers 124 and the
    policies' merged Limit caps the output. Its output is handed
    over as the runtime writes it (``run_output``): into ``sink`` as it
    comes, unless a ``post_execute`` policy must see it whole before any
    of it escapes, and back in the result without one.

    Args:
        runtime (LineExecutorMixin): the runtime that captured the
            whole line.
        command (str): the raw command line.
        stdin (ByteSource | None): bytes piped into the line.
        session (SessionState): session supplying cwd and env.
        registry (MountRegistry): the workspace's mounts, every one of
            which the line may span (a whole-line runtime sees the full
            workspace), its policies and its command defaults.
        claimant (Claimant | None): the line on its hand-off, where a
            ``post_execute`` approval is claimed.
        cancel (asyncio.Event | None): the run's kill channel.
        route (RouteContext | None): what ``pre_execute`` saw of the
            line, which ``post_execute`` sees with what came back; None
            when no policy reads ``post_execute``.
        sink (JobConsole | None): where the line writes; None returns
            its output in the result.
        timeout (float | None): the line's deadline in seconds; None for
            a line nested in one that holds it.
        start (float | None): the loop time the line's budget began.
    """
    assert isinstance(runtime, Runtime)
    name = command_name(command)
    mounts = registry.mounts()
    guard = resolve_limit(
        name,
        mounts,
        workspace_limits=registry.command_limits,
        profile_limits=session.command_limits,
    )
    ctx = Context(
        flags={"c": command},
        stdin=stdin,
        env=env_snapshot(session),
        cwd=PathSpec.from_str_path(session.cwd),
    )

    async def run(output: OutputFn, errors: OutputFn) -> RunResult:
        try:
            return await run_with_timeout(
                runtime.execute(
                    [], [], ctx, kind="line", output=output, errors=errors
                ),
                timeout,
                LINE_NAME,
                start,
            )
        finally:
            await registry.settle(runtime)

    producer = Producer(command=name, prefixes=tuple(m.prefix for m in mounts))
    shown = sink if route is None else None

    async def errors(chunk: bytes) -> None:
        assert shown is not None
        await shown.emit(Channel.STDERR, chunk)

    stdout, io = run_output(
        run, producer, errors if shown is not None else None, stdin
    )
    if route is None:
        out = guard_io(stdout, io, guard if session.terminal_output else None)
        if shown is None:
            data = await materialize(out)
            return IOResult(
                exit_code=io.exit_code, stdout=data, stderr=io.stderr
            )
        await pump(shown, Channel.STDOUT, out)
        return IOResult(exit_code=io.exit_code, stderr=io.stderr)
    data = await materialize(stdout)
    stderr = await io.materialize_stderr()
    refused, bound = await post_execute_gate(
        registry.policies,
        ExecuteResultContext(
            **{f.name: getattr(route, f.name) for f in fields(route)},
            producer=producer,
            exit_code=io.exit_code,
            output=data,
            results=ExecutionNode(
                command=command, stderr=stderr, exit_code=io.exit_code
            ).to_dict(),
        ),
        claimant,
        cancel,
    )
    if refused is not None:
        err, code = render_deny(name, refused)
        return IOResult(
            exit_code=code,
            stdout=None,
            stderr=stderr + err,
            refusal=refusal_of(refused),
        )
    capped, capped_err, exit_code = await guard_output(
        data,
        stderr or None,
        io.exit_code,
        Limit.aggr([guard if session.terminal_output else None, bound]),
    )
    return IOResult(exit_code=exit_code, stdout=capped, stderr=capped_err)

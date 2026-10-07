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
from dataclasses import replace
from functools import partial
from typing import Any, Callable

from mirage.commands.builtin.utils.limit import guard_output
from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.policy import (
    ExecuteResultContext,
    HandOff,
    post_execute_gate,
    refusal_of,
    render_deny,
)
from mirage.runtime.routing import RouteDecision
from mirage.runtime.types import DispatchFn
from mirage.shell.barrier import BarrierPolicy, apply_barrier
from mirage.shell.call_stack import CallStack
from mirage.shell.console import JobConsole, Terminal
from mirage.shell.helpers import input_substitution_redirect
from mirage.shell.job_table import JobTable
from mirage.types import PathSpec, Producer
from mirage.workspace.dispatcher.context import bind_dispatch
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.execution import ExecutionScope
from mirage.workspace.executor.builtins.scope import _to_scope
from mirage.workspace.executor.redirect import handle_redirect
from mirage.workspace.expand.redirects import expand_redirects
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.node.admission import Refused, admit
from mirage.workspace.node.execute_node import execute_node
from mirage.workspace.node.occurrence import claimant_for
from mirage.workspace.session import session_view
from mirage.workspace.session.access import io_context
from mirage.workspace.types import ExecutionNode


async def run_command_tree(
    dispatch: DispatchFn,
    registry: MountRegistry,
    namespace: Namespace,
    job_table: JobTable,
    execute_fn: Callable[..., Any],
    agent_id: str,
    ast: Any,
    context: EvaluationContext,
    stdin: Any,
    cancel: asyncio.Event | None,
    routing_decision: RouteDecision | None = None,
    handed: HandOff | None = None,
    sink: JobConsole | None = None,
    command_substitution: bool = False,
    call_stack: CallStack | None = None,
    execution_scope: ExecutionScope | None = None,
) -> tuple[IOResult, ExecutionNode]:
    """Run a parsed command tree and finalize its output stream.

    Executes the AST root, then applies the value barrier and the
    command limit, folding the limit's stderr and exit code
    into the result. This is the seam between the Workspace shell
    (sessions, drift, recording) and the command executor: a caller
    hands in a parsed tree plus its dependencies and gets back the
    resolved result. Byte recording is the caller's responsibility, so
    the active recorder spans the stream consumption that happens
    inside the barrier here.

    Args:
        dispatch (DispatchFn): VFS op dispatcher (op, path, **kw).
        registry (MountRegistry): mount registry for path resolution.
        namespace (Namespace): addressing authority for symlink ops.
        job_table (JobTable): background job management.
        execute_fn (Callable): recursive execute (for source/eval).
        agent_id (str): current agent ID for jobs.
        ast (Any): parsed tree-sitter root node.
        context (EvaluationContext): the evaluation's session and frame.
        stdin (Any): input stream.
        cancel (asyncio.Event | None): event used to abort mid-flight.
        routing_decision (RouteDecision | None): the typed line's routing
            decision, threaded to every command dispatch; None runs on
            the static bindings.
        handed (HandOff | None): the line's hand-off, threaded to every
            command's gate.
        command_substitution (bool): capture a lone input redirect's data
            using the same expansion, dispatcher and output gates.
        call_stack (CallStack | None): the frames of the caller the tree
            runs in place of (``eval``), None for a line of its own.

    Returns:
        tuple[IOResult, ExecutionNode]: the finalized result (with
        ``io.stdout`` set to the barrier-resolved value) and the
        execution node.
    """
    session = context.session
    run = partial(
        execute_node,
        dispatch,
        registry,
        namespace,
        job_table,
        execute_fn,
        agent_id,
        cancel=cancel,
        routing_decision=routing_decision,
        handed=handed,
        sink=sink,
        execution_scope=execution_scope or ExecutionScope(),
    )
    redirect = (
        input_substitution_redirect(ast) if command_substitution else None
    )
    if redirect is None:
        stdout, io, exec_node = await run(ast, context, stdin, call_stack)
    else:
        redirects, _ = await expand_redirects(
            [redirect],
            context,
            execute_fn,
            registry,
            view=session_view(
                session,
                registry.policies,
                diagnostics=context.frame.diagnostics,
            ),
        )
        # Bash's implicit file read has cat's policy identity, without
        # invoking a function/alias or expanding the filename a second time.
        target = redirects[0].target
        paths = (
            [target]
            if isinstance(target, PathSpec)
            else [_to_scope(target)]
            if isinstance(target, str)
            else []
        )
        verdict = await admit(
            "cat",
            [],
            [],
            session,
            registry,
            namespace,
            agent_id,
            redirects=paths,
            cancel=cancel,
            claimant=claimant_for(ast, handed),
            intrinsic=True,
        )
        if isinstance(verdict, Refused):
            stdout = None
            io = IOResult(
                exit_code=verdict.exit_code,
                stderr=verdict.stderr,
                refusal=verdict.refusal,
            )
            exec_node = ExecutionNode(
                command="cat",
                exit_code=verdict.exit_code,
                stderr=verdict.stderr,
                refused=True,
            )
        else:
            context = replace(context, admission=verdict)
            stdout, io, exec_node = await handle_redirect(
                run,
                bind_dispatch(
                    dispatch,
                    io_context(
                        session,
                        verdict,
                        registry.policies,
                        context.frame.recorder,
                    ),
                ),
                None,
                redirects,
                context,
                stdin,
                capture_input=True,
            )
    stdout = await apply_barrier(stdout, io, BarrierPolicy.VALUE)
    # A line written to a terminal (a typed line's, a substitution's)
    # is bounded as what reached it, its jobs' output included, and
    # what the bound leaves goes back ahead of anything later.
    screen = (
        sink if isinstance(sink, Terminal) and sink.reader is None else None
    )
    if screen is not None:
        out, err = screen.drain()
        stdout = out + (await materialize(stdout) or b"")
        io.stderr = err + (await materialize(io.stderr) or b"") or None
    # The boundary consultation: the envelope's producer facts become
    # the post_execute context; the built-in cap and any user policies
    # answer with Limits (tightest merged), enforced by guard_output.
    ctx = ExecuteResultContext(
        producer=io.producer or Producer(command=""), exit_code=io.exit_code
    )
    deny, bound = await post_execute_gate(registry.policies, ctx)
    if deny is not None:
        existing = await materialize(io.stderr) if io.stderr else b""
        err, code = render_deny(ctx.producer.command or "line", deny)
        io.stderr = existing + err
        io.exit_code = code
        io.stdout = None
        io.refusal = refusal_of(deny)
        if screen is not None:
            screen.put_back(b"", io.stderr)
            io.stderr = None
        return io, exec_node
    stdout, io.stderr, io.exit_code = await guard_output(
        stdout, io.stderr, io.exit_code, bound
    )
    if screen is not None:
        screen.put_back(
            await materialize(stdout) or b"",
            await materialize(io.stderr) or b"",
        )
        stdout = io.stderr = None
    io.stdout = stdout
    return io, exec_node

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
import time
from collections.abc import Awaitable, Callable
from contextlib import nullcontext
from dataclasses import replace
from functools import partial
from typing import Any

from mirage.cache.index.scope import command_scope
from mirage.context import (
    program_invocation,
    redirect_paths_for,
    reset_current_session,
    reset_program_invocation,
    reset_redirect_paths,
    set_current_evaluation,
    set_program_invocation,
    set_redirect_paths,
)
from mirage.context.session_context import redirect_syntax_for
from mirage.io import IOResult
from mirage.io.async_line_iterator import share
from mirage.io.types import ByteSource, materialize
from mirage.policy import HandOff, PolicyDenied
from mirage.process.supervisor import ProcessSupervisor
from mirage.runtime.base import Runtime
from mirage.runtime.routing import RouteDecision
from mirage.runtime.types import DispatchFn
from mirage.shell.barrier import BarrierPolicy, apply_barrier
from mirage.shell.bytes import decode_text, encode_text
from mirage.shell.call_stack import CallStack
from mirage.shell.console import JobConsole
from mirage.shell.constants import (
    FORK_FAILED,
    FORK_FAILED_STATUS,
)
from mirage.shell.errors import ArithError, ExitSignal, ReadonlyError
from mirage.shell.helpers import (
    get_case_items,
    get_case_word,
    get_cfor_parts,
    get_for_parts,
    get_function_name,
    get_function_source,
    get_if_branches,
    get_list_parts,
    get_negated_command,
    get_parts,
    get_pipeline_stages,
    get_process_sub_body,
    get_process_sub_direction,
    get_redirects,
    get_text,
    get_unset_args,
    get_while_parts,
    read_row,
    take_continuation,
)
from mirage.shell.job_table import JobTable
from mirage.shell.node_kind import NodeKind, node_kind, pipeline_transparent
from mirage.shell.parse.names import literal_text
from mirage.shell.types import NodeType as NT
from mirage.shell.types import (
    PipelineStages,
    ProcessSubDirection,
    Redirect,
    RedirectKind,
    TSNodeLike,
)
from mirage.types import PathSpec
from mirage.vfs.dev.dev import DevVFS
from mirage.view.types import SessionView
from mirage.workspace.evaluation import EvaluationContext, child_context
from mirage.workspace.execution import ExecutionScope
from mirage.workspace.executor.builtins import handle_test, handle_unset
from mirage.workspace.executor.builtins.alias import alias_mark, alias_view
from mirage.workspace.executor.builtins.exec import install_exec_redirects
from mirage.workspace.executor.builtins.shared import (
    fail,
    is_valid_name,
    result,
)
from mirage.workspace.executor.control import (
    execute_body,
    handle_case,
    handle_cfor,
    handle_for,
    handle_if,
    handle_select,
    handle_while,
)
from mirage.workspace.executor.jobs import drained
from mirage.workspace.executor.pipes import (
    handle_connection,
    handle_pipe,
    handle_subshell,
)
from mirage.workspace.executor.redirect import handle_redirect
from mirage.workspace.executor.statement import (
    assignment_status,
    ignoring_errexit,
    record_status,
)
from mirage.workspace.executor.traps import end_shell
from mirage.workspace.expand import (
    expand_and_classify,
    expand_node,
    expand_redirect,
)
from mirage.workspace.expand.globs import glob_options, resolve_globs
from mirage.workspace.expand.node import expand_arith
from mirage.workspace.expand.pattern import expand_pattern
from mirage.workspace.lookup.constants import BASH_BUILTINS
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.node.assignment import execute_assignment
from mirage.workspace.node.command_dispatch import execute_command
from mirage.workspace.node.declaration import execute_declaration
from mirage.workspace.node.occurrence import defined_at
from mirage.workspace.node.program import execute_program
from mirage.workspace.node.test_expr import (
    expand_double_bracket,
    expand_test_expr,
)
from mirage.workspace.node.timing import timing_report
from mirage.workspace.session.elements import landed_arith
from mirage.workspace.session.functions import FunctionSite
from mirage.workspace.session.state import session_view
from mirage.workspace.types import ExecutionNode


async def _eval_cfor_expr(
    exprs: list[Any],
    default: int,
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None,
    view: SessionView | None = None,
) -> int:
    """Evaluate one C-style for expression slot.

    Args:
        exprs (list[Any]): the slot's tree-sitter expression nodes, one
            per comma-separated expression; empty for an empty slot.
        default (int): value an empty slot yields (1 for the condition
            so `for ((;;))` loops, 0 for init/update).
        context (EvaluationContext): the evaluation; arithmetic assignments
            land in its session's env.
        execute_fn (Callable): recursive execute for substitutions.
        call_stack (CallStack | None): function-call scope, if any.
        view (SessionView | None): the gated session view the
            assignments land through; None outside a workspace.

    Raises:
        ArithError: the slot did not evaluate; the loop prints it as
            bash's ``((: expr: reason`` diagnostic.
        ReadonlyError: the expression assigns to a readonly variable,
            which aborts the loop the same way an invalid expression
            does; the writes before it have landed.
        ExitSignal: that assignment was inside a subscript.
        PolicyDenied: a pre_session rule refused one of the writes.
    """
    if not exprs:
        return default
    text = await _slot_text(exprs, context, execute_fn, call_stack, view)
    try:
        return await landed_arith(context.session, view, text)
    except ReadonlyError as exc:
        if exc.in_subscript:
            raise exc.signal() from exc
        raise


async def _slot_text(
    exprs: list[Any],
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None,
    view: SessionView | None,
) -> str:
    """A C-style for slot's text as bash evaluates it: its source up to
    the ``;`` or ``))`` that ends it, each node's expansions substituted.

    Args:
        exprs (list[Any]): the slot's nodes and tokens, in order.
        context (EvaluationContext): the evaluation.
        execute_fn (Callable): recursive execute for substitutions.
        call_stack (CallStack | None): function-call scope, if any.
        view (SessionView | None): the gated session view.
    """
    first, last = exprs[0], exprs[-1]
    parent = first.parent
    closer = last.next_sibling
    if parent is None or closer is None:
        raw, base, end = b"", first.start_byte, last.end_byte
    else:
        raw, base, end = (
            parent.text or b"",
            parent.start_byte,
            closer.start_byte,
        )
    parts: list[str] = []
    at = first.start_byte
    for expr in exprs:
        parts.append(decode_text(raw[at - base : expr.start_byte - base]))
        parts.append(
            await expand_arith(
                expr, context, execute_fn, call_stack, view=view
            )
            if expr.is_named
            else get_text(expr)
        )
        at = expr.end_byte
    parts.append(decode_text(raw[at - base : end - base]))
    return "".join(parts)


STREAMING_KINDS = frozenset(
    {
        NodeKind.PROGRAM,
        NodeKind.COMPOUND,
        NodeKind.LIST,
        NodeKind.SUBSHELL,
        NodeKind.IF,
        NodeKind.FOR,
        NodeKind.CFOR,
        NodeKind.SELECT,
        NodeKind.WHILE,
        NodeKind.UNTIL,
        NodeKind.CASE,
        NodeKind.NEGATED,
    }
)


async def _recurse_reassociated(
    recurse: Callable[..., Any],
    dispatch: DispatchFn,
    execute_fn: Callable[..., Any],
    registry: MountRegistry,
    namespace: Namespace,
    redirects: list[Any],
    processes: ProcessSupervisor | None,
    right: Any,
    node: Any,
    context: EvaluationContext,
    stdin: Any = None,
    call_stack: CallStack | None = None,
    sink: JobConsole | None = None,
) -> tuple[Any, IOResult, ExecutionNode]:
    """Recurse wrapper for a re-associated trailing redirect.

    Runs the list's right operand under the hoisted redirects, bound by
    the same rule in turn (``_run_redirected``), so a pipeline there
    hands them to its last command and a nested list to its own right
    operand; targets expand only at that point (after the left side
    ran, so cwd changes apply). Every other node recurses normally.

    Args:
        recurse (Callable): the plain execute_node recursion.
        dispatch (DispatchFn): VFS op dispatcher.
        execute_fn (Callable): recursive execute (for expansions).
        registry (MountRegistry): mount registry.
        namespace (Namespace): namespace links for redirect pathname expansion.
        redirects (list): parsed redirects hoisted off the list.
        processes (ProcessSupervisor | None): where the stages run as
            managed processes.
        right (Any): the list's right operand.
        node (Any): node being executed by handle_connection.
        context (EvaluationContext): the evaluation's session and frame.
        stdin (Any): input stream.
        call_stack (CallStack | None): shell call stack.
    """
    session = context.session
    if node.id != right.id:
        return await recurse(node, context, stdin, call_stack, sink=sink)
    view = session_view(
        session, registry.policies, diagnostics=context.frame.diagnostics
    )
    return await _run_redirected(
        recurse,
        dispatch,
        execute_fn,
        registry,
        namespace,
        view,
        right,
        redirects,
        processes,
        context,
        stdin,
        call_stack,
        sink=sink,
    )


async def _recurse_lifted(
    recurse: Callable[..., Any],
    dispatch: DispatchFn,
    execute_fn: Callable[..., Any],
    registry: MountRegistry,
    namespace: Namespace,
    stages: PipelineStages,
    processes: ProcessSupervisor | None,
    right: Any,
    node: Any,
    context: EvaluationContext,
    stdin: Any = None,
    call_stack: CallStack | None = None,
    sink: JobConsole | None = None,
) -> tuple[Any, IOResult, ExecutionNode]:
    """Recurse wrapper for a list the parse pulled into a pipeline's first
    stage: the list's right operand, where the pipeline starts, runs the
    pipeline; every other node recurses normally.

    Args:
        recurse (Callable): the plain execute_node recursion.
        dispatch (DispatchFn): VFS op dispatcher.
        execute_fn (Callable): recursive execute (for expansions).
        registry (MountRegistry): mount registry.
        namespace (Namespace): namespace links for redirect pathname expansion.
        stages (PipelineStages): the pipeline, its lead already taken.
        processes (ProcessSupervisor | None): where the stages run as
            managed processes.
        right (Any): the list's right operand.
        node (Any): node being executed by handle_connection.
        context (EvaluationContext): the evaluation's session and frame.
        stdin (Any): input stream.
        call_stack (CallStack | None): shell call stack.
    """
    if node is not right:
        return await recurse(node, context, stdin, call_stack, sink=sink)
    return await _run_pipeline(
        recurse,
        dispatch,
        execute_fn,
        registry,
        namespace,
        stages,
        context,
        stdin,
        call_stack,
        processes,
        sink,
    )


async def _recurse_stage(
    recurse: Callable[..., Any],
    dispatch: DispatchFn,
    execute_fn: Callable[..., Any],
    registry: MountRegistry,
    namespace: Namespace,
    stages: PipelineStages,
    targets: list[Any],
    processes: ProcessSupervisor | None,
    node: Any,
    context: EvaluationContext,
    stdin: Any = None,
    call_stack: CallStack | None = None,
    *,
    sink: JobConsole | None = None,
) -> tuple[Any, IOResult, ExecutionNode]:
    """Recurse wrapper for one pipeline stage.

    A stage the parse hoisted redirects off runs under them, with the
    ``2>&1`` of a ``|&`` after it applied last, as bash applies it after
    the command's own redirections; a stage holding its own redirects
    gets that ``2>&1`` from ``_recurse_pipe_stderr``.

    Args:
        recurse (Callable): the plain execute_node recursion.
        dispatch (DispatchFn): VFS op dispatcher.
        execute_fn (Callable): recursive execute (for expansions).
        registry (MountRegistry): mount registry.
        namespace (Namespace): namespace links for redirect pathname expansion.
        stages (PipelineStages): the pipeline being run.
        targets (list[Any]): the stages a ``|&`` follows.
        processes (ProcessSupervisor | None): where the stages run as
            managed processes.
        node (Any): the stage handle_pipe asks for.
        context (EvaluationContext): the stage's session.
        stdin (Any): input stream.
        call_stack (CallStack | None): shell call stack.
        sink (JobConsole | None): the stage's pipe console.
    """
    session = context.session
    for command, hoisted in zip(stages.commands, stages.redirects):
        if command is not node or not hoisted:
            continue
        bound = list(hoisted)
        if any(target is node for target in targets):
            bound.append(
                Redirect(fd=2, target=1, kind=RedirectKind.STDERR_TO_STDOUT)
            )
        view = session_view(
            session, registry.policies, diagnostics=context.frame.diagnostics
        )
        return await _run_redirected(
            recurse,
            dispatch,
            execute_fn,
            registry,
            namespace,
            view,
            node,
            bound,
            processes,
            context,
            stdin,
            call_stack,
        )
    return await _recurse_pipe_stderr(
        recurse,
        dispatch,
        execute_fn,
        registry,
        namespace,
        targets,
        node,
        context,
        stdin,
        call_stack,
        sink=sink,
    )


async def _run_pipeline(
    recurse: Callable[..., Any],
    dispatch: DispatchFn,
    execute_fn: Callable[..., Any],
    registry: MountRegistry,
    namespace: Namespace,
    stages: PipelineStages,
    context: EvaluationContext,
    stdin: Any,
    call_stack: CallStack | None,
    processes: ProcessSupervisor | None = None,
    sink: JobConsole | None = None,
) -> tuple[Any, IOResult, ExecutionNode]:
    """Run a pipeline as bash reads it (``get_pipeline_stages``).

    A list the parse pulled into the first stage runs as the list it
    is, its right operand standing for the pipeline, so the pipeline
    runs only when the list's operator says it does and its status is
    the list's. A leading ``!`` negates the whole pipeline's status.

    Args:
        recurse (Callable): the plain execute_node recursion.
        dispatch (DispatchFn): VFS op dispatcher.
        execute_fn (Callable): recursive execute (for expansions).
        registry (MountRegistry): mount registry.
        namespace (Namespace): namespace links for redirect pathname expansion.
        stages (PipelineStages): the pipeline's stages.
        context (EvaluationContext): the evaluation's session and frame.
        stdin (Any): input stream.
        call_stack (CallStack | None): shell call stack.
        processes (ProcessSupervisor | None): where the stages run as
            managed processes.
        sink (JobConsole | None): where the output goes as it arrives.
    """
    session = context.session
    if stages.lead is not None:
        left, op, right = stages.lead
        wrapped = partial(
            _recurse_lifted,
            recurse,
            dispatch,
            execute_fn,
            registry,
            namespace,
            replace(stages, lead=None),
            processes,
            right,
        )
        return await handle_connection(
            wrapped,
            left,
            op,
            right,
            context,
            stdin,
            call_stack,
            execute_fn,
        )
    commands = list(stages.commands)
    stderr_flags = list(stages.stderr_flags)
    targets = [
        command
        for i, command in enumerate(commands)
        if i < len(stderr_flags) and stderr_flags[i]
    ]
    pipe_recurse = partial(
        _recurse_stage,
        recurse,
        dispatch,
        execute_fn,
        registry,
        namespace,
        stages,
        targets,
        processes,
    )
    with ignoring_errexit(session) if stages.negated else nullcontext():
        stdout, io, exec_node = await handle_pipe(
            pipe_recurse,
            commands,
            stderr_flags,
            context,
            stdin,
            call_stack,
            processes,
            execute_fn,
            registry.io.buffer_bytes,
            sink,
        )
    if stages.negated:
        io = IOResult(
            exit_code=0 if io.exit_code != 0 else 1,
            stderr=io.stderr,
            reads=io.reads,
            writes=io.writes,
            cache=io.cache,
            refusal=io.refusal,
        )
        exec_node.exit_code = io.exit_code
        session.errexit_immune = True
    return stdout, io, exec_node


async def _recurse_pipe_stderr(
    recurse: Callable[..., Any],
    dispatch: DispatchFn,
    execute_fn: Callable[..., Any],
    registry: MountRegistry,
    namespace: Namespace,
    targets: list[Any],
    node: Any,
    context: EvaluationContext,
    stdin: Any = None,
    call_stack: CallStack | None = None,
    *,
    sink: JobConsole | None = None,
) -> tuple[Any, IOResult, ExecutionNode]:
    session = context.session
    view = session_view(
        session, registry.policies, diagnostics=context.frame.diagnostics
    )
    if node not in targets or node_kind(node) != NodeKind.REDIRECT:
        return await recurse(node, context, stdin, call_stack, sink=sink)
    command, redirects = get_redirects(node)
    redirects.append(
        Redirect(fd=2, target=1, kind=RedirectKind.STDERR_TO_STDOUT)
    )
    return await _run_redirected(
        recurse,
        dispatch,
        execute_fn,
        registry,
        namespace,
        view,
        command,
        redirects,
        None,
        context,
        stdin,
        call_stack,
        sink=sink,
    )


async def _negated(
    stdout: Any,
    io: IOResult,
    exec_node: ExecutionNode,
    context: EvaluationContext,
    inner: Any,
) -> tuple[Any, IOResult, ExecutionNode]:
    """What ``!`` makes of the statement it wraps once that has run.

    Args:
        stdout (Any): the wrapped statement's stdout.
        io (IOResult): its result, the status still its own.
        exec_node (ExecutionNode): its record.
        context (EvaluationContext): the evaluation's session and frame.
        inner (Any): the wrapped statement's node.
    """
    session = context.session
    # Lazy exit codes (grep's) must be final before
    # inverting, or `! grep miss f` negates the provisional 0.
    stdout = await apply_barrier(stdout, io, BarrierPolicy.VALUE)
    # bash reports the negated pipeline's own statuses in PIPESTATUS
    # (`! false` leaves `1`), so what `!` wraps is closed as a statement
    # of its own before `$?` inverts.
    record_status(
        session, io.exit_code, transparent=pipeline_transparent(inner)
    )
    io = IOResult(
        exit_code=0 if io.exit_code != 0 else 1,
        stderr=io.stderr,
        reads=io.reads,
        writes=io.writes,
        cache=io.cache,
        refusal=io.refusal,
    )
    exec_node.exit_code = io.exit_code
    session.errexit_immune = True
    return stdout, io, exec_node


async def _run_redirected(
    recurse: Callable[..., Any],
    dispatch: DispatchFn,
    execute_fn: Callable[..., Any],
    registry: MountRegistry,
    namespace: Namespace,
    view: SessionView | None,
    command: Any,
    redirects: list[Redirect],
    processes: ProcessSupervisor | None,
    context: EvaluationContext,
    stdin: Any,
    call_stack: CallStack | None,
    *,
    sink: JobConsole | None = None,
) -> tuple[Any, IOResult, ExecutionNode]:
    """Run a redirected statement: the command under its redirects, then
    the pipeline a heredoc's operator line fed it into.

    The parse hoists a trailing redirect over whatever precedes it, so
    the redirects are bound where bash binds them first: past a list to
    its right operand, past a pipeline to its last stage, and inside a
    ``!`` to the command it negates, recursively, until they reach the
    command they follow.

    Args:
        recurse (Callable): the plain execute_node recursion.
        dispatch (DispatchFn): VFS op dispatcher.
        execute_fn (Callable): recursive execute (for expansions).
        registry (MountRegistry): mount registry.
        namespace (Namespace): namespace links for redirect pathname expansion.
        view (SessionView | None): the gated session view.
        command (Any): the redirected command node, None for a bare
            redirect.
        redirects (list[Redirect]): the statement's parsed redirects.
        processes (ProcessSupervisor | None): where the stages run as
            managed processes.
        context (EvaluationContext): the evaluation's session and frame.
        stdin (Any): input stream.
        call_stack (CallStack | None): shell call stack.
        sink (JobConsole | None): where the redirect writes what it
            routes as it goes, None to return it.
    """
    session = context.session
    if command is not None and command.type == NT.REDIRECTED_STATEMENT:
        inner, own = get_redirects(command)
        return await _run_redirected(
            recurse,
            dispatch,
            execute_fn,
            registry,
            namespace,
            view,
            inner,
            [*own, *redirects],
            processes,
            context,
            stdin,
            call_stack,
            sink=sink,
        )
    if command is not None and command.type == NT.FUNCTION_DEFINITION:
        # The redirects belong to the function, applied at each call
        # (get_function_body), not to the definition.
        return await recurse(command, context, stdin, call_stack)
    if command is not None and command.type == NT.LIST:
        # tree-sitter hoists a trailing redirect over the whole
        # &&/|| list; bash binds it to the last command:
        #   redirected(list(L, op, R), r) == list(L, op, redirected(R, r))
        # Re-associate and defer target expansion until R runs, so
        # `cd /x && echo hi > f` writes under /x. R is bound by this
        # same rule, so `a && b | c < f` reaches `c`, not the pipeline.
        # Compound and subshell bodies keep the whole-body redirect
        # (bash group semantics).
        left, op, right = get_list_parts(command)
        wrapped = partial(
            _recurse_reassociated,
            recurse,
            dispatch,
            execute_fn,
            registry,
            namespace,
            redirects,
            processes,
            right,
        )
        return await handle_connection(
            wrapped,
            left,
            op,
            right,
            context,
            stdin,
            call_stack,
            execute_fn,
        )
    if command is not None and command.type == NT.PIPELINE:
        return await _run_pipeline(
            recurse,
            dispatch,
            execute_fn,
            registry,
            namespace,
            get_pipeline_stages(command, redirects),
            context,
            stdin,
            call_stack,
            processes,
        )
    if command is not None and command.type == NT.NEGATED_COMMAND:
        # `! cmd < f` parses as redirected(negated(cmd), < f), but the
        # redirect is the command's: bash negates what `cmd < f` returns,
        # a redirect that failed to open included.
        inner = get_negated_command(command)
        with ignoring_errexit(session):
            stdout, io, exec_node = await _run_redirected(
                recurse,
                dispatch,
                execute_fn,
                registry,
                namespace,
                view,
                inner,
                redirects,
                processes,
                context,
                stdin,
                call_stack,
                sink=sink,
            )
        return await _negated(stdout, io, exec_node, context, inner)
    pipe_node = next(
        (r.pipeline for r in redirects if r.pipeline is not None), None
    )
    expand = partial(
        expand_redirect,
        context=context,
        execute_fn=execute_fn,
        registry=registry,
        call_stack=call_stack,
        view=view,
        forked=_forks(command, context),
        links=namespace,
    )
    if _is_bare_exec(command):
        return await install_exec_redirects(
            dispatch, session, redirects, stdin, expand=expand
        )
    # A heredoc's operator line reads the routed stdout, so then it is
    # returned rather than written. A simple command expands its words
    # before its redirects apply, so what that printed (a substitution's
    # stderr) goes around them; a compound body expands inside them.
    simple = command is not None and command.type in (
        NT.COMMAND,
        NT.DECLARATION_COMMAND,
        NT.VARIABLE_ASSIGNMENT,
        NT.VARIABLE_ASSIGNMENTS,
    )
    outer = context.frame.diagnostics
    if simple:
        context.frame.diagnostics = []
    try:
        if command is not None and command.type == NT.COMMAND:

            async def under_redirects(run, guard, name, args):
                async def prepared(node, current, given, stack, *, sink=None):
                    return await run(
                        given, sink, redirect_paths_for(command.id)
                    )

                return await handle_redirect(
                    prepared,
                    dispatch,
                    command,
                    redirects,
                    context,
                    stdin,
                    call_stack,
                    sink=sink if pipe_node is None else None,
                    expand=expand,
                    guard=guard,
                    name=name,
                    args=args,
                )

            token = set_redirect_paths(
                command.id, (), under_redirects, tuple(redirects)
            )
            try:
                stdout, io, exec_node = await recurse(
                    command,
                    context,
                    stdin,
                    call_stack,
                    sink=sink if pipe_node is None else None,
                    own_diagnostics=False,
                )
            finally:
                reset_redirect_paths(token)
        else:
            stdout, io, exec_node = await handle_redirect(
                partial(recurse, own_diagnostics=False) if simple else recurse,
                dispatch,
                command,
                redirects,
                context,
                stdin,
                call_stack,
                sink=sink if pipe_node is None else None,
                expand=expand,
            )
        if simple and context.frame.diagnostics:
            err = _diagnostic_stderr(command, context)
            io.stderr = err + await io.materialize_stderr()
            exec_node.stderr = err + (exec_node.stderr or b"")
    except ExitSignal as exc:
        if simple:
            exc.stderr = _diagnostic_stderr(command, context) + exc.stderr
        raise
    finally:
        context.frame.diagnostics = outer
    if pipe_node is not None and stdout is not None:
        stdout, io2, exec_node2 = await recurse(
            pipe_node, context, stdout, call_stack
        )
        io = await io.merge(io2)
        exec_node = exec_node2
    return stdout, io, exec_node


async def _run_continuation(
    recurse: Callable[..., Any],
    run_left: Callable[..., Any],
    left: Any,
    steps: tuple[tuple[str, Any], ...],
    context: EvaluationContext,
    stdin: Any,
    call_stack: CallStack | None,
    execute_fn: Callable[..., Any] | None = None,
) -> tuple[Any, IOResult, ExecutionNode]:
    """Fold the ``&&``/``||`` steps a heredoc's operator line carried
    around the statement, left to right.

    The last step's operator joins everything before it to its right
    operand, so the fold is ``handle_connection`` with the statement's
    node standing for that left side; the wrapper below runs the
    remaining steps when asked for it and recurses normally for the
    right operand. The list semantics (short-circuit, ``$?``,
    ``PIPESTATUS``, ``set -e`` immunity) are therefore the ``list``
    node's own, not a second copy.

    Args:
        recurse (Callable): the plain execute_node recursion.
        run_left (Callable): runs the redirected statement itself, given
            ``(session, stdin, call_stack)``.
        left (Any): the redirected_statement node, standing for the
            left side in ``handle_connection``.
        steps (tuple[tuple[str, Any], ...]): the ``(operator, right)``
            steps, in order.
        context (EvaluationContext): the evaluation's session and frame.
        stdin (Any): input stream.
        call_stack (CallStack | None): shell call stack.
        execute_fn (Callable[..., Any] | None): runs the ERR action.
    """
    if not steps:
        return await run_left(context, stdin, call_stack)
    op, right = steps[-1]
    wrapped = partial(
        _recurse_continuation,
        recurse,
        run_left,
        left,
        steps[:-1],
        execute_fn,
    )
    return await handle_connection(
        wrapped,
        left,
        op,
        right,
        context,
        stdin,
        call_stack,
        execute_fn,
    )


async def _recurse_continuation(
    recurse: Callable[..., Any],
    run_left: Callable[..., Any],
    left: Any,
    steps: tuple[tuple[str, Any], ...],
    execute_fn: Callable[..., Any] | None,
    node: Any,
    context: EvaluationContext,
    stdin: Any = None,
    call_stack: CallStack | None = None,
) -> tuple[Any, IOResult, ExecutionNode]:
    """Recurse wrapper for a heredoc continuation: the statement's own
    node runs the steps before the current one, anything else recurses.

    Args:
        recurse (Callable): the plain execute_node recursion.
        run_left (Callable): runs the redirected statement itself.
        left (Any): the redirected_statement node.
        steps (tuple[tuple[str, Any], ...]): the steps before the
            current one.
        execute_fn (Callable[..., Any] | None): runs the ERR action.
        node (Any): the node ``handle_connection`` asks for.
        context (EvaluationContext): the evaluation's session and frame.
        stdin (Any): input stream.
        call_stack (CallStack | None): shell call stack.
    """
    if node is left:
        return await _run_continuation(
            recurse,
            run_left,
            left,
            steps,
            context,
            stdin,
            call_stack,
            execute_fn,
        )
    return await recurse(node, context, stdin, call_stack)


def _is_bare_exec(command: Any) -> bool:
    """Whether a redirected statement's command is a bare `exec`, which
    installs its redirects on the shell for every later statement;
    `exec cmd` is a command.

    Args:
        command (Any): the tree-sitter command node under the redirect,
            or None for a command-less redirect (`> file`).
    """
    if command is None or command.type != NT.COMMAND:
        return False
    named = get_parts(command)
    return (
        len(named) == 1
        and named[0].type == NT.COMMAND_NAME
        and get_text(named[0]) == "exec"
    )


def _forks(command: Any, context: EvaluationContext) -> bool:
    """Whether bash forks to run a redirected command, so its redirects
    expand in the child and an error there fails that command alone: a
    subshell or a program. A builtin, a function or another compound
    command is the shell's own, which expands its redirects itself and
    discards the line on an error. ``command -v`` is the builtin itself;
    ``command X`` is X with functions masked; a name only an expansion
    spells is taken for a program.

    Args:
        command (Any): the command under the redirect, None for none.
        context (EvaluationContext): whose functions a name may call.
    """
    session = context.session
    if command is None or command.type != NT.COMMAND:
        return command is not None and command.type == NT.SUBSHELL
    words = [
        part
        for part in get_parts(command)
        if part.type != NT.VARIABLE_ASSIGNMENT
    ]
    functions = True
    while words and get_text(words[0]) == "command":
        words, functions = words[1:], False
        while words and get_text(words[0]).startswith("-"):
            option = get_text(words.pop(0))
            if option == "--":
                break
            if "v" in option or "V" in option:
                return False
    if not words:
        return False
    head = words[0]
    if head.type == NT.COMMAND_NAME and head.named_children:
        head = head.named_children[0]
    name = literal_text(head)
    return name is None or (
        name not in BASH_BUILTINS
        and not (functions and name in session.functions)
    )


async def execute_node(
    dispatch: DispatchFn,
    registry: MountRegistry,
    namespace: Namespace,
    job_table: JobTable,
    execute_fn: Callable[..., Any],
    agent_id: str,
    node: Any,
    context: EvaluationContext,
    stdin: Any = None,
    call_stack: CallStack | None = None,
    cancel: asyncio.Event | None = None,
    routing_decision: RouteDecision[Runtime] | None = None,
    sink: JobConsole | None = None,
    handed: HandOff | None = None,
    execution_scope: ExecutionScope | None = None,
    ends_shell: bool = False,
    own_diagnostics: bool = True,
) -> tuple[Any, IOResult, ExecutionNode]:
    session = context.session
    execution_scope = execution_scope or ExecutionScope()
    # The node is the whole of a child shell (a background job), which
    # runs its EXIT action when the node ends, its evaluator bound the
    # way `_execute_node` binds it for the node's own lines.
    if ends_shell:
        return await end_shell(
            partial(
                execute_fn,
                handed=handed,
                cancel=cancel,
                execution_scope=execution_scope,
            ),
            session,
            stdin,
            call_stack,
            execute_node(
                dispatch,
                registry,
                namespace,
                job_table,
                execute_fn,
                agent_id,
                node,
                context,
                stdin,
                call_stack,
                cancel,
                routing_decision,
                sink,
                handed,
                execution_scope,
            ),
        )
    await execution_scope.checkpoint(cancel)
    run = partial(
        _execute_node,
        dispatch,
        registry,
        namespace,
        job_table,
        execute_fn,
        agent_id,
        node,
        context,
        stdin,
        call_stack,
        cancel,
        routing_decision,
        sink,
        handed,
        execution_scope,
    )
    # The node's own `<(...)` files go when it ends, so a command still
    # reading one is read out first.
    held: list[tuple[DevVFS, str, int]] = []
    previous = context.frame.process_sub
    context.frame.process_sub = _process_input(context, registry, held)
    try:
        # What expanding the node printed (a substitution's stderr) goes
        # out with the node's own stderr, unless its caller collects it: a
        # simple command's words expand before its redirects apply.
        if not own_diagnostics:
            stdout, io, exec_node = await run(own_diagnostics=False)
        else:
            outer = context.frame.diagnostics
            context.frame.diagnostics = []
            try:
                stdout, io, exec_node = await run()
                if context.frame.diagnostics:
                    err = _diagnostic_stderr(node, context)
                    io.stderr = err + await io.materialize_stderr()
                    exec_node.stderr = err + (exec_node.stderr or b"")
            except (ExitSignal, _ProcessSubError) as exc:
                exc.stderr = _diagnostic_stderr(node, context) + exc.stderr
                raise
            finally:
                context.frame.diagnostics = outer
        if held and stdout is not None:
            stdout = await materialize(stdout)
        return stdout, io, exec_node
    except _ProcessSubError as exc:
        # The node fails, as an unsupported command does; the line goes on.
        err = exc.stderr
        return (
            None,
            IOResult(exit_code=2, stderr=err),
            ExecutionNode(command="process_sub", exit_code=2, stderr=err),
        )
    finally:
        context.frame.process_sub = previous
        for dev, path, allocation in held:
            dev.release_input(path, allocation)


class _ProcessSubError(Exception):
    """An output process substitution, which mirage does not run."""

    def __init__(self) -> None:
        super().__init__("unsupported: process substitution >(...)")
        self.stderr = b"mirage: unsupported: process substitution >(...)\n"


def _process_input(
    context: EvaluationContext,
    registry: MountRegistry,
    held: list[tuple[DevVFS, str, int]],
) -> Callable[
    [TSNodeLike, Callable[[str], Awaitable[IOResult]]], Awaitable[str]
]:
    """The hook that opens a node's input process substitutions.

    Each ``<(...)`` runs as its word expands, in order with the word's
    other expansions and through the evaluator a ``$(...)`` there uses,
    and reads back as a buffered device file rather than a host pipe,
    held until the node ends; a nested node opens its own, so each lasts
    as long as the command naming it. An output ``>(...)`` is refused:
    the node naming it fails with status 2.

    Args:
        context (EvaluationContext): the evaluation the node runs in.
        registry (MountRegistry): mount registry holding ``/dev``.
        held (list[tuple[DevVFS, str, int]]): the node's open files.
    """

    async def open_input(
        node: TSNodeLike,
        execute_line: Callable[[str], Awaitable[IOResult]],
    ) -> str:
        if get_process_sub_direction(node) == ProcessSubDirection.OUTPUT:
            raise _ProcessSubError
        dev, _, _ = registry.resolve("/dev/null")
        assert isinstance(dev, DevVFS)
        path, allocation = dev.allocate_input()
        held.append((dev, path, allocation))
        inner = get_process_sub_body(node)
        if inner:
            io = await execute_line(inner)
            dev.set_input(path, allocation, await materialize(io.stdout))
            context.frame.diagnostics.append(await materialize(io.stderr))
        return path

    return open_input


def _diagnostic_stderr(node: Any, context: EvaluationContext) -> bytes:
    if not context.frame.diagnostics:
        return b""
    head = get_text(node).split(None, 1)[0]
    builtin = (
        head
        if head
        in {"export", "declare", "local", "readonly", "read", "printf", "let"}
        else ""
    )
    prefix = f"bash: {builtin}: " if builtin else "bash: "
    return b"".join(
        message
        if isinstance(message, bytes)
        else encode_text(prefix + message + "\n")
        for message in context.frame.diagnostics
    )


async def _execute_node(
    dispatch: DispatchFn,
    registry: MountRegistry,
    namespace: Namespace,
    job_table: JobTable,
    execute_fn: Callable[..., Any],
    agent_id: str,
    node: Any,
    context: EvaluationContext,
    stdin: Any = None,
    call_stack: CallStack | None = None,
    cancel: asyncio.Event | None = None,
    routing_decision: RouteDecision[Runtime] | None = None,
    sink: JobConsole | None = None,
    handed: HandOff | None = None,
    execution_scope: ExecutionScope | None = None,
    own_diagnostics: bool = True,
) -> tuple[Any, IOResult, ExecutionNode]:
    """Walk tree-sitter AST and dispatch each node.

    ``set -n`` stops every node at any depth, as GNU answers ``if true;
    then set -n; echo BAD; fi`` with nothing; the program loop's own stop
    is what silences ``set -v`` for the lines it never reads.

    Args:
        dispatch (DispatchFn): VFS op dispatcher (op, path, **kw).
        registry (MountRegistry): mount registry for path resolution.
        namespace (Namespace): addressing authority for symlink ops.
        job_table (JobTable): background job management.
        execute_fn (Callable): recursive execute (for source/eval).
        agent_id (str): current agent ID for jobs.
        node (Any): tree-sitter node to execute.
        context (EvaluationContext): the evaluation's session and frame.
        stdin (Any): input stream.
        call_stack (CallStack): shell call stack.
        cancel (asyncio.Event | None): event used to abort mid-flight,
            bound into ``execute_fn`` with ``handed``, so a ``$(...)`` in
            a background job never dies of the caller's abort.
        handed (HandOff | None): the hand-off this subtree runs on,
            carried to every command's gate so it runs on the grants
            claimed for this line and never another's, and bound into
            ``execute_fn`` so every line the subtree evaluates stands
            under it too, a line a background job evaluates after the
            typed line ended included.
        sink (JobConsole | None): console to write this node's output to
            as it is produced. When set, the node emits and returns no
            stdout; when None it returns stdout as a value, which is
            what capture sites (command substitution, pipe stages,
            redirects) rely on.
        own_diagnostics (bool): whether a node drained into the sink
            flushes its own diagnostics; a redirect's simple command
            leaves them for the redirect to put outside it.
    """
    session = context.session
    # The session view, bound once for the line: every
    # expansion-time write (`${X:=d}`, `$((X=5))`) lands through it,
    # so a pre_session rule governs those exactly as it governs `X=d`.
    view = session_view(
        session, registry.policies, diagnostics=context.frame.diagnostics
    )
    if session.shell_options.get("noexec"):
        return None, IOResult(), ExecutionNode(command="", exit_code=0)
    cs = call_stack if call_stack is not None else CallStack()
    session.errexit_immune = False
    execute_fn = partial(
        execute_fn,
        handed=handed,
        cancel=cancel,
        execution_scope=execution_scope,
    )

    recurse = partial(
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
        execution_scope=execution_scope,
    )

    kind = node_kind(node)

    # The statements a construct runs all read one descriptor, as bash's
    # do: `read` takes its line and the command after it gets the rest,
    # in a group, a loop, a list, a subshell or a nested shell alike.
    if kind in STREAMING_KINDS:
        stdin = share(stdin)

    # A sink turns this walk from "return your output" into "write your
    # output". Sequencing constructs pass it to their children so each
    # statement lands as it finishes, and so do a command (a function
    # body, a nested shell), a pipeline (its last stage) and a redirect
    # (what it routes), draining whatever they return after; everything
    # else runs unchanged and has its result drained here. Only these
    # kinds inherit a sink, so capture sites keep receiving their output
    # as a value.
    if (
        sink is not None
        and kind not in STREAMING_KINDS
        and kind
        not in (
            NodeKind.COMMAND,
            NodeKind.PIPELINE,
            NodeKind.REDIRECT,
            NodeKind.VAR_ASSIGN,
            NodeKind.VAR_ASSIGNS,
        )
    ):
        return await drained(
            sink,
            *await recurse(
                node, context, stdin, cs, own_diagnostics=own_diagnostics
            ),
        )

    stream = partial(recurse, sink=sink) if sink is not None else recurse

    if kind == NodeKind.TIMED:
        started = time.monotonic()
        inner = node.named_children[0]
        stdout, io, exec_node = await stream(inner, context, stdin, cs)
        stdout = await apply_barrier(stdout, io, BarrierPolicy.VALUE)
        elapsed = time.monotonic() - started
        report = b"".join(
            timing_report(elapsed, portable, session.env.get("TIMEFORMAT"))
            for portable in reversed(node.timing)
        )
        io.stderr = (await io.materialize_stderr()) + report
        return stdout, io, exec_node

    if kind == NodeKind.COMMENT:
        return None, IOResult(), ExecutionNode(command="", exit_code=0)

    if kind == NodeKind.PROGRAM:
        pending = redirect_syntax_for(node.id)
        program_recurse = recurse
        if pending:
            statements = [
                child
                for child in node.named_children
                if child.type != NT.COMMENT
            ]
            if not statements:
                return await _run_redirected(
                    recurse,
                    dispatch,
                    execute_fn,
                    registry,
                    namespace,
                    view,
                    None,
                    list(pending),
                    job_table.processes if job_table is not None else None,
                    context,
                    stdin,
                    cs,
                    sink=sink,
                )
            program_recurse = partial(
                _recurse_reassociated,
                recurse,
                dispatch,
                execute_fn,
                registry,
                namespace,
                list(pending),
                job_table.processes if job_table is not None else None,
                statements[-1],
            )
        # A root run in a caller's frame is the caller's own line (eval,
        # an alias); one given none is a shell of its own.
        return await execute_program(
            program_recurse,
            node,
            context,
            stdin,
            cs,
            job_table,
            agent_id,
            dispatch,
            handed,
            registry.decisions,
            sink=sink,
            inline=call_stack is not None,
            execute_fn=execute_fn,
        )

    if kind == NodeKind.COMMAND:
        async with command_scope():
            ran = await execute_command(
                recurse,
                dispatch,
                registry,
                namespace,
                execute_fn,
                node,
                context,
                stdin,
                cs,
                job_table,
                cancel=cancel,
                routing_decision=routing_decision,
                agent_id=agent_id,
                handed=handed,
                sink=sink,
            )
        return ran if sink is None else await drained(sink, *ran)

    if kind == NodeKind.PIPELINE:
        # `! a | b` parses as pipeline(negated_command(a), b), and a
        # redirect followed by `|` closes over everything to its left, so
        # the stages are read the way bash reads them rather than as the
        # parse nested them (see get_pipeline_stages).
        ran = await _run_pipeline(
            recurse,
            dispatch,
            execute_fn,
            registry,
            namespace,
            get_pipeline_stages(node),
            context,
            stdin,
            cs,
            job_table.processes if job_table is not None else None,
            sink,
        )
        return ran if sink is None else await drained(sink, *ran)

    if kind == NodeKind.LIST:
        left, op, right = get_list_parts(node)
        return await handle_connection(
            stream, left, op, right, context, stdin, cs, execute_fn
        )

    if kind == NodeKind.REDIRECT:
        command, redirects = get_redirects(node)
        # The `&&`/`||` steps a heredoc's operator line carried
        # (`false <<EOF || echo x`) wrap the whole statement, hoisted
        # list and all, exactly as a `list` node would have wrapped it
        # had the parser read the line the way bash does.
        continuation = take_continuation(redirects)
        run_left = partial(
            _run_redirected,
            recurse,
            dispatch,
            execute_fn,
            registry,
            namespace,
            view,
            command,
            redirects,
            job_table.processes if job_table is not None else None,
            sink=sink,
        )
        if not continuation:
            ran = await run_left(context, stdin, cs)
        else:
            ran = await _run_continuation(
                recurse,
                run_left,
                node,
                continuation,
                context,
                stdin,
                cs,
                execute_fn,
            )
        return ran if sink is None else await drained(sink, *ran)

    if kind == NodeKind.SUBSHELL:
        # A subshell is its own shell: background jobs started inside
        # live in a private job table (`$!`/`wait`/`kill` in the body
        # see them; the parent's table never does), mirroring bash's
        # forked process.
        sub_table = job_table.child() if job_table is not None else JobTable()
        sub_recurse = partial(
            execute_node,
            dispatch,
            registry,
            namespace,
            sub_table,
            execute_fn,
            agent_id,
            cancel=cancel,
            routing_decision=routing_decision,
            handed=handed,
        )
        child = child_context(context)
        as_program = program_invocation(session)
        results: list[tuple[ByteSource | None, IOResult, ExecutionNode]] = []

        async def run_subshell() -> int:
            token = set_current_evaluation(child)
            program_token = (
                set_program_invocation(child.session) if as_program else None
            )
            try:
                result = await handle_subshell(
                    sub_recurse,
                    list(node.children),
                    child,
                    stdin,
                    cs,
                    sub_table,
                    agent_id,
                    dispatch,
                    handed,
                    registry.decisions,
                    sink=sink,
                    execute_fn=execute_fn,
                )
                results.append(result)
                return result[1].exit_code
            finally:
                reset_current_session(token)
                if program_token is not None:
                    reset_program_invocation(program_token)

        try:
            process = sub_table.processes.start(
                session_id=session.session_id,
                command=get_text(node),
                cwd=PathSpec.from_str_path(session.cwd),
                parent_pid=session.process_id,
                run=run_subshell,
                limit=session.processes.max,
            )
        except BlockingIOError as exc:
            raise ExitSignal(FORK_FAILED_STATUS, stderr=FORK_FAILED) from exc
        child.session.process_id = process.info.pid
        await process.task
        return results[0]

    if kind == NodeKind.ARITH:
        text = get_text(node)
        expr = await expand_arith(node, context, execute_fn, cs, view=view)
        try:
            value = await landed_arith(session, view, expr)
        except PolicyDenied as exc:
            return fail(text, f"bash: {exc.strerror}\n")
        except (ArithError, ReadonlyError) as exc:
            if exc.in_subscript:
                raise exc.signal() from exc
            voice = "((: " if isinstance(exc, ArithError) else ""
            return fail(text, f"bash: {voice}{exc}\n")
        return result(text, exit_code=0 if value != 0 else 1)

    run_body = partial(
        execute_body,
        stream,
        context=context,
        stdin=stdin,
        call_stack=cs,
        job_table=job_table,
        agent_id=agent_id,
        handed=handed,
        decisions=registry.decisions,
        execute_fn=execute_fn,
        sink=sink,
    )

    if kind == NodeKind.COMPOUND:
        return await run_body(node.named_children)

    if kind == NodeKind.IF:
        branches, else_body = get_if_branches(node)
        return await handle_if(run_body, branches, else_body, session)

    if kind == NodeKind.CFOR:
        exprs, body = get_cfor_parts(node)
        eval_expr = partial(
            _eval_cfor_expr,
            context=context,
            execute_fn=execute_fn,
            call_stack=cs,
            view=view,
        )
        with cs.loop():
            return await handle_cfor(run_body, exprs, body, eval_expr, session)

    if kind in (NodeKind.FOR, NodeKind.SELECT):
        var, values, body = get_for_parts(node)
        if not is_valid_name(var):
            return fail(kind.value, f"bash: `{var}': not a valid identifier\n")
        async with command_scope():
            classified = await expand_and_classify(
                values,
                context,
                execute_fn,
                registry,
                session.cwd,
                cs,
                view=view,
            )
            # The loop word list is consumed by the shell (WordPolicy.SHELL):
            # globs resolve to matches before iteration starts.
            classified = await resolve_globs(
                classified,
                registry,
                noglob=bool(session.shell_options.get("noglob")),
                links=namespace,
                options=glob_options(session),
            )
        policies = namespace.registry.policies
        with cs.loop():
            if kind == NodeKind.SELECT:
                return await handle_select(
                    run_body,
                    var,
                    classified,
                    body,
                    context,
                    stdin,
                    policies=policies,
                    sink=sink,
                )
            return await handle_for(
                run_body, var, classified, body, context, policies=policies
            )

    if kind in (NodeKind.WHILE, NodeKind.UNTIL):
        test, body = get_while_parts(node)
        with cs.loop():
            return await handle_while(
                run_body, test, body, session, until=kind == NodeKind.UNTIL
            )

    if kind == NodeKind.CASE:
        word_node = get_case_word(node)
        word = await expand_node(word_node, context, execute_fn, cs, view=view)
        case_items = []
        for pattern_nodes, body, terminator in get_case_items(node):
            patterns = [
                await expand_pattern(p, context, execute_fn, cs, view=view)
                for p in pattern_nodes
            ]
            case_items.append((patterns, body, terminator))
        return await handle_case(run_body, word, case_items, session)

    if kind == NodeKind.FUNCTION_DEF:
        name = get_function_name(node)
        if name in session.readonly_functions:
            # `readonly -f f` froze the body: either definition syntax
            # refuses with `f: readonly function`, exit 1, and the old
            # body stays, pinned on 5.2.37.
            return fail(
                f"function {name}", f"bash: {name}: readonly function\n"
            )
        source = get_function_source(node)
        session.functions[name] = source
        session._function_sites[name] = FunctionSite(
            source,
            alias_mark(session, node.start_point[0]),
            defined_at(node, handed),
            alias_view(session, node, alias_mark(session, read_row(node))),
        )
        return result(f"function {name}")

    if kind == NodeKind.DECLARATION:
        async with command_scope():
            return await execute_declaration(
                node, context, execute_fn, registry, namespace, cs, view
            )

    if kind == NodeKind.UNSET:
        args = get_unset_args(node)
        return await handle_unset(
            args,
            session,
            session_view(
                session,
                namespace.registry.policies,
                diagnostics=context.frame.diagnostics,
            ),
        )

    if kind == NodeKind.TEST:
        opener = node.children[0].type if node.children else "["
        if opener == "[[":
            tree = await expand_double_bracket(
                node, context, execute_fn, cs, view=view
            )
            return await handle_test(
                dispatch, namespace, tree, session, name="[[", view=view
            )
        test_argv = await expand_test_expr(
            node, context, execute_fn, cs, view=view
        )
        return await handle_test(
            dispatch, namespace, test_argv, session, name="[", view=view
        )

    if kind == NodeKind.NEGATED:
        inner = get_negated_command(node)
        with ignoring_errexit(session):
            stdout, io, exec_node = await stream(inner, context, stdin, cs)
        return await _negated(stdout, io, exec_node, context, inner)

    if kind == NodeKind.VAR_ASSIGN:
        return await execute_assignment(
            node, context, execute_fn, registry, namespace, cs
        )

    if kind == NodeKind.VAR_ASSIGNS:
        sub_seq = context.frame.cmdsub_seq
        merged_io = IOResult()
        for child in node.named_children:
            if child.type != NT.VARIABLE_ASSIGNMENT:
                continue
            _, io, _ = await recurse(
                child, context, stdin, cs, own_diagnostics=False
            )
            merged_io = await merged_io.merge(io)
        # The statement's status follows the last command substitution
        # performed across ALL its assignments, not the last child's.
        code = assignment_status(context.frame, sub_seq)
        merged_io.exit_code = code
        return (
            None,
            merged_io,
            ExecutionNode(command=get_text(node), exit_code=code),
        )

    # Constructs the parser accepts but the executor cannot honor
    # (tree-sitter ERROR nodes, future grammar additions).
    return fail(
        get_text(node),
        f"mirage: unsupported shell construct: {node.type}\n",
        2,
    )

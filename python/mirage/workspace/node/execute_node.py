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
from dataclasses import replace
from functools import partial
from typing import Any, Callable

from mirage.cache.index.scope import command_scope
from mirage.context import (
    program_invocation,
    reset_program_invocation,
    set_program_invocation,
)
from mirage.io import IOResult
from mirage.io.async_line_iterator import share
from mirage.io.stream import async_chain
from mirage.io.types import ByteSource
from mirage.ops.types import SessionView
from mirage.policy import HandOff, PolicyDenied
from mirage.process.supervisor import ProcessSupervisor
from mirage.runtime.routing import RouteDecision
from mirage.runtime.types import DispatchFn
from mirage.shell.barrier import BarrierPolicy, apply_barrier
from mirage.shell.bytes import encode_text
from mirage.shell.call_stack import CallStack
from mirage.shell.console import JobConsole
from mirage.shell.constants import (
    ERREXIT_EXEMPT_TYPES,
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
    get_redirects,
    get_text,
    get_unset_args,
    get_while_parts,
    take_continuation,
)
from mirage.shell.job_table import JobTable
from mirage.shell.node_kind import NodeKind, node_kind, pipeline_transparent
from mirage.shell.parse.names import literal_text
from mirage.shell.types import NodeType as NT
from mirage.shell.types import PipelineStages, Redirect, RedirectKind
from mirage.types import PathSpec
from mirage.workspace.evaluation import (
    EvaluationContext,
    child_context,
    reset_current_evaluation,
    set_current_evaluation,
)
from mirage.workspace.execution import ExecutionScope
from mirage.workspace.executor.builtins import handle_test, handle_unset
from mirage.workspace.executor.builtins.exec import install_exec_redirects
from mirage.workspace.executor.builtins.shared import is_valid_name
from mirage.workspace.executor.control import (
    UNWINDING,
    carried,
    handle_case,
    handle_cfor,
    handle_for,
    handle_if,
    handle_select,
    handle_until,
    handle_while,
)
from mirage.workspace.executor.jobs import drained, run_statement
from mirage.workspace.executor.pipes import (
    handle_connection,
    handle_pipe,
    handle_subshell,
)
from mirage.workspace.executor.redirect import handle_redirect
from mirage.workspace.executor.statement import (
    assignment_status,
    fd0_binding,
    finish_statement,
    record_status,
)
from mirage.workspace.executor.traps import end_shell
from mirage.workspace.expand import (
    expand_and_classify,
    expand_node,
    expand_redirects,
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
from mirage.workspace.session.elements import land_arith
from mirage.workspace.session.functions import FunctionSite
from mirage.workspace.session.state import (
    random_reader,
    session_arith,
    session_view,
)
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
        view (SessionView | None): the session plane's gated door the
            assignments land through; None outside a workspace.

    Raises:
        ArithError: re-raised with the expression text prepended, so
            the loop can print bash's `((: expr: reason` diagnostic.
        ReadonlyError: the expression assigns to a readonly variable,
            which aborts the loop the same way an invalid expression
            does; the writes before it have landed.
        ExitSignal: that assignment was inside a subscript.
        PolicyDenied: a pre_session rule refused one of the writes.
    """
    session = context.session
    if not exprs:
        return default
    # One comma expression, evaluated once, so an assignment early in
    # the slot is seen by the expressions after it.
    text = ", ".join(
        [
            await expand_arith(
                expr, context, execute_fn, call_stack, view=view
            )
            for expr in exprs
        ]
    )
    reader = random_reader(session)
    error: ArithError | ReadonlyError | None = None
    value = 0
    try:
        result = session_arith(session, text, reader)
        writes, value = result.writes, result.value
    except (ArithError, ReadonlyError) as exc:
        # bash bound the assignments made before the error; they land
        # before the error is reported.
        error, writes = exc, exc.writes
    # Through the door, so a pre_session rule governs an arithmetic
    # assignment exactly as it governs `X=1` and a hidden name refuses
    # at its own write; in evaluation order, so a bare name and its
    # element 0 land as the expression wrote them.
    await land_arith(session, view, writes)
    reader.settle()
    if isinstance(error, ReadonlyError):
        if error.in_subscript:
            raise error.signal()
        raise error
    if error is not None:
        raise ArithError(f"{text}: {error}") from error
    return int(value)


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
    if node is not right:
        return await recurse(node, context, stdin, call_stack, sink=sink)
    # The session plane's door, bound once for the line: every
    # expansion-time write (`${X:=d}`, `$((X=5))`) lands through it,
    # so a pre_session rule governs those exactly as it governs `X=d`.
    view = session_view(
        session, registry.policies, diagnostics=context.frame.diagnostics
    )
    return await _run_redirected(
        recurse,
        dispatch,
        execute_fn,
        registry,
        view,
        right,
        redirects,
        processes,
        context,
        stdin,
        call_stack,
    )


async def _recurse_lifted(
    recurse: Callable[..., Any],
    dispatch: DispatchFn,
    execute_fn: Callable[..., Any],
    registry: MountRegistry,
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
        stages,
        context,
        stdin,
        call_stack,
        processes,
    )


async def _recurse_stage(
    recurse: Callable[..., Any],
    dispatch: DispatchFn,
    execute_fn: Callable[..., Any],
    registry: MountRegistry,
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
    stages: PipelineStages,
    context: EvaluationContext,
    stdin: Any,
    call_stack: CallStack | None,
    processes: ProcessSupervisor | None = None,
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
        stages (PipelineStages): the pipeline's stages.
        context (EvaluationContext): the evaluation's session and frame.
        stdin (Any): input stream.
        call_stack (CallStack | None): shell call stack.
        processes (ProcessSupervisor | None): where the stages run as
            managed processes.
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
            replace(stages, lead=None),
            processes,
            right,
        )
        return await handle_connection(
            wrapped, left, op, right, context, stdin, call_stack
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
        stages,
        targets,
        processes,
    )
    stdout, io, exec_node = await handle_pipe(
        pipe_recurse,
        commands,
        stderr_flags,
        context,
        stdin,
        call_stack,
        processes,
        execute_fn,
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
    targets: list[Any],
    node: Any,
    context: EvaluationContext,
    stdin: Any = None,
    call_stack: CallStack | None = None,
    *,
    sink: JobConsole | None = None,
) -> tuple[Any, IOResult, ExecutionNode]:
    # The session plane's door, bound once for the line: every
    # expansion-time write (`${X:=d}`, `$((X=5))`) lands through it,
    # so a pre_session rule governs those exactly as it governs `X=d`.
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
    expanded, pipe_node = await expand_redirects(
        redirects, context, execute_fn, registry, call_stack, view=view
    )
    stdout, io, exec_node = await handle_redirect(
        recurse, dispatch, command, expanded, context, stdin, call_stack
    )
    if pipe_node is not None and stdout is not None:
        stdout, io2, exec_node2 = await recurse(
            pipe_node, context, stdout, call_stack
        )
        io = await io.merge(io2)
        exec_node = exec_node2
    return stdout, io, exec_node


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
    # Lazy exit codes (exit_on_empty in grep) must be final before
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
        view (SessionView | None): the session plane's gated door.
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
            redirects,
            processes,
            right,
        )
        return await handle_connection(
            wrapped, left, op, right, context, stdin, call_stack
        )
    if command is not None and command.type == NT.PIPELINE:
        return await _run_pipeline(
            recurse,
            dispatch,
            execute_fn,
            registry,
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
        stdout, io, exec_node = await _run_redirected(
            recurse,
            dispatch,
            execute_fn,
            registry,
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
    expanded_redirects, pipe_node = await expand_redirects(
        redirects,
        context,
        execute_fn,
        registry,
        call_stack,
        view=view,
        forked=_forks(command, context),
    )
    # `exec > file` with no command installs the redirects on the
    # shell for every later statement, rather than applying them to
    # one command. `exec cmd > file` still has a command and falls
    # through to the ordinary path, which refuses the command form.
    if _is_bare_exec(command):
        return await install_exec_redirects(
            dispatch, session, expanded_redirects, stdin
        )
    # A heredoc's operator line reads the routed stdout, so then it is
    # returned rather than written. A simple command expands its words
    # before its redirects apply, so what that printed (a substitution's
    # stderr) goes around them; a compound body expands inside them.
    simple = command is not None and command.type in (
        NT.COMMAND,
        NT.VARIABLE_ASSIGNMENT,
        NT.VARIABLE_ASSIGNMENTS,
    )
    outer = context.frame.diagnostics
    if simple:
        context.frame.diagnostics = []
    try:
        stdout, io, exec_node = await handle_redirect(
            partial(recurse, own_diagnostics=False) if simple else recurse,
            dispatch,
            command,
            expanded_redirects,
            context,
            stdin,
            call_stack,
            sink=sink if pipe_node is None else None,
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
    """
    if not steps:
        return await run_left(context, stdin, call_stack)
    op, right = steps[-1]
    wrapped = partial(
        _recurse_continuation, recurse, run_left, left, steps[:-1]
    )
    return await handle_connection(
        wrapped, left, op, right, context, stdin, call_stack
    )


async def _recurse_continuation(
    recurse: Callable[..., Any],
    run_left: Callable[..., Any],
    left: Any,
    steps: tuple[tuple[str, Any], ...],
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
        node (Any): the node ``handle_connection`` asks for.
        context (EvaluationContext): the evaluation's session and frame.
        stdin (Any): input stream.
        call_stack (CallStack | None): shell call stack.
    """
    if node is left:
        return await _run_continuation(
            recurse, run_left, left, steps, context, stdin, call_stack
        )
    return await recurse(node, context, stdin, call_stack)


def _is_bare_exec(command: Any) -> bool:
    """Whether a redirected statement's command is a bare `exec`.

    A bare `exec` carries a command name and no arguments, so its
    redirects are the shell's own rather than one command's. `exec cmd`
    is not bare and falls through to the command path, which refuses it.

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
    routing_decision: RouteDecision | None = None,
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
    # What expanding the node printed (a substitution's stderr) goes out
    # with the node's own stderr, unless its caller collects it: a simple
    # command's words expand before its redirects apply.
    if not own_diagnostics:
        return await _execute_node(
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
    outer = context.frame.diagnostics
    context.frame.diagnostics = []
    try:
        stdout, io, exec_node = await _execute_node(
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
        if context.frame.diagnostics:
            err = _diagnostic_stderr(node, context)
            io.stderr = err + await io.materialize_stderr()
            exec_node.stderr = err + (exec_node.stderr or b"")
        return stdout, io, exec_node
    except ExitSignal as exc:
        exc.stderr = _diagnostic_stderr(node, context) + exc.stderr
        raise
    finally:
        context.frame.diagnostics = outer


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
    routing_decision: RouteDecision | None = None,
    sink: JobConsole | None = None,
    handed: HandOff | None = None,
    execution_scope: ExecutionScope | None = None,
) -> tuple[Any, IOResult, ExecutionNode]:
    """Walk tree-sitter AST and dispatch each node.

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
        cancel (asyncio.Event | None): event used to abort mid-flight.
        handed (HandOff | None): the hand-off this subtree runs on,
            carried to every command's gate so it runs on the grants
            claimed for this line and never another's, and bound into
            ``execute_fn`` so every line the subtree evaluates stands
            under it too.
        sink (JobConsole | None): console to write this node's output to
            as it is produced. When set, the node emits and returns no
            stdout; when None it returns stdout as a value, which is
            what capture sites (command substitution, pipe stages,
            redirects) rely on.
    """
    session = context.session
    # The session plane's door, bound once for the line: every
    # expansion-time write (`${X:=d}`, `$((X=5))`) lands through it,
    # so a pre_session rule governs those exactly as it governs `X=d`.
    view = session_view(
        session, registry.policies, diagnostics=context.frame.diagnostics
    )
    # `set -n` reads without executing, and it stops *everything* after
    # it, at every depth: GNU answers `if true; then set -n; echo BAD;
    # fi` and `f(){ set -n; echo BAD; }; f` with nothing at all. Stated
    # here, at the one door every node goes through, rather than in each
    # statement runner -- the program loop, the subshell body, a group,
    # a function body and every loop body are five places for one rule to
    # drift, and it did: the check lived in the program loop alone, so
    # `set -n` worked flat and did nothing one construct deep. The
    # program loop keeps its own `break` as the reader-level stop, which
    # is also what silences `set -v` for the lines it never reads.
    if session.shell_options.get("noexec"):
        return None, IOResult(), ExecutionNode(command="", exit_code=0)
    cs = call_stack if call_stack is not None else CallStack()
    session.errexit_immune = False

    # The hand-off this subtree runs on is the one its nested
    # evaluations run under. Everything a command hands a line to
    # (eval, source, xargs, command, a substitution, a herestring, a
    # redirect target) re-enters through execute_fn, so the hand-off is
    # bound into it here, at the one door every node goes through,
    # rather than where the line made it: a background job's subtree
    # runs on a hand-off of the job's own, and a line it evaluates
    # after the typed line has ended has to stand under that one.
    # Under the line's, the inner gate could not see the grant the job
    # holds and asked again, and what it claimed went back to a
    # hand-off nothing revokes any more. The event is rebound for the
    # same reason: a background job runs without the caller's, and so
    # must the lines it evaluates, or a `$(...)` inside the job would
    # die of an abort that was never the job's.
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
    # body, a nested shell) and a redirect (what it routes), draining
    # whatever they return after; everything else runs unchanged and has
    # its result drained here. Only these kinds inherit a sink, so
    # capture sites keep receiving their output as a value.
    if (
        sink is not None
        and kind not in STREAMING_KINDS
        and kind
        not in (
            NodeKind.COMMAND,
            NodeKind.REDIRECT,
            NodeKind.VAR_ASSIGN,
            NodeKind.VAR_ASSIGNS,
        )
    ):
        return await drained(sink, *await recurse(node, context, stdin, cs))

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

    # ── program (root / semicolons) ─────────────
    if kind == NodeKind.PROGRAM:
        # A root run in a caller's frame is the caller's own line (eval,
        # an alias); one given none is a shell of its own.
        return await execute_program(
            recurse,
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

    # ── command ─────────────────────────────────
    if kind == NodeKind.COMMAND:
        async with command_scope():
            result = await execute_command(
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
        return result if sink is None else await drained(sink, *result)

    # ── pipeline ────────────────────────────────
    if kind == NodeKind.PIPELINE:
        # `! a | b` parses as pipeline(negated_command(a), b), and a
        # redirect followed by `|` closes over everything to its left, so
        # the stages are read the way bash reads them rather than as the
        # parse nested them (see get_pipeline_stages).
        return await _run_pipeline(
            recurse,
            dispatch,
            execute_fn,
            registry,
            get_pipeline_stages(node),
            context,
            stdin,
            cs,
            job_table.processes if job_table is not None else None,
        )

    # ── list (&&, ||) ───────────────────────────
    if kind == NodeKind.LIST:
        left, op, right = get_list_parts(node)
        return await handle_connection(
            stream, left, op, right, context, stdin, cs
        )

    # ── redirected statement ────────────────────
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
            view,
            command,
            redirects,
            job_table.processes if job_table is not None else None,
            sink=sink,
        )
        if not continuation:
            result = await run_left(context, stdin, cs)
        else:
            result = await _run_continuation(
                recurse, run_left, node, continuation, context, stdin, cs
            )
        return result if sink is None else await drained(sink, *result)

    # ── subshell ────────────────────────────────
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
                reset_current_evaluation(token)
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

    # ── arithmetic command ((( ... ))) ──────────
    if (
        kind == NodeKind.COMPOUND
        and node.children
        and node.children[0].type == NT.ARITH_OPEN
    ):
        text = get_text(node)
        expr = await expand_arith(node, context, execute_fn, cs, view=view)
        reader = random_reader(session)
        error: ArithError | ReadonlyError | None = None
        value = 0
        try:
            # Reads resolve against the visible env so a hidden name
            # counts as unset; a hidden write refuses at its own write
            # below, in this command's own voice like the readonly one.
            arith = session_arith(session, expr, reader)
            writes, value = arith.writes, arith.value
        except (ArithError, ReadonlyError) as exc:
            # bash bound the assignments made before the error; they
            # land before the error is reported.
            error, writes = exc, exc.writes
        try:
            await land_arith(session, view, writes)
            reader.settle()
        except PolicyDenied as exc:
            err = encode_text(f"bash: {exc.strerror}\n")
            return (
                None,
                IOResult(exit_code=1, stderr=err),
                ExecutionNode(command=text, exit_code=1, stderr=err),
            )
        if isinstance(error, ReadonlyError):
            if error.in_subscript:
                raise error.signal()
            err = encode_text(f"bash: {error}\n")
            return (
                None,
                IOResult(exit_code=1, stderr=err),
                ExecutionNode(command=text, exit_code=1, stderr=err),
            )
        if error is not None:
            err = encode_text(f"bash: ((: {expr}: {error}\n")
            return (
                None,
                IOResult(exit_code=1, stderr=err),
                ExecutionNode(command=text, exit_code=1, stderr=err),
            )
        code = 0 if value != 0 else 1
        return (
            None,
            IOResult(exit_code=code),
            ExecutionNode(command=text, exit_code=code),
        )

    # ── compound statement ({ ... }) ───────────
    if kind == NodeKind.COMPOUND:
        all_stdout: list[Any] = []
        merged_io = IOResult()
        last_exec = ExecutionNode(command="{}", exit_code=0)
        bound = fd0_binding(session)
        for child in node.named_children:
            if child.type == NT.COMMENT:
                continue
            try:
                stdout, io, last_exec = await run_statement(
                    stream,
                    child,
                    context,
                    stdin,
                    bound,
                    cs,
                    job_table,
                    agent_id,
                    handed,
                    registry.decisions,
                )
            except UNWINDING as sig:
                raise await carried(sig, async_chain(all_stdout), merged_io)
            stdout = await finish_statement(stdout, io, session, child)
            if stdout is not None:
                all_stdout.append(stdout)
            merged_io = await merged_io.merge(io)
            if (
                io.exit_code != 0
                and session.shell_options.get("errexit")
                and child.type not in ERREXIT_EXEMPT_TYPES
                and not session.errexit_immune
            ):
                merged_io.exit_code = io.exit_code
                break
        if len(all_stdout) == 1:
            return all_stdout[0], merged_io, last_exec
        combined = async_chain(all_stdout) if all_stdout else None
        return combined, merged_io, last_exec

    # ── if ──────────────────────────────────────
    if kind == NodeKind.IF:
        branches, else_body = get_if_branches(node)
        return await handle_if(
            stream,
            branches,
            else_body,
            context,
            stdin,
            cs,
            job_table=job_table,
            agent_id=agent_id,
            handed=handed,
            decisions=registry.decisions,
        )

    # ── C-style for (for ((init;cond;update))) ──
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
            return await handle_cfor(
                stream,
                exprs,
                body,
                eval_expr,
                context,
                stdin,
                cs,
                job_table=job_table,
                agent_id=agent_id,
                handed=handed,
                decisions=registry.decisions,
            )

    # ── for / select ────────────────────────────
    if kind in (NodeKind.FOR, NodeKind.SELECT):
        var, values, body = get_for_parts(node)
        if not is_valid_name(var):
            err = encode_text(f"bash: `{var}': not a valid identifier\n")
            return (
                None,
                IOResult(exit_code=1, stderr=err),
                ExecutionNode(command=kind.value, exit_code=1, stderr=err),
            )
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
        if kind == NodeKind.SELECT:
            with cs.loop():
                return await handle_select(
                    stream,
                    var,
                    classified,
                    body,
                    context,
                    stdin,
                    cs,
                    policies=namespace.registry.policies,
                    job_table=job_table,
                    agent_id=agent_id,
                    handed=handed,
                    decisions=registry.decisions,
                    sink=sink,
                )
        with cs.loop():
            return await handle_for(
                stream,
                var,
                classified,
                body,
                context,
                stdin,
                cs,
                policies=namespace.registry.policies,
                job_table=job_table,
                agent_id=agent_id,
                handed=handed,
                decisions=registry.decisions,
            )

    # ── while / until ───────────────────────────
    if kind in (NodeKind.WHILE, NodeKind.UNTIL):
        condition, body = get_while_parts(node)
        if kind == NodeKind.UNTIL:
            with cs.loop():
                return await handle_until(
                    stream,
                    condition,
                    body,
                    context,
                    stdin,
                    cs,
                    job_table=job_table,
                    agent_id=agent_id,
                    handed=handed,
                    decisions=registry.decisions,
                )
        with cs.loop():
            return await handle_while(
                stream,
                condition,
                body,
                context,
                stdin,
                cs,
                job_table=job_table,
                agent_id=agent_id,
                handed=handed,
                decisions=registry.decisions,
            )

    # ── case ────────────────────────────────────
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
        return await handle_case(
            stream,
            word,
            case_items,
            context,
            stdin,
            cs,
            job_table=job_table,
            agent_id=agent_id,
            handed=handed,
            decisions=registry.decisions,
        )

    # ── function definition ─────────────────────
    if kind == NodeKind.FUNCTION_DEF:
        name = get_function_name(node)
        if name in session.readonly_functions:
            # `readonly -f f` froze the body: either definition syntax
            # refuses with `f: readonly function`, exit 1, and the old
            # body stays, pinned on 5.2.37.
            err = encode_text(f"bash: {name}: readonly function\n")
            return (
                None,
                IOResult(exit_code=1, stderr=err),
                ExecutionNode(
                    command=f"function {name}", exit_code=1, stderr=err
                ),
            )
        source = get_function_source(node)
        session.functions[name] = source
        session._function_sites[name] = FunctionSite(
            source,
            (session._parse_current, session._parse_row + node.start_point[0]),
            defined_at(node, handed),
        )
        return (
            None,
            IOResult(),
            ExecutionNode(command=f"function {name}", exit_code=0),
        )

    # ── declaration (export/local/declare/readonly) ──
    if kind == NodeKind.DECLARATION:
        async with command_scope():
            return await execute_declaration(
                node, context, execute_fn, registry, namespace, cs, view
            )

    # ── unset ───────────────────────────────────
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

    # ── test ([ ] or [[ ]]) ─────────────────────
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

    # ── negated command ─────────────────────────
    if kind == NodeKind.NEGATED:
        inner = get_negated_command(node)
        stdout, io, exec_node = await stream(inner, context, stdin, cs)
        return await _negated(stdout, io, exec_node, context, inner)

    # ── variable assignment at top level ────────
    if kind == NodeKind.VAR_ASSIGN:
        return await execute_assignment(
            node, context, execute_fn, registry, namespace, cs
        )

    # ── assignment-only statement (a=1 b=2) ─────
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
    # (tree-sitter ERROR nodes, future grammar additions). Mirrors the
    # unsupported-builtin diagnostic so agents see a capability gap,
    # not a crash.
    err = encode_text(f"mirage: unsupported shell construct: {node.type}\n")
    return (
        None,
        IOResult(exit_code=2, stderr=err),
        ExecutionNode(command=get_text(node), exit_code=2, stderr=err),
    )

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
from functools import partial
from typing import Any, Callable

from mirage.io import IOResult
from mirage.io.stream import async_chain
from mirage.ops.types import SessionView
from mirage.policy import HandOff, PolicyDenied
from mirage.runtime.routing import RouteDecision
from mirage.runtime.types import DispatchFn
from mirage.shell.arith import evaluate_arith
from mirage.shell.barrier import BarrierPolicy, apply_barrier
from mirage.shell.call_stack import CallStack
from mirage.shell.console import Channel, JobConsole
from mirage.shell.constants import ERREXIT_EXEMPT_TYPES
from mirage.shell.errors import ArithError, ExitSignal, ReadonlyError
from mirage.shell.job_table import JobTable
from mirage.shell.node_kind import NodeKind, node_kind, pipeline_transparent
from mirage.shell.types import NodeType as NT
from mirage.shell.types import Redirect, RedirectKind
from mirage.workspace.abort import MirageAbortError
from mirage.workspace.executor.builtins import handle_test, handle_unset
from mirage.workspace.executor.builtins.exec import install_exec_redirects
from mirage.workspace.executor.control import (handle_case, handle_cfor,
                                               handle_for, handle_if,
                                               handle_select, handle_until,
                                               handle_while)
from mirage.workspace.executor.jobs import pump
from mirage.workspace.executor.pipes import (handle_connection, handle_pipe,
                                             handle_subshell)
from mirage.workspace.executor.redirect import handle_redirect
from mirage.workspace.executor.statement import (assignment_status,
                                                 finish_statement,
                                                 record_status)
from mirage.workspace.expand import (expand_and_classify, expand_node,
                                     expand_redirects)
from mirage.workspace.expand.globs import glob_options, resolve_globs
from mirage.workspace.expand.node import expand_arith
from mirage.workspace.expand.pattern import expand_pattern
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.node.assignment import execute_assignment
from mirage.workspace.node.command_dispatch import execute_command
from mirage.workspace.node.declaration import execute_declaration
from mirage.workspace.node.program import execute_program
from mirage.workspace.node.test_expr import (expand_double_bracket,
                                             expand_test_expr)
from mirage.workspace.session import Session
from mirage.workspace.session.elements import assign_element
from mirage.workspace.session.state import (ensure_var_visible, random_reader,
                                            session_elements, session_view,
                                            visible_env)
from mirage.workspace.types import ExecutionNode

from mirage.shell.helpers import (  # isort: skip
    get_case_items, get_case_word, get_cfor_parts, get_for_parts,
    get_function_body, get_function_name, get_if_branches, get_list_parts,
    get_negated_command, get_parts, get_pipeline_commands, get_redirects,
    get_text, get_unset_args, get_while_parts)


async def _eval_cfor_expr(
    exprs: list[Any],
    default: int,
    session: Session,
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
        session (Session): shell session; arithmetic assignments land
            in its env.
        execute_fn (Callable): recursive execute for substitutions.
        call_stack (CallStack | None): function-call scope, if any.
        view (SessionView | None): the session plane's gated door the
            assignments land through; None outside a workspace.

    Raises:
        ArithError: re-raised with the expression text prepended, so
            the loop can print bash's `((: expr: reason` diagnostic.
        ReadonlyError: the expression assigns to a readonly variable,
            which aborts the loop the same way an invalid expression
            does.
        PolicyDenied: a pre_session rule refused one of the writes.
    """
    if not exprs:
        return default
    # One comma expression, evaluated once, so an assignment early in
    # the slot is seen by the expressions after it.
    text = ", ".join([
        await expand_arith(expr, session, execute_fn, call_stack, view=view)
        for expr in exprs
    ])
    reader = random_reader(session)
    error: ArithError | None = None
    value = 0
    try:
        # Reads resolve against the visible env so a hidden name counts
        # as unset; a hidden write refuses through the session door
        # (ensure_var_visible), caught by the loop beside ReadonlyError.
        result = evaluate_arith(text,
                                visible_env(session),
                                elements=session_elements(session, reader),
                                read_var=reader.read,
                                wrote_var=reader.wrote)
        writes, value = result.writes, result.value
    except ArithError as exc:
        # bash bound the assignments made before the error; they land
        # before the error is reported.
        error, writes = exc, exc.writes
    for write in writes:
        ensure_var_visible(session, write.name)
        if write.name in session.readonly_vars:
            raise ReadonlyError(write.name)
    # Through the door, so a pre_session rule governs an arithmetic
    # assignment exactly as it governs `X=1`; in evaluation order, so
    # a bare name and its element 0 land as the expression wrote them.
    for write in writes:
        await assign_element(session, view, write.name, write.key, write.value)
    reader.settle()
    if error is not None:
        raise ArithError(f"{text}: {error}") from error
    return int(value)


STREAMING_KINDS = frozenset({
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
})


async def _recurse_reassociated(
    recurse: Callable[..., Any],
    dispatch: DispatchFn,
    execute_fn: Callable[..., Any],
    registry: MountRegistry,
    redirects: list[Any],
    right: Any,
    node: Any,
    session: Session,
    stdin: Any = None,
    call_stack: CallStack | None = None,
) -> tuple[Any, IOResult, ExecutionNode]:
    """Recurse wrapper for a re-associated trailing redirect.

    Executes the list's last command with the hoisted redirects,
    expanding targets only at that point (after the left side ran, so
    cwd changes apply); every other node recurses normally.

    Args:
        recurse (Callable): the plain execute_node recursion.
        dispatch (DispatchFn): VFS op dispatcher.
        execute_fn (Callable): recursive execute (for expansions).
        registry (MountRegistry): mount registry.
        redirects (list): parsed redirects hoisted off the list.
        right (Any): the list's last command node.
        node (Any): node being executed by handle_connection.
        session (Session): shell session state.
        stdin (Any): input stream.
        call_stack (CallStack | None): shell call stack.
    """
    # The session plane's door, bound once for the line: every
    # expansion-time write (`${X:=d}`, `$((X=5))`) lands through it,
    # so a pre_session rule governs those exactly as it governs `X=d`.
    view = session_view(session, registry.policies)
    if node is not right:
        return await recurse(node, session, stdin, call_stack)
    expanded, pipe_node = await expand_redirects(redirects,
                                                 session,
                                                 execute_fn,
                                                 registry,
                                                 call_stack,
                                                 view=view)
    stdout, io, exec_node = await handle_redirect(recurse, dispatch, right,
                                                  expanded, session, stdin,
                                                  call_stack)
    if pipe_node is not None and stdout is not None:
        stdout, io2, exec_node2 = await recurse(pipe_node, session, stdout,
                                                call_stack)
        io = await io.merge(io2)
        exec_node = exec_node2
    return stdout, io, exec_node


async def _recurse_pipe_stderr(
    recurse: Callable[..., Any],
    dispatch: DispatchFn,
    execute_fn: Callable[..., Any],
    registry: MountRegistry,
    targets: list[Any],
    node: Any,
    session: Session,
    stdin: Any = None,
    call_stack: CallStack | None = None,
) -> tuple[Any, IOResult, ExecutionNode]:
    # The session plane's door, bound once for the line: every
    # expansion-time write (`${X:=d}`, `$((X=5))`) lands through it,
    # so a pre_session rule governs those exactly as it governs `X=d`.
    view = session_view(session, registry.policies)
    if node not in targets or node_kind(node) != NodeKind.REDIRECT:
        return await recurse(node, session, stdin, call_stack)
    command, redirects = get_redirects(node)
    redirects.append(
        Redirect(fd=2, target=1, kind=RedirectKind.STDERR_TO_STDOUT))
    expanded, pipe_node = await expand_redirects(redirects,
                                                 session,
                                                 execute_fn,
                                                 registry,
                                                 call_stack,
                                                 view=view)
    stdout, io, exec_node = await handle_redirect(recurse, dispatch, command,
                                                  expanded, session, stdin,
                                                  call_stack)
    if pipe_node is not None and stdout is not None:
        stdout, io2, exec_node2 = await recurse(pipe_node, session, stdout,
                                                call_stack)
        io = await io.merge(io2)
        exec_node = exec_node2
    return stdout, io, exec_node


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
    return (len(named) == 1 and named[0].type == NT.COMMAND_NAME
            and get_text(named[0]) == "exec")


async def execute_node(
    dispatch: DispatchFn,
    registry: MountRegistry,
    namespace: Namespace,
    job_table: JobTable,
    execute_fn: Callable[..., Any],
    agent_id: str,
    node: Any,
    session: Session,
    stdin: Any = None,
    call_stack: CallStack | None = None,
    cancel: asyncio.Event | None = None,
    routing_decision: RouteDecision | None = None,
    sink: JobConsole | None = None,
    handed: HandOff | None = None,
) -> tuple[Any, IOResult, ExecutionNode]:
    outer = session._diagnostics
    session._diagnostics = []
    try:
        stdout, io, exec_node = await _execute_node(dispatch, registry,
                                                    namespace, job_table,
                                                    execute_fn, agent_id, node,
                                                    session, stdin, call_stack,
                                                    cancel, routing_decision,
                                                    sink, handed)
        if session._diagnostics:
            err = _diagnostic_stderr(node, session)
            io.stderr = err + await io.materialize_stderr()
            exec_node.stderr = err + (exec_node.stderr or b"")
        return stdout, io, exec_node
    except ExitSignal as exc:
        exc.stderr = _diagnostic_stderr(node, session) + exc.stderr
        raise
    finally:
        session._diagnostics = outer


def _diagnostic_stderr(node: Any, session: Session) -> bytes:
    if not session._diagnostics:
        return b""
    head = get_text(node).split(None, 1)[0]
    builtin = head if head in {
        "export", "declare", "local", "readonly", "read", "printf", "let"
    } else ""
    prefix = f"bash: {builtin}: " if builtin else "bash: "
    return b"".join(
        message if isinstance(message, bytes) else (prefix + message +
                                                    "\n").encode()
        for message in session._diagnostics)


async def _execute_node(
    dispatch: DispatchFn,
    registry: MountRegistry,
    namespace: Namespace,
    job_table: JobTable,
    execute_fn: Callable[..., Any],
    agent_id: str,
    node: Any,
    session: Session,
    stdin: Any = None,
    call_stack: CallStack | None = None,
    cancel: asyncio.Event | None = None,
    routing_decision: RouteDecision | None = None,
    sink: JobConsole | None = None,
    handed: HandOff | None = None,
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
        session (Session): shell session state.
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
    # The session plane's door, bound once for the line: every
    # expansion-time write (`${X:=d}`, `$((X=5))`) lands through it,
    # so a pre_session rule governs those exactly as it governs `X=d`.
    view = session_view(session, registry.policies)
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
    if cancel is not None and cancel.is_set():
        raise MirageAbortError()
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
    # hand-off nothing revokes any more.
    execute_fn = partial(execute_fn, handed=handed)

    recurse = partial(execute_node,
                      dispatch,
                      registry,
                      namespace,
                      job_table,
                      execute_fn,
                      agent_id,
                      cancel=cancel,
                      routing_decision=routing_decision,
                      handed=handed)

    kind = node_kind(node)

    # A sink turns this walk from "return your output" into "write your
    # output". Sequencing constructs pass it to their children so each
    # statement lands as it finishes; everything else runs unchanged and
    # has its result drained here. Only the kinds below inherit a sink,
    # so capture sites keep receiving their output as a value.
    if sink is not None and kind not in STREAMING_KINDS:
        stdout, io, exec_node = await recurse(node, session, stdin, cs)
        await pump(sink, Channel.STDOUT, stdout)
        stderr = await io.materialize_stderr()
        if stderr:
            await sink.emit(Channel.STDERR, stderr)
            # Cleared so the job's tail does not emit it a second time.
            io.stderr = None
        return None, io, exec_node

    stream = partial(recurse, sink=sink) if sink is not None else recurse

    if kind == NodeKind.COMMENT:
        return None, IOResult(), ExecutionNode(command="", exit_code=0)

    # ── program (root / semicolons) ─────────────
    if kind == NodeKind.PROGRAM:
        return await execute_program(stream, node, session, stdin, cs,
                                     job_table, agent_id, dispatch, handed,
                                     registry.decisions)

    # ── command ─────────────────────────────────
    if kind == NodeKind.COMMAND:
        return await execute_command(recurse,
                                     dispatch,
                                     registry,
                                     namespace,
                                     execute_fn,
                                     node,
                                     session,
                                     stdin,
                                     cs,
                                     job_table,
                                     cancel=cancel,
                                     routing_decision=routing_decision,
                                     agent_id=agent_id,
                                     handed=handed)

    # ── pipeline ────────────────────────────────
    if kind == NodeKind.PIPELINE:
        commands, stderr_flags = get_pipeline_commands(node)
        # `! a | b` parses as pipeline(negated_command(a), b) but bash
        # negates the WHOLE pipeline's exit status.
        negated = bool(commands) and commands[0].type == NT.NEGATED_COMMAND
        if negated:
            commands = [get_negated_command(commands[0])] + commands[1:]
        pipe_recurse = recurse
        if any(stderr_flags):
            targets = [
                command for i, command in enumerate(commands)
                if i < len(stderr_flags) and stderr_flags[i]
            ]
            pipe_recurse = partial(_recurse_pipe_stderr, recurse, dispatch,
                                   execute_fn, registry, targets)
        stdout, io, exec_node = await handle_pipe(pipe_recurse, commands,
                                                  stderr_flags, session, stdin,
                                                  cs)
        if negated:
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

    # ── list (&&, ||) ───────────────────────────
    if kind == NodeKind.LIST:
        left, op, right = get_list_parts(node)
        return await handle_connection(stream, left, op, right, session, stdin,
                                       cs)

    # ── redirected statement ────────────────────
    if kind == NodeKind.REDIRECT:
        command, redirects = get_redirects(node)
        if command is not None and command.type == NT.LIST:
            # tree-sitter hoists a trailing redirect over the whole
            # &&/|| list; bash binds it to the last command:
            #   redirected(list(L, op, R), r) == list(L, op, redirected(R, r))
            # Re-associate and defer target expansion until R runs, so
            # `cd /x && echo hi > f` writes under /x. Compound and
            # subshell bodies keep the whole-body redirect (bash group
            # semantics).
            left, op, right = get_list_parts(command)
            wrapped = partial(_recurse_reassociated, recurse, dispatch,
                              execute_fn, registry, redirects, right)
            return await handle_connection(wrapped, left, op, right, session,
                                           stdin, cs)
        if command is not None and command.type == NT.PIPELINE:
            commands, stderr_flags = get_pipeline_commands(command)
            right = commands[-1]
            wrapped = partial(_recurse_reassociated, recurse, dispatch,
                              execute_fn, registry, redirects, right)
            return await handle_pipe(wrapped, commands, stderr_flags, session,
                                     stdin, cs)
        expanded_redirects, pipe_node = await expand_redirects(redirects,
                                                               session,
                                                               execute_fn,
                                                               registry,
                                                               cs,
                                                               view=view)
        # `exec > file` with no command installs the redirects on the
        # shell for every later statement, rather than applying them to
        # one command. `exec cmd > file` still has a command and falls
        # through to the ordinary path, which refuses the command form.
        if _is_bare_exec(command):
            return await install_exec_redirects(dispatch, session,
                                                expanded_redirects)
        stdout, io, exec_node = await handle_redirect(recurse, dispatch,
                                                      command,
                                                      expanded_redirects,
                                                      session, stdin, cs)
        if pipe_node is not None and stdout is not None:
            stdout, io2, exec_node2 = await recurse(pipe_node, session, stdout,
                                                    cs)
            io = await io.merge(io2)
            exec_node = exec_node2
        return stdout, io, exec_node

    # ── subshell ────────────────────────────────
    if kind == NodeKind.SUBSHELL:
        # A subshell is its own shell: background jobs started inside
        # live in a private job table (`$!`/`wait`/`kill` in the body
        # see them; the parent's table never does), mirroring bash's
        # forked process.
        sub_table = JobTable()
        sub_recurse = partial(execute_node,
                              dispatch,
                              registry,
                              namespace,
                              sub_table,
                              execute_fn,
                              agent_id,
                              cancel=cancel,
                              routing_decision=routing_decision,
                              sink=sink,
                              handed=handed)
        return await handle_subshell(sub_recurse, list(node.children), session,
                                     stdin, cs, sub_table, agent_id, dispatch,
                                     handed, registry.decisions)

    # ── arithmetic command ((( ... ))) ──────────
    if (kind == NodeKind.COMPOUND and node.children
            and node.children[0].type == NT.ARITH_OPEN):
        text = get_text(node)
        expr = await expand_arith(node, session, execute_fn, cs, view=view)
        reader = random_reader(session)
        error: ArithError | None = None
        value = 0
        try:
            # Reads resolve against the visible env so a hidden name
            # counts as unset; a hidden write refuses below, in this
            # command's own voice like the readonly refusal.
            arith = evaluate_arith(expr,
                                   visible_env(session),
                                   elements=session_elements(session, reader),
                                   read_var=reader.read,
                                   wrote_var=reader.wrote)
            writes, value = arith.writes, arith.value
        except ArithError as exc:
            # bash bound the assignments made before the error; they
            # land before the error is reported.
            error, writes = exc, exc.writes
        for write in writes:
            name = write.name
            try:
                ensure_var_visible(session, name)
            except PolicyDenied as exc:
                err = f"bash: {exc.strerror}\n".encode()
                return None, IOResult(exit_code=1,
                                      stderr=err), ExecutionNode(command=text,
                                                                 exit_code=1,
                                                                 stderr=err)
            if name in session.readonly_vars:
                err = f"bash: {name}: readonly variable\n".encode()
                return None, IOResult(exit_code=1,
                                      stderr=err), ExecutionNode(command=text,
                                                                 exit_code=1,
                                                                 stderr=err)
        try:
            for write in writes:
                await assign_element(session, view, write.name, write.key,
                                     write.value)
            reader.settle()
        except PolicyDenied as exc:
            err = f"bash: {exc.strerror}\n".encode()
            return None, IOResult(exit_code=1,
                                  stderr=err), ExecutionNode(command=text,
                                                             exit_code=1,
                                                             stderr=err)
        if error is not None:
            err = f"bash: ((: {expr}: {error}\n".encode()
            return None, IOResult(exit_code=1,
                                  stderr=err), ExecutionNode(command=text,
                                                             exit_code=1,
                                                             stderr=err)
        code = 0 if value != 0 else 1
        return None, IOResult(exit_code=code), ExecutionNode(command=text,
                                                             exit_code=code)

    # ── compound statement ({ ... }) ───────────
    if kind == NodeKind.COMPOUND:
        all_stdout: list[Any] = []
        merged_io = IOResult()
        last_exec = ExecutionNode(command="{}", exit_code=0)
        for child in node.named_children:
            if child.type == NT.COMMENT:
                continue
            stdout, io, last_exec = await stream(child, session, stdin, cs)
            stdout = await finish_statement(stdout, io, session, child)
            if stdout is not None:
                all_stdout.append(stdout)
            merged_io = await merged_io.merge(io)
            if (io.exit_code != 0 and session.shell_options.get("errexit")
                    and child.type not in ERREXIT_EXEMPT_TYPES
                    and not session.errexit_immune):
                merged_io.exit_code = io.exit_code
                break
        if len(all_stdout) == 1:
            return all_stdout[0], merged_io, last_exec
        combined = async_chain(*all_stdout) if all_stdout else None
        return combined, merged_io, last_exec

    # ── if ──────────────────────────────────────
    if kind == NodeKind.IF:
        branches, else_body = get_if_branches(node)
        return await handle_if(stream, branches, else_body, session, stdin, cs)

    # ── C-style for (for ((init;cond;update))) ──
    if kind == NodeKind.CFOR:
        exprs, body = get_cfor_parts(node)
        eval_expr = partial(_eval_cfor_expr,
                            session=session,
                            execute_fn=execute_fn,
                            call_stack=cs,
                            view=view)
        return await handle_cfor(stream, exprs, body, eval_expr, session,
                                 stdin, cs)

    # ── for / select ────────────────────────────
    if kind in (NodeKind.FOR, NodeKind.SELECT):
        var, values, body = get_for_parts(node)
        classified = await expand_and_classify(values,
                                               session,
                                               execute_fn,
                                               registry,
                                               session.cwd,
                                               cs,
                                               view=view)
        # The loop word list is consumed by the shell (WordPolicy.SHELL):
        # globs resolve to matches before iteration starts.
        classified = await resolve_globs(
            classified,
            registry,
            noglob=bool(session.shell_options.get("noglob")),
            links=namespace,
            options=glob_options(session))
        if kind == NodeKind.SELECT:
            return await handle_select(stream,
                                       var,
                                       classified,
                                       body,
                                       session,
                                       stdin,
                                       cs,
                                       policies=namespace.registry.policies)
        return await handle_for(stream,
                                var,
                                classified,
                                body,
                                session,
                                stdin,
                                cs,
                                policies=namespace.registry.policies)

    # ── while / until ───────────────────────────
    if kind in (NodeKind.WHILE, NodeKind.UNTIL):
        condition, body = get_while_parts(node)
        if kind == NodeKind.UNTIL:
            return await handle_until(stream, condition, body, session, stdin,
                                      cs)
        return await handle_while(stream, condition, body, session, stdin, cs)

    # ── case ────────────────────────────────────
    if kind == NodeKind.CASE:
        word_node = get_case_word(node)
        word = await expand_node(word_node, session, execute_fn, cs, view=view)
        case_items = []
        for pattern_nodes, body, terminator in get_case_items(node):
            patterns = [
                await expand_pattern(p, session, execute_fn, cs, view=view)
                for p in pattern_nodes
            ]
            case_items.append((patterns, body, terminator))
        return await handle_case(stream, word, case_items, session, stdin, cs)

    # ── function definition ─────────────────────
    if kind == NodeKind.FUNCTION_DEF:
        name = get_function_name(node)
        if name in session.readonly_functions:
            # `readonly -f f` froze the body: either definition syntax
            # refuses with `f: readonly function`, exit 1, and the old
            # body stays, pinned on 5.2.37.
            err = f"bash: {name}: readonly function\n".encode()
            return None, IOResult(exit_code=1, stderr=err), ExecutionNode(
                command=f"function {name}", exit_code=1, stderr=err)
        func_body = get_function_body(node)
        session.functions[name] = func_body
        return None, IOResult(), ExecutionNode(command=f"function {name}",
                                               exit_code=0)

    # ── declaration (export/local/declare/readonly) ──
    if kind == NodeKind.DECLARATION:
        return await execute_declaration(node, session, execute_fn, registry,
                                         namespace, cs, view)

    # ── unset ───────────────────────────────────
    if kind == NodeKind.UNSET:
        args = get_unset_args(node)
        return await handle_unset(
            args, session, session_view(session, namespace.registry.policies))

    # ── test ([ ] or [[ ]]) ─────────────────────
    if kind == NodeKind.TEST:
        opener = node.children[0].type if node.children else "["
        if opener == "[[":
            tree = await expand_double_bracket(node,
                                               session,
                                               execute_fn,
                                               cs,
                                               view=view)
            return await handle_test(dispatch,
                                     namespace,
                                     tree,
                                     session,
                                     name="[[",
                                     view=view)
        test_argv = await expand_test_expr(node,
                                           session,
                                           execute_fn,
                                           cs,
                                           view=view)
        return await handle_test(dispatch,
                                 namespace,
                                 test_argv,
                                 session,
                                 name="[",
                                 view=view)

    # ── negated command ─────────────────────────
    if kind == NodeKind.NEGATED:
        inner = get_negated_command(node)
        stdout, io, exec_node = await stream(inner, session, stdin, cs)
        # Lazy exit codes (exit_on_empty in grep) must be final before
        # inverting, or `! grep miss f` negates the provisional 0.
        stdout = await apply_barrier(stdout, io, BarrierPolicy.VALUE)
        # bash reports the negated pipeline's own statuses in
        # PIPESTATUS (`! false` leaves `1`), so what `!` wraps is
        # closed as a statement of its own before `$?` inverts.
        record_status(session,
                      io.exit_code,
                      transparent=pipeline_transparent(inner))
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

    # ── variable assignment at top level ────────
    if kind == NodeKind.VAR_ASSIGN:
        return await execute_assignment(node, session, execute_fn, registry,
                                        namespace, cs)

    # ── assignment-only statement (a=1 b=2) ─────
    if kind == NodeKind.VAR_ASSIGNS:
        sub_seq = session._cmdsub_seq
        merged_io = IOResult()
        for child in node.named_children:
            if child.type != NT.VARIABLE_ASSIGNMENT:
                continue
            _, io, _ = await recurse(child, session, stdin, cs)
            merged_io = await merged_io.merge(io)
        # The statement's status follows the last command substitution
        # performed across ALL its assignments, not the last child's.
        code = assignment_status(session, sub_seq)
        merged_io.exit_code = code
        return None, merged_io, ExecutionNode(command=get_text(node),
                                              exit_code=code)

    # Constructs the parser accepts but the executor cannot honor
    # (tree-sitter ERROR nodes, future grammar additions). Mirrors the
    # unsupported-builtin diagnostic so agents see a capability gap,
    # not a crash.
    err = f"mirage: unsupported shell construct: {node.type}\n".encode()
    return None, IOResult(exit_code=2,
                          stderr=err), ExecutionNode(command=get_text(node),
                                                     exit_code=2,
                                                     stderr=err)

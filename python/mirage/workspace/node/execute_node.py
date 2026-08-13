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
from mirage.policy import PolicyDenied
from mirage.runtime.policy import PolicyDecision
from mirage.runtime.types import DispatchFn
from mirage.shell.arith import evaluate_arith
from mirage.shell.array import (ShellArray, array_append, array_extent,
                                array_get, array_set, make_array)
from mirage.shell.barrier import BarrierPolicy, apply_barrier
from mirage.shell.call_stack import CallStack
from mirage.shell.errors import ArithError, ExitSignal, ReadonlyError
from mirage.shell.job_table import JobTable
from mirage.shell.node_kind import NodeKind, node_kind
from mirage.shell.types import ERREXIT_EXEMPT_TYPES
from mirage.shell.types import NodeType as NT
from mirage.shell.types import Redirect, RedirectKind
from mirage.shell.xtrace import trace_assignment
from mirage.types import word_text
from mirage.workspace.abort import MirageAbortError
from mirage.workspace.executor.control import (handle_case, handle_cfor,
                                               handle_for, handle_if,
                                               handle_select, handle_until,
                                               handle_while)
from mirage.workspace.executor.pipes import (handle_connection, handle_pipe,
                                             handle_subshell)
from mirage.workspace.executor.redirect import handle_redirect
from mirage.workspace.executor.statement import (assignment_status,
                                                 finish_statement)
from mirage.workspace.expand import (expand_and_classify, expand_node,
                                     expand_redirects)
from mirage.workspace.expand.globs import resolve_globs
from mirage.workspace.expand.node import expand_arith
from mirage.workspace.expand.pattern import expand_pattern
from mirage.workspace.expand.variable import _array_index
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.node.command_dispatch import execute_command
from mirage.workspace.node.program import execute_program
from mirage.workspace.node.test_expr import (expand_double_bracket,
                                             expand_test_expr)
from mirage.workspace.session import Session
from mirage.workspace.session.state import (ensure_var_visible, session_view,
                                            visible_env)
from mirage.workspace.types import ExecutionNode

from mirage.shell.helpers import (  # isort: skip
    get_case_items, get_case_word, get_cfor_parts, get_declaration_keyword,
    get_for_parts, get_function_body, get_function_name, get_if_branches,
    get_list_parts, get_negated_command, get_pipeline_commands, get_redirects,
    get_text, get_unset_args, get_while_parts)
from mirage.workspace.executor.builtins import (  # isort: skip
    handle_export, handle_local, handle_readonly, handle_test, handle_unset,
    note_local_array)


async def _assign_var(view: SessionView, key: str,
                      value: str | ShellArray) -> None:
    """One assignment through the session door; denial is fatal.

    Every assignment spelling (scalar, array literal, subscript,
    append) computes its resulting value and stores through
    ``view.set``, so the gate and the storage invariant live in the
    door, not here. Denial mirrors the readonly case: a fatal
    variable-assignment error that abandons the rest of the line.

    Args:
        view (SessionView): the session plane's gated door.
        key (str): the variable being written.
        value (str | ShellArray): the resulting value to store.
    """
    try:
        await view.set(key, value)
    except PolicyDenied as exc:
        err = f"{exc.strerror}\n".encode()
        raise ExitSignal(1, stderr=err, contained_code=1) from exc


async def _eval_cfor_expr(
    expr: Any,
    default: int,
    session: Session,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None,
) -> int:
    """Evaluate one C-style for expression slot.

    Args:
        expr (Any): the slot's tree-sitter expression node, or None
            for an empty slot.
        default (int): value an empty slot yields (1 for the condition
            so `for ((;;))` loops, 0 for init/update).
        session (Session): shell session; arithmetic assignments land
            in its env.
        execute_fn (Callable): recursive execute for substitutions.
        call_stack (CallStack | None): function-call scope, if any.

    Raises:
        ArithError: re-raised with the expression text prepended, so
            the loop can print bash's `((: expr: reason` diagnostic.
        ReadonlyError: the expression assigns to a readonly variable,
            which aborts the loop the same way an invalid expression
            does.
    """
    if expr is None:
        return default
    text = await expand_arith(expr, session, execute_fn, call_stack)
    try:
        # Reads resolve against the visible env so a hidden name counts
        # as unset; a hidden write refuses through the session door
        # (ensure_var_visible), caught by the loop beside ReadonlyError.
        value, updates = evaluate_arith(text, visible_env(session))
    except ArithError as exc:
        raise ArithError(f"{text}: {exc}") from exc
    for name in updates:
        ensure_var_visible(session, name)
        if name in session.readonly_vars:
            raise ReadonlyError(name)
    session.env.update(updates)
    return int(value)


async def _expand_array_items(
    array_node: Any,
    session: Session,
    execute_fn: Callable[..., Any],
    registry: MountRegistry,
    namespace: Namespace,
    cs: CallStack | None,
) -> list[str]:
    """Expand an array literal into its element words.

    Elements behave like any other shell word list: command
    substitutions word-split and globs resolve to matches
    (``a=($(cmd) /data/*.txt)``), with zero-match globs kept literal.

    Args:
        array_node (Any): the tree-sitter ``array`` node.
        session (Session): shell session.
        execute_fn (Callable): workspace execute for substitutions.
        registry (MountRegistry): mount registry for glob resolution.
        namespace (Namespace): addressing authority holding the links.
        cs (CallStack | None): function-call scope, if any.
    """
    values = list(array_node.named_children)
    classified = await expand_and_classify(values, session, execute_fn,
                                           registry, session.cwd, cs)
    resolved = await resolve_globs(classified,
                                   registry,
                                   noglob=bool(
                                       session.shell_options.get("noglob")),
                                   links=namespace)
    return [word_text(w) for w in resolved]


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
    if node is not right:
        return await recurse(node, session, stdin, call_stack)
    expanded, pipe_node = await expand_redirects(redirects, session,
                                                 execute_fn, registry,
                                                 call_stack)
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
    if node not in targets or node_kind(node) != NodeKind.REDIRECT:
        return await recurse(node, session, stdin, call_stack)
    command, redirects = get_redirects(node)
    redirects.append(
        Redirect(fd=2, target=1, kind=RedirectKind.STDERR_TO_STDOUT))
    expanded, pipe_node = await expand_redirects(redirects, session,
                                                 execute_fn, registry,
                                                 call_stack)
    stdout, io, exec_node = await handle_redirect(recurse, dispatch, command,
                                                  expanded, session, stdin,
                                                  call_stack)
    if pipe_node is not None and stdout is not None:
        stdout, io2, exec_node2 = await recurse(pipe_node, session, stdout,
                                                call_stack)
        io = await io.merge(io2)
        exec_node = exec_node2
    return stdout, io, exec_node


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
    routing_decision: PolicyDecision | None = None,
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
    """
    if cancel is not None and cancel.is_set():
        raise MirageAbortError()
    cs = call_stack if call_stack is not None else CallStack()
    session.errexit_immune = False

    recurse = partial(execute_node,
                      dispatch,
                      registry,
                      namespace,
                      job_table,
                      execute_fn,
                      agent_id,
                      cancel=cancel,
                      routing_decision=routing_decision)

    kind = node_kind(node)

    if kind == NodeKind.COMMENT:
        return None, IOResult(), ExecutionNode(command="", exit_code=0)

    # ── program (root / semicolons) ─────────────
    if kind == NodeKind.PROGRAM:
        return await execute_program(recurse, node, session, stdin, cs,
                                     job_table, agent_id)

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
                                     routing_decision=routing_decision)

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
            )
            exec_node.exit_code = io.exit_code
            session.errexit_immune = True
        return stdout, io, exec_node

    # ── list (&&, ||) ───────────────────────────
    if kind == NodeKind.LIST:
        left, op, right = get_list_parts(node)
        return await handle_connection(recurse, left, op, right, session,
                                       stdin, cs)

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
        expanded_redirects, pipe_node = await expand_redirects(
            redirects, session, execute_fn, registry, cs)
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
                              routing_decision=routing_decision)
        return await handle_subshell(sub_recurse, list(node.children), session,
                                     stdin, cs, sub_table, agent_id)

    # ── arithmetic command ((( ... ))) ──────────
    if (kind == NodeKind.COMPOUND and node.children
            and node.children[0].type == NT.ARITH_OPEN):
        text = get_text(node)
        expr = await expand_arith(node, session, execute_fn, cs)
        try:
            # Reads resolve against the visible env so a hidden name
            # counts as unset; a hidden write refuses below, in this
            # command's own voice like the readonly refusal.
            value, updates = evaluate_arith(expr, visible_env(session))
        except ArithError as exc:
            err = f"bash: ((: {expr}: {exc}\n".encode()
            return None, IOResult(exit_code=1,
                                  stderr=err), ExecutionNode(command=text,
                                                             exit_code=1,
                                                             stderr=err)
        for name in updates:
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
        session.env.update(updates)
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
            stdout, io, last_exec = await recurse(child, session, stdin, cs)
            stdout = await finish_statement(stdout, io, session)
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
        return await handle_if(recurse, branches, else_body, session, stdin,
                               cs)

    # ── C-style for (for ((init;cond;update))) ──
    if kind == NodeKind.CFOR:
        exprs, body = get_cfor_parts(node)
        eval_expr = partial(_eval_cfor_expr,
                            session=session,
                            execute_fn=execute_fn,
                            call_stack=cs)
        return await handle_cfor(recurse, exprs, body, eval_expr, session,
                                 stdin, cs)

    # ── for / select ────────────────────────────
    if kind in (NodeKind.FOR, NodeKind.SELECT):
        var, values, body = get_for_parts(node)
        classified = await expand_and_classify(values, session, execute_fn,
                                               registry, session.cwd, cs)
        # The loop word list is consumed by the shell (WordPolicy.SHELL):
        # globs resolve to matches before iteration starts.
        classified = await resolve_globs(
            classified,
            registry,
            noglob=bool(session.shell_options.get("noglob")),
            links=namespace)
        if kind == NodeKind.SELECT:
            return await handle_select(recurse,
                                       var,
                                       classified,
                                       body,
                                       session,
                                       stdin,
                                       cs,
                                       policies=namespace.registry.policies)
        return await handle_for(recurse,
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
            return await handle_until(recurse, condition, body, session, stdin,
                                      cs)
        return await handle_while(recurse, condition, body, session, stdin, cs)

    # ── case ────────────────────────────────────
    if kind == NodeKind.CASE:
        word_node = get_case_word(node)
        word = await expand_node(word_node, session, execute_fn, cs)
        case_items = []
        for pattern_nodes, body, terminator in get_case_items(node):
            patterns = [
                await expand_pattern(p, session, execute_fn, cs)
                for p in pattern_nodes
            ]
            case_items.append((patterns, body, terminator))
        return await handle_case(recurse, word, case_items, session, stdin, cs)

    # ── function definition ─────────────────────
    if kind == NodeKind.FUNCTION_DEF:
        name = get_function_name(node)
        func_body = get_function_body(node)
        session.functions[name] = func_body
        return None, IOResult(), ExecutionNode(command=f"function {name}",
                                               exit_code=0)

    # ── declaration (export/local/declare/readonly) ──
    if kind == NodeKind.DECLARATION:
        keyword = get_declaration_keyword(node)
        assignments = []
        # Array literals are staged, not stored: `readonly -a a=(y)` on an
        # already-readonly name has to fail with the old value intact.
        staged: list[tuple[str, bool, list[str]]] = []
        # Option words are kept verbatim, in order, so `--` survives as an
        # end-of-options marker and the handlers can name the *first* bad
        # option letter the way bash does.
        flag_words: list[str] = []
        flag_chars: set[str] = set()
        opts_done = False
        for child in node.named_children:
            if child.type == NT.VARIABLE_ASSIGNMENT:
                val_nodes = [
                    c for c in child.named_children
                    if c.type != NT.VARIABLE_NAME
                ]
                if val_nodes and val_nodes[0].type == NT.ARRAY:
                    key = get_text(child).partition("=")[0]
                    items = await _expand_array_items(val_nodes[0], session,
                                                      execute_fn, registry,
                                                      namespace, cs)
                    staged.append(
                        (key.removesuffix("+"), key.endswith("+"), items))
                    continue
                expanded = await expand_node(child, session, execute_fn, cs)
                assignments.append(expanded)
            elif child.type in (NT.SIMPLE_EXPANSION, NT.EXPANSION,
                                NT.CONCATENATION, NT.WORD, NT.VARIABLE_NAME,
                                NT.STRING, NT.RAW_STRING, NT.ANSI_C_STRING,
                                NT.TRANSLATED_STRING):
                # A bare `readonly NAME` / `export NAME` operand parses as
                # a variable_name, not a word, and a quoted assignment
                # (`export 'FOO=bar'`) as a plain string operand.
                expanded = await expand_node(child, session, execute_fn, cs)
                if not expanded:
                    continue
                if (not opts_done and expanded.startswith("-")
                        and len(expanded) > 1):
                    flag_words.append(expanded)
                    if expanded == "--":
                        opts_done = True
                    else:
                        flag_chars.update(expanded[1:])
                else:
                    assignments.append(expanded)
        is_readonly = keyword == "readonly" or "r" in flag_chars
        if "a" in flag_chars:
            # `declare -a NAME` with no value declares an empty array, so
            # ${#NAME[@]} is 0 and NAME[3]=x leaves index 0 unassigned.
            for bare in assignments:
                if "=" in bare:
                    continue
                # Both branches below write array storage raw (the
                # top-level one migrates an existing scalar into
                # element 0), so a hidden name refuses like any
                # assignment spelling before either lands.
                try:
                    ensure_var_visible(session, bare)
                except PolicyDenied as exc:
                    err = f"{exc.strerror}\n".encode()
                    raise ExitSignal(1, stderr=err, contained_code=1) from exc
                if note_local_array(session, bare):
                    # Inside a function this shadows whatever the caller
                    # had with a fresh empty array.
                    session.arrays[bare] = []
                elif bare not in session.arrays:
                    # At top level an existing scalar becomes element 0.
                    scalar = session.env.pop(bare, None)
                    session.arrays[bare] = [] if scalar is None else [scalar]
        # Array literals travel as data: the handler stores them through
        # the session door and owns both refusal voices, so the executor
        # only expands and stages.
        if is_readonly:
            # Only the `readonly` keyword owns -p / illegal-option
            # handling; `declare -r` keeps names only.
            if keyword == "readonly":
                return await handle_readonly(flag_words + assignments,
                                             session,
                                             session_view(
                                                 session,
                                                 namespace.registry.policies),
                                             arrays=staged)
            return await handle_readonly(assignments,
                                         session,
                                         session_view(
                                             session,
                                             namespace.registry.policies),
                                         arrays=staged)
        # declare/typeset scope like `local` inside a function (bash
        # semantics) and assign globally at top level, which is exactly
        # handle_local's fallback when no function scope is active.
        if keyword in (NT.LOCAL, "declare", "typeset"):
            return await handle_local(
                assignments,
                session,
                session_view(session, namespace.registry.policies),
                arrays=staged)
        # Pass export flags through so -p / bare print and bad options work.
        return await handle_export(flag_words + assignments,
                                   session,
                                   session_view(session,
                                                namespace.registry.policies),
                                   arrays=staged)

    # ── unset ───────────────────────────────────
    if kind == NodeKind.UNSET:
        args = get_unset_args(node)
        return await handle_unset(
            args, session, session_view(session, namespace.registry.policies))

    # ── test ([ ] or [[ ]]) ─────────────────────
    if kind == NodeKind.TEST:
        opener = node.children[0].type if node.children else "["
        if opener == "[[":
            tree = await expand_double_bracket(node, session, execute_fn, cs)
            return await handle_test(dispatch,
                                     namespace,
                                     tree,
                                     session,
                                     name="[[")
        test_argv = await expand_test_expr(node, session, execute_fn, cs)
        return await handle_test(dispatch,
                                 namespace,
                                 test_argv,
                                 session,
                                 name="[")

    # ── negated command ─────────────────────────
    if kind == NodeKind.NEGATED:
        inner = get_negated_command(node)
        stdout, io, exec_node = await recurse(inner, session, stdin, cs)
        # Lazy exit codes (exit_on_empty in grep) must be final before
        # inverting, or `! grep miss f` negates the provisional 0.
        stdout = await apply_barrier(stdout, io, BarrierPolicy.VALUE)
        io = IOResult(
            exit_code=0 if io.exit_code != 0 else 1,
            stderr=io.stderr,
            reads=io.reads,
            writes=io.writes,
            cache=io.cache,
        )
        exec_node.exit_code = io.exit_code
        session.errexit_immune = True
        return stdout, io, exec_node

    # ── variable assignment at top level ────────
    if kind == NodeKind.VAR_ASSIGN:
        text = get_text(node)
        if "=" not in text:
            return None, IOResult(), ExecutionNode(command=text, exit_code=0)
        sub_seq = session._cmdsub_seq
        subscript_node = next(
            (c for c in node.named_children if c.type == "subscript"), None)
        name_source = subscript_node if subscript_node is not None else node
        name_node = next((c for c in name_source.named_children
                          if c.type == NT.VARIABLE_NAME), None)
        key = (get_text(name_node)
               if name_node is not None else text.partition("=")[0])
        append = any(c.type == "+=" for c in node.children)
        if key in session.readonly_vars:
            # A bare assignment to a readonly variable is a fatal
            # variable-assignment error in non-interactive bash: the
            # rest of the line is abandoned (builtins like `export`
            # merely fail with 1 and continue).
            err = f"bash: {key}: readonly variable\n".encode()
            raise ExitSignal(1, stderr=err, contained_code=1)
        val_nodes = [
            c for c in node.named_children
            if c.type not in (NT.VARIABLE_NAME, "subscript")
        ]
        # Every branch below computes its resulting value with bash's
        # own mechanics on a copy, then stores through the one session
        # door, which owns the gate and the scalar/array invariant.
        view = session_view(session, namespace.registry.policies)
        if val_nodes and val_nodes[0].type == NT.ARRAY:
            items = await _expand_array_items(val_nodes[0], session,
                                              execute_fn, registry, namespace,
                                              cs)
            if append:
                base = session.arrays.get(key)
                if base is None:
                    scalar = session.env.get(key)
                    base = [] if scalar is None else [scalar]
                else:
                    base = list(base)
                # `arr+=(...)` starts at the extent, so it fills the hole
                # a trailing `unset arr[last]` left but skips interior ones.
                array_append(base, items)
            else:
                base = make_array(items)
            await _assign_var(view, key, base)
            code = assignment_status(session, sub_seq)
            return None, IOResult(exit_code=code), ExecutionNode(
                command=text, exit_code=code)
        if val_nodes:
            val = await expand_node(val_nodes[0], session, execute_fn, cs)
        else:
            val = text.partition("=")[2]
        if subscript_node is not None:
            idx_text = ""
            for sc in subscript_node.named_children:
                if sc.type != NT.VARIABLE_NAME:
                    idx_text = get_text(sc)
                    break
            arr = session.arrays.get(key)
            if arr is None:
                scalar = session.env.get(key)
                arr = [] if scalar is None else [scalar]
            else:
                arr = list(arr)
            idx = _array_index(idx_text, visible_env(session))
            if idx < 0:
                idx += array_extent(arr)
            if idx < 0:
                # bash aborts the whole line on a bad assignment
                # subscript (status 1); containment mirrors ${var:?}.
                name_text = text.partition("=")[0].removesuffix("+")
                raise ExitSignal(1,
                                 stderr=(f"bash: {name_text}: "
                                         "bad array subscript\n").encode(),
                                 contained_code=1)
            array_set(arr, idx, array_get(arr, idx) + val if append else val)
            await _assign_var(view, key, arr)
            code = assignment_status(session, sub_seq)
            return None, IOResult(exit_code=code), ExecutionNode(
                command=text, exit_code=code)
        arr = session.arrays.get(key) if append else None
        if append and arr is not None:
            # `arr+=x` appends to element 0.
            new_arr = list(arr)
            array_set(new_arr, 0, array_get(new_arr, 0) + val)
            await _assign_var(view, key, new_arr)
        else:
            new_val = session.env.get(key, "") + val if append else val
            await _assign_var(view, key, new_val)
        # Reassigning OPTIND (even to its current value) restarts the
        # getopts scan, matching bash's internal char pointer.
        if key == "OPTIND":
            session._getopts_optind = None
        code = assignment_status(session, sub_seq)
        io = IOResult(exit_code=code)
        if session.shell_options.get("xtrace"):
            io.stderr = trace_assignment(key, val, append)
        return None, io, ExecutionNode(command=text, exit_code=code)

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

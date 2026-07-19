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
from mirage.runtime.route import RoutingDecision
from mirage.shell.arith import evaluate_arith
from mirage.shell.call_stack import CallStack
from mirage.shell.errors import ArithError, ExitSignal
from mirage.shell.job_table import JobTable
from mirage.shell.node_kind import NodeKind, node_kind
from mirage.shell.types import ERREXIT_EXEMPT_TYPES
from mirage.shell.types import NodeType as NT
from mirage.types import word_text
from mirage.workspace.abort import MirageAbortError
from mirage.workspace.executor.control import (handle_case, handle_for,
                                               handle_if, handle_select,
                                               handle_until, handle_while)
from mirage.workspace.executor.pipes import (handle_connection, handle_pipe,
                                             handle_subshell)
from mirage.workspace.executor.redirect import handle_redirect
from mirage.workspace.expand import (expand_and_classify, expand_node,
                                     expand_redirects)
from mirage.workspace.expand.globs import resolve_globs
from mirage.workspace.expand.node import expand_arith
from mirage.workspace.expand.variable import _array_index
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.node.command_dispatch import execute_command
from mirage.workspace.node.program import execute_program
from mirage.workspace.node.test_expr import expand_test_expr
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode

from mirage.shell.helpers import (  # isort: skip
    get_case_items, get_case_word, get_declaration_keyword, get_for_parts,
    get_function_body, get_function_name, get_if_branches, get_list_parts,
    get_negated_command, get_pipeline_commands, get_redirects,
    get_subshell_body, get_text, get_unset_names, get_while_parts)
from mirage.workspace.executor.builtins import (  # isort: skip
    handle_export, handle_local, handle_readonly, handle_test, handle_unset)


async def _expand_array_items(
    array_node: Any,
    session: Session,
    execute_fn: Callable[..., Any],
    registry: MountRegistry,
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
        cs (CallStack | None): function-call scope, if any.
    """
    values = list(array_node.named_children)
    classified = await expand_and_classify(values, session, execute_fn,
                                           registry, session.cwd, cs)
    resolved = await resolve_globs(classified, registry)
    return [word_text(w) for w in resolved]


async def _recurse_reassociated(
    recurse: Callable[..., Any],
    dispatch: Callable[..., Any],
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
        dispatch (Callable): VFS op dispatcher.
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


async def execute_node(
    dispatch: Callable[..., Any],
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
    routing_decision: RoutingDecision | None = None,
) -> tuple[Any, IOResult, ExecutionNode]:
    """Walk tree-sitter AST and dispatch each node.

    Args:
        dispatch (Callable): VFS op dispatcher (op, path, **kw).
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
        return await handle_pipe(recurse, commands, stderr_flags, session,
                                 stdin, cs)

    # ── list (&&, ||) ───────────────────────────
    if kind == NodeKind.LIST:
        left, op, right = get_list_parts(node)
        return await handle_connection(recurse, left, op, right, session,
                                       stdin, cs)

    # ── redirected statement ────────────────────
    if kind == NodeKind.REDIRECT:
        command, redirects = get_redirects(node)
        if command.type == NT.LIST:
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
        body = get_subshell_body(node)
        return await handle_subshell(recurse, body, session, stdin, cs)

    # ── arithmetic command ((( ... ))) ──────────
    if (kind == NodeKind.COMPOUND and node.children
            and node.children[0].type == NT.ARITH_OPEN):
        text = get_text(node)
        expr = await expand_arith(node, session, execute_fn, cs)
        try:
            value, updates = evaluate_arith(expr, session.env)
        except ArithError as exc:
            err = f"bash: ((: {expr}: {exc}\n".encode()
            return None, IOResult(exit_code=1,
                                  stderr=err), ExecutionNode(command=text,
                                                             exit_code=1,
                                                             stderr=err)
        for name in updates:
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
            if stdout is not None:
                all_stdout.append(stdout)
            merged_io = await merged_io.merge(io)
            if (io.exit_code != 0 and session.shell_options.get("errexit")
                    and child.type not in ERREXIT_EXEMPT_TYPES):
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

    # ── for / select ────────────────────────────
    if kind in (NodeKind.FOR, NodeKind.SELECT):
        var, values, body = get_for_parts(node)
        classified = await expand_and_classify(values, session, execute_fn,
                                               registry, session.cwd, cs)
        # The loop word list is consumed by the shell (WordPolicy.SHELL):
        # globs resolve to matches before iteration starts.
        classified = await resolve_globs(classified, registry)
        if kind == NodeKind.SELECT:
            return await handle_select(recurse, var, classified, body, session,
                                       stdin, cs)
        return await handle_for(recurse, var, classified, body, session, stdin,
                                cs)

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
        case_items = get_case_items(node)
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
        flag_chars: set[str] = set()
        for child in node.named_children:
            if child.type == NT.VARIABLE_ASSIGNMENT:
                val_nodes = [
                    c for c in child.named_children
                    if c.type != NT.VARIABLE_NAME
                ]
                if val_nodes and val_nodes[0].type == NT.ARRAY:
                    key = get_text(child).partition("=")[0]
                    session.arrays[key] = await _expand_array_items(
                        val_nodes[0], session, execute_fn, registry, cs)
                    continue
                expanded = await expand_node(child, session, execute_fn, cs)
                assignments.append(expanded)
            elif child.type in (NT.SIMPLE_EXPANSION, NT.EXPANSION,
                                NT.CONCATENATION, NT.WORD):
                expanded = await expand_node(child, session, execute_fn, cs)
                if not expanded:
                    continue
                if expanded.startswith("-") and len(expanded) > 1:
                    flag_chars.update(expanded[1:])
                else:
                    assignments.append(expanded)
        if keyword == NT.LOCAL:
            return await handle_local(assignments, session)
        if keyword == "readonly" or "r" in flag_chars:
            return await handle_readonly(assignments, session)
        return await handle_export(assignments, session)

    # ── unset ───────────────────────────────────
    if kind == NodeKind.UNSET:
        names = get_unset_names(node)
        return await handle_unset(names, session)

    # ── test ([ ] or [[ ]]) ─────────────────────
    if kind == NodeKind.TEST:
        expanded = await expand_test_expr(node, session, execute_fn, cs,
                                          registry)
        return await handle_test(dispatch, expanded, session)

    # ── negated command ─────────────────────────
    if kind == NodeKind.NEGATED:
        inner = get_negated_command(node)
        stdout, io, exec_node = await recurse(inner, session, stdin, cs)
        io = IOResult(
            exit_code=0 if io.exit_code != 0 else 1,
            stderr=io.stderr,
            reads=io.reads,
            writes=io.writes,
            cache=io.cache,
        )
        exec_node.exit_code = io.exit_code
        return stdout, io, exec_node

    # ── variable assignment at top level ────────
    if kind == NodeKind.VAR_ASSIGN:
        text = get_text(node)
        if "=" not in text:
            return None, IOResult(), ExecutionNode(command=text, exit_code=0)
        subscript_node = next(
            (c for c in node.named_children if c.type == "subscript"), None)
        name_source = subscript_node if subscript_node is not None else node
        name_node = next((c for c in name_source.named_children
                          if c.type == NT.VARIABLE_NAME), None)
        key = (get_text(name_node)
               if name_node is not None else text.partition("=")[0])
        append = any(c.type == "+=" for c in node.children)
        if key in session.readonly_vars:
            err = f"bash: {key}: readonly variable\n".encode()
            return None, IOResult(exit_code=1,
                                  stderr=err), ExecutionNode(command=text,
                                                             exit_code=1,
                                                             stderr=err)
        val_nodes = [
            c for c in node.named_children
            if c.type not in (NT.VARIABLE_NAME, "subscript")
        ]
        if val_nodes and val_nodes[0].type == NT.ARRAY:
            items = await _expand_array_items(val_nodes[0], session,
                                              execute_fn, registry, cs)
            if append:
                base = session.arrays.get(key)
                if base is None:
                    scalar = session.env.pop(key, None)
                    base = [scalar] if scalar else []
                session.arrays[key] = base + items
            else:
                session.arrays[key] = items
                session.env.pop(key, None)
            return None, IOResult(), ExecutionNode(command=text, exit_code=0)
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
                scalar = session.env.pop(key, None)
                arr = [scalar] if scalar else []
            idx = _array_index(idx_text, session.env)
            if idx < 0:
                idx += len(arr)
            if idx < 0:
                # bash aborts the whole line on a bad assignment
                # subscript (status 1); containment mirrors ${var:?}.
                name_text = text.partition("=")[0].removesuffix("+")
                raise ExitSignal(1,
                                 stderr=(f"bash: {name_text}: "
                                         "bad array subscript\n").encode(),
                                 contained_code=1)
            while len(arr) <= idx:
                arr.append("")
            arr[idx] = arr[idx] + val if append else val
            session.arrays[key] = arr
            return None, IOResult(), ExecutionNode(command=text, exit_code=0)
        if append:
            arr = session.arrays.get(key)
            if arr:
                arr[0] = arr[0] + val
            elif arr is not None:
                arr.append(val)
            else:
                session.env[key] = session.env.get(key, "") + val
        else:
            session.env[key] = val
            session.arrays.pop(key, None)
        return None, IOResult(), ExecutionNode(command=text, exit_code=0)

    # Constructs the parser accepts but the executor cannot honor (e.g.
    # C-style `for ((;;))`). Mirrors the unsupported-builtin diagnostic
    # so agents see a capability gap, not a crash.
    err = f"mirage: unsupported shell construct: {node.type}\n".encode()
    return None, IOResult(exit_code=2,
                          stderr=err), ExecutionNode(command=get_text(node),
                                                     exit_code=2,
                                                     stderr=err)

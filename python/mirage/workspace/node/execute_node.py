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

from mirage.commands.spec.types import CommandSpec, OperandKind
from mirage.io import IOResult
from mirage.io.stream import async_chain, materialize
from mirage.shell.call_stack import CallStack
from mirage.shell.job_table import JobTable
from mirage.shell.types import ERREXIT_EXEMPT_TYPES
from mirage.shell.types import NodeType as NT
from mirage.shell.types import Redirect, RedirectKind
from mirage.shell.types import ShellBuiltin as SB
from mirage.types import PathSpec
from mirage.workspace.abort import MirageAbortError
from mirage.workspace.executor.command import handle_command
from mirage.workspace.executor.control import (BreakSignal, ContinueSignal,
                                               handle_case, handle_for,
                                               handle_if, handle_select,
                                               handle_until, handle_while)
from mirage.workspace.executor.jobs import handle_background
from mirage.workspace.executor.pipes import (handle_connection, handle_pipe,
                                             handle_subshell)
from mirage.workspace.executor.redirect import handle_redirect
from mirage.workspace.expand import (classify_parts, classify_word,
                                     expand_and_classify, expand_node,
                                     expand_parts)
from mirage.workspace.expand.classify import classify_bare_path
from mirage.workspace.mount import MountRegistry
from mirage.workspace.node.resolve_globs import resolve_globs
from mirage.workspace.node.test_expr import expand_test_expr
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode

from mirage.shell.helpers import (  # isort: skip
    ProcessSubDirection, get_case_items, get_case_word, get_command_name,
    get_declaration_keyword, get_for_parts, get_function_body,
    get_function_name, get_if_branches, get_list_parts, get_negated_command,
    get_parts, get_pipeline_commands, get_process_sub_direction, get_redirects,
    get_subshell_body, get_text, get_unset_names, get_while_parts)
from mirage.workspace.executor.builtins import (  # isort: skip
    handle_bash, handle_cd, handle_echo, handle_eval, handle_export,
    handle_local, handle_man, handle_printenv, handle_printf, handle_read,
    handle_readonly, handle_return, handle_set, handle_shift, handle_sleep,
    handle_source, handle_test, handle_trap, handle_unset, handle_whoami)

_UNSUPPORTED_BUILTINS = frozenset({
    "bg",
    "disown",
    "exec",
    "complete",
    "compgen",
    "ulimit",
})


async def execute_node(
    dispatch: Callable,
    registry: MountRegistry,
    job_table: JobTable,
    execute_fn: Callable,
    agent_id: str,
    node: Any,
    session: Session,
    stdin: Any = None,
    call_stack: CallStack | None = None,
    history: object = None,
    cancel: asyncio.Event | None = None,
) -> tuple[Any, IOResult, ExecutionNode]:
    """Walk tree-sitter AST and dispatch each node.

    Args:
        dispatch (Callable): VFS op dispatcher (op, path, **kw).
        registry (MountRegistry): mount registry for path resolution.
        job_table (JobTable): background job management.
        execute_fn (Callable): recursive execute (for source/eval).
        agent_id (str): current agent ID for jobs.
        node (Any): tree-sitter node to execute.
        session (Session): shell session state.
        stdin (Any): input stream.
        call_stack (CallStack): shell call stack.
        history (object): execution history sink.
        cancel (asyncio.Event | None): event used to abort mid-flight.
    """
    if cancel is not None and cancel.is_set():
        raise MirageAbortError()
    cs = call_stack or CallStack()

    recurse = partial(execute_node,
                      dispatch,
                      registry,
                      job_table,
                      execute_fn,
                      agent_id,
                      history=history,
                      cancel=cancel)

    ntype = node.type

    if ntype == NT.COMMENT:
        return None, IOResult(), ExecutionNode(command="", exit_code=0)

    # ── program (root / semicolons) ─────────────
    if ntype == NT.PROGRAM:
        return await _execute_program(recurse, node, session, stdin, cs,
                                      job_table, agent_id)

    # ── command ─────────────────────────────────
    if ntype == NT.COMMAND:
        return await _execute_command(recurse,
                                      dispatch,
                                      registry,
                                      execute_fn,
                                      node,
                                      session,
                                      stdin,
                                      cs,
                                      job_table,
                                      history=history,
                                      cancel=cancel)

    # ── pipeline ────────────────────────────────
    if ntype == NT.PIPELINE:
        commands, stderr_flags = get_pipeline_commands(node)
        return await handle_pipe(recurse, commands, stderr_flags, session,
                                 stdin, cs)

    # ── list (&&, ||) ───────────────────────────
    if ntype == NT.LIST:
        left, op, right = get_list_parts(node)
        return await handle_connection(recurse, left, op, right, session,
                                       stdin, cs)

    # ── redirected statement ────────────────────
    if ntype == NT.REDIRECTED_STATEMENT:
        command, redirects = get_redirects(node)
        expanded_redirects = []
        for r in redirects:
            if r.kind in (RedirectKind.HEREDOC, RedirectKind.HERESTRING):
                body = r.target
                if isinstance(body, str) and r.expand_vars:
                    for var, val in session.env.items():
                        body = body.replace("$" + var, val)
                expanded_redirects.append(
                    Redirect(fd=r.fd,
                             target=body,
                             target_node=r.target_node,
                             kind=r.kind,
                             append=r.append,
                             pipeline=r.pipeline,
                             expand_vars=r.expand_vars))
                continue
            if isinstance(r.target, int):
                expanded_redirects.append(r)
                continue
            target_node = r.target_node
            if target_node is not None:
                target_str = await expand_node(target_node, session,
                                               execute_fn, cs)
                target_scope = classify_word(target_str, registry, session.cwd)
            else:
                target_scope = r.target
            expanded_redirects.append(
                Redirect(fd=r.fd,
                         target=target_scope,
                         target_node=r.target_node,
                         kind=r.kind,
                         append=r.append,
                         pipeline=r.pipeline))
        pipe_node = None
        for r in expanded_redirects:
            if r.pipeline is not None:
                pipe_node = r.pipeline
                r.pipeline = None
                break
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
    if ntype == NT.SUBSHELL:
        body = get_subshell_body(node)
        return await handle_subshell(recurse, body, session, stdin, cs)

    # ── compound statement ({ ... }) ───────────
    if ntype == NT.COMPOUND_STATEMENT:
        all_stdout: list = []
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
    if ntype == NT.IF_STATEMENT:
        branches, else_body = get_if_branches(node)
        return await handle_if(recurse, branches, else_body, session, stdin,
                               cs)

    # ── for / select ────────────────────────────
    if ntype == NT.FOR_STATEMENT:
        var, values, body = get_for_parts(node)
        classified = await expand_and_classify(values, session, execute_fn,
                                               registry, session.cwd, cs)
        classified = await resolve_globs(classified, registry)
        if node.children[0].type == NT.SELECT:
            return await handle_select(recurse, var, classified, body, session,
                                       stdin, cs)
        return await handle_for(recurse, var, classified, body, session, stdin,
                                cs)

    # ── while / until ───────────────────────────
    if ntype == NT.WHILE_STATEMENT:
        condition, body = get_while_parts(node)
        if node.children[0].type == NT.UNTIL:
            return await handle_until(recurse, condition, body, session, stdin,
                                      cs)
        return await handle_while(recurse, condition, body, session, stdin, cs)

    # ── case ────────────────────────────────────
    if ntype == NT.CASE_STATEMENT:
        word_node = get_case_word(node)
        word = await expand_node(word_node, session, execute_fn, cs)
        items = get_case_items(node)
        return await handle_case(recurse, word, items, session, stdin, cs)

    # ── function definition ─────────────────────
    if ntype == NT.FUNCTION_DEFINITION:
        name = get_function_name(node)
        body = get_function_body(node)
        session.functions[name] = body
        return None, IOResult(), ExecutionNode(command=f"function {name}",
                                               exit_code=0)

    # ── declaration (export/local/declare/readonly) ──
    if ntype == NT.DECLARATION_COMMAND:
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
                    items = [
                        await expand_node(ac, session, execute_fn, cs)
                        for ac in val_nodes[0].named_children
                    ]
                    session.arrays[key] = items
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
    if ntype == NT.UNSET_COMMAND:
        names = get_unset_names(node)
        return await handle_unset(names, session)

    # ── test ([ ] or [[ ]]) ─────────────────────
    if ntype == NT.TEST_COMMAND:
        expanded = await expand_test_expr(node, session, execute_fn, cs,
                                          registry)
        return await handle_test(dispatch, expanded, session)

    # ── negated command ─────────────────────────
    if ntype == NT.NEGATED_COMMAND:
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
    if ntype == NT.VARIABLE_ASSIGNMENT:
        text = get_text(node)
        if "=" in text:
            key, _, val = text.partition("=")
            if key in session.readonly_vars:
                err = f"bash: {key}: readonly variable\n".encode()
                return None, IOResult(exit_code=1,
                                      stderr=err), ExecutionNode(command=text,
                                                                 exit_code=1,
                                                                 stderr=err)
            val_nodes = [
                c for c in node.named_children if c.type != NT.VARIABLE_NAME
            ]
            if val_nodes and val_nodes[0].type == NT.ARRAY:
                items = []
                for ac in val_nodes[0].named_children:
                    items.append(await expand_node(ac, session, execute_fn,
                                                   cs))
                session.arrays[key] = items
                session.env.pop(key, None)
                return None, IOResult(), ExecutionNode(command=text,
                                                       exit_code=0)
            if val_nodes:
                val = await expand_node(val_nodes[0], session, execute_fn, cs)
            session.env[key] = val
            session.arrays.pop(key, None)
        return None, IOResult(), ExecutionNode(command=text, exit_code=0)

    raise TypeError(f"unsupported tree-sitter node type: {ntype}")


def _classify_argv_by_spec(
    spec: CommandSpec,
    argv: list[str],
) -> tuple[set[str], set[str]]:
    """Classify argv into TEXT and PATH sets using a CommandSpec.

    Strips flags from argv, then assigns kinds based on
    spec.positional and spec.rest. Flag values with TEXT kind
    are also added to the text set. Returns (text_args, path_args)
    with the original (unresolved) arg values.

    Examples:
        cat file.txt           → text={}, path={"file.txt"}
        grep pattern file.txt  → text={"pattern"}, path={"file.txt"}
        find /data -name *.txt → text={"*.txt"}, path={"/data"}
        echo hello world       → text={"hello", "world"}, path={}

    Args:
        spec (CommandSpec): command specification with flags/positional/rest.
        argv (list[str]): command arguments (without command name).
    """
    bool_flags: set[str] = set()
    value_flags: set[str] = set()
    value_flag_kinds: dict[str, OperandKind] = {}
    long_bool_flags: set[str] = set()
    long_value_flags: set[str] = set()
    for opt in spec.options:
        if opt.short:
            if opt.value_kind == OperandKind.NONE:
                bool_flags.add(opt.short)
            else:
                value_flags.add(opt.short)
                value_flag_kinds[opt.short] = opt.value_kind
        if opt.long:
            if opt.value_kind == OperandKind.NONE:
                long_bool_flags.add(opt.long)
            else:
                long_value_flags.add(opt.long)
                value_flag_kinds[opt.long] = opt.value_kind

    positional = tuple(op.kind for op in spec.positional)
    rest_kind = spec.rest.kind if spec.rest is not None else None

    raw_args: list[str] = []
    flag_text_values: set[str] = set()
    i = 0
    end_of_flags = False
    while i < len(argv):
        tok = argv[i]
        if tok == "--" and not end_of_flags:
            end_of_flags = True
            i += 1
            continue
        if end_of_flags:
            raw_args.append(tok)
            i += 1
            continue
        if tok in spec.ignore_tokens:
            i += 1
            continue
        if tok.startswith("--"):
            if tok in long_value_flags and i + 1 < len(argv):
                if value_flag_kinds.get(tok) == OperandKind.TEXT:
                    flag_text_values.add(argv[i + 1])
                i += 2
            else:
                if tok not in long_bool_flags:
                    raw_args.append(tok)
                i += 1
            continue
        if tok.startswith("-") and len(tok) > 1:
            matched_value = False
            for vf in value_flags:
                if tok == vf and i + 1 < len(argv):
                    if value_flag_kinds.get(vf) == OperandKind.TEXT:
                        flag_text_values.add(argv[i + 1])
                    i += 2
                    matched_value = True
                    break
                if tok.startswith(vf) and len(tok) > len(vf):
                    if value_flag_kinds.get(vf) == OperandKind.TEXT:
                        flag_text_values.add(tok[len(vf):])
                    i += 1
                    matched_value = True
                    break
            if matched_value:
                continue
            if tok in bool_flags:
                i += 1
                continue
            all_bool = all(f"-{ch}" in bool_flags for ch in tok[1:])
            if all_bool and len(tok) > 1:
                i += 1
                continue
            raw_args.append(tok)
            i += 1
            continue
        raw_args.append(tok)
        i += 1

    text_set: set[str] = set()
    path_set: set[str] = set()
    for j, arg in enumerate(raw_args):
        if j < len(positional):
            kind = positional[j]
        elif rest_kind is not None:
            kind = rest_kind
        else:
            continue
        if kind == OperandKind.TEXT:
            text_set.add(arg)
        elif kind == OperandKind.PATH:
            path_set.add(arg)
    text_set |= flag_text_values
    return text_set, path_set


def _find_assign_node(parent, assign_text):
    """Find the variable_assignment child matching text."""
    for c in parent.named_children:
        if c.type == NT.VARIABLE_ASSIGNMENT and get_text(c) == assign_text:
            return c
    return parent


def _find_test_arg_node(parent, arg_text):
    """Find the named child matching text for test args."""
    for c in parent.named_children:
        if get_text(c) == arg_text:
            return c
    return parent


async def _execute_program(
    recurse,
    node,
    session,
    stdin,
    call_stack,
    job_table,
    agent_id,
) -> tuple[Any, IOResult, ExecutionNode]:
    """Execute program node (root / semicolon-separated)."""
    children = node.children
    all_stdout: list = []
    merged_io = IOResult()
    last_exec = ExecutionNode(command="", exit_code=0)

    i = 0
    while i < len(children):
        child = children[i]

        if (not child.is_named or child.type == NT.ERROR
                or child.type == NT.COMMENT):
            if child.type == NT.SEMI:
                i += 1
                continue
            i += 1
            continue

        # Check for background: named node followed by & token
        is_bg = (i + 1 < len(children)
                 and children[i + 1].type == NT.BACKGROUND)

        if is_bg:
            stdout, io, last_exec = await handle_background(
                recurse, child, None, session, job_table, agent_id, stdin,
                call_stack)
            i += 2
        else:
            stdout, io, last_exec = await recurse(child, session, stdin,
                                                  call_stack)
            # Materialize stdout so lazy exit codes (e.g. from
            # exit_on_empty in grep) are finalized before $? is set.
            stdout = await materialize(stdout)
            io.sync_exit_code()
            session.last_exit_code = io.exit_code
            i += 1

        if stdout is not None:
            all_stdout.append(stdout)
        merged_io = await merged_io.merge(io)

        if (io.exit_code != 0 and session.shell_options.get("errexit")
                and not is_bg and child.type not in ERREXIT_EXEMPT_TYPES):
            merged_io.exit_code = io.exit_code
            break

    if len(all_stdout) == 1:
        return all_stdout[0], merged_io, last_exec
    combined = async_chain(*all_stdout) if all_stdout else None
    return combined, merged_io, last_exec


async def _execute_command(
    recurse,
    dispatch,
    registry,
    execute_fn,
    node,
    session,
    stdin,
    call_stack,
    job_table,
    history: object = None,
    cancel: asyncio.Event | None = None,
) -> tuple[Any, IOResult, ExecutionNode]:
    """Dispatch a command node by name."""
    name = get_command_name(node)
    parts = get_parts(node)

    prefix_assignments: list[tuple[str, str]] = []
    non_prefix_parts = []
    saw_command_name = False
    for p in parts:
        if not saw_command_name and p.type == NT.VARIABLE_ASSIGNMENT:
            atext = get_text(p)
            if "=" in atext:
                key, _, raw_val = atext.partition("=")
                val_nodes = [
                    c for c in p.named_children if c.type != NT.VARIABLE_NAME
                ]
                if val_nodes:
                    v = await expand_node(val_nodes[0], session, execute_fn,
                                          call_stack)
                else:
                    v = raw_val
                prefix_assignments.append((key, v))
            continue
        if p.type == NT.COMMAND_NAME:
            saw_command_name = True
        non_prefix_parts.append(p)
    parts = non_prefix_parts

    for k, _ in prefix_assignments:
        if k in session.readonly_vars:
            err = f"bash: {k}: readonly variable\n".encode()
            return None, IOResult(exit_code=1,
                                  stderr=err), ExecutionNode(command=name or k,
                                                             exit_code=1,
                                                             stderr=err)

    if prefix_assignments and not name:
        for k, v in prefix_assignments:
            session.env[k] = v
        return None, IOResult(), ExecutionNode(command=" ".join(
            f"{k}={v}" for k, v in prefix_assignments),
                                               exit_code=0)

    is_function_call = name in session.functions
    saved_env_overrides: dict[str, str | None] = {}
    for k, v in prefix_assignments:
        if not is_function_call:
            saved_env_overrides[k] = session.env.get(k)
        session.env[k] = v

    try:
        return await _dispatch_command_body(recurse, dispatch, registry,
                                            execute_fn, node, parts, name,
                                            session, stdin, call_stack,
                                            job_table, history, cancel)
    finally:
        for k, prev in saved_env_overrides.items():
            if prev is None:
                session.env.pop(k, None)
            else:
                session.env[k] = prev


async def _dispatch_command_body(
    recurse,
    dispatch,
    registry,
    execute_fn,
    node,
    parts,
    name,
    session,
    stdin,
    call_stack,
    job_table,
    history: object = None,
    cancel: asyncio.Event | None = None,
) -> tuple[Any, IOResult, ExecutionNode]:
    for child in node.named_children:
        if child.type == NT.HERESTRING_REDIRECT:
            for sc in child.named_children:
                content = await expand_node(sc, session, execute_fn,
                                            call_stack)
                stdin = content.encode() + b"\n"
                break

    # Process substitution: <(cmd) feeds inner stdout as stdin.
    # Output direction >(cmd) is unsupported; reject early so the
    # caller sees a capability gap rather than a silent no-op.
    proc_sub_parts = []
    clean_parts = []
    for p in parts:
        if hasattr(p, "type") and p.type == NT.PROCESS_SUBSTITUTION:
            if get_process_sub_direction(p) == ProcessSubDirection.OUTPUT:
                err = b"mirage: unsupported: process substitution >(...)\n"
                return None, IOResult(exit_code=2, stderr=err), ExecutionNode(
                    command=name or "process_sub", exit_code=2, stderr=err)
            inner_cmds = [c for c in p.named_children if c.type == NT.COMMAND]
            if inner_cmds:
                io_ps = await execute_fn(get_text(inner_cmds[0]),
                                         session_id=session.session_id)
                proc_sub_parts.append(io_ps.stdout or b"")
        else:
            clean_parts.append(p)
    if proc_sub_parts and stdin is None:
        stdin = b"".join(proc_sub_parts)
    parts = clean_parts

    # Expand all parts, classify paths, resolve shell-level globs
    expanded = await expand_parts(parts, session, execute_fn, call_stack)

    # Use CommandSpec to decide which args are TEXT (skip classification)
    # and which are PATH (classify even bare filenames like "file.txt").
    text_args: set[str] | None = None
    path_args: set[str] | None = None
    try:
        cwd_mount = registry.mount_for(session.cwd)
    except ValueError:
        cwd_mount = None
    spec = cwd_mount.spec_for(name) if cwd_mount else None
    if spec:
        text_set, path_set = _classify_argv_by_spec(spec, expanded[1:])
        text_args = text_set or None
        path_args = path_set or None

    classified = classify_parts(expanded,
                                registry,
                                session.cwd,
                                text_args=text_args,
                                path_args=path_args)
    # Resolve globs for shell builtins (echo, for, etc.).
    # Mount commands receive classified with unresolved globs so
    # each resource can handle pattern pushdown.
    resolved = await resolve_globs(classified, registry, text_args=text_args)
    expanded = [p.original if isinstance(p, PathSpec) else p for p in resolved]

    # ── unsupported bash builtins ──────────────
    # Constructs the parser accepts but the executor cannot honor.
    # Returning a clear error lets LLMs detect a capability gap instead
    # of treating it as a missing binary or a silent no-op.
    if name in _UNSUPPORTED_BUILTINS:
        err = f"mirage: unsupported builtin: {name}\n".encode()
        return None, IOResult(exit_code=2,
                              stderr=err), ExecutionNode(command=name,
                                                         exit_code=2,
                                                         stderr=err)

    # ── shell builtins ──────────────────────────
    if name == SB.PWD:
        out = (session.cwd + "\n").encode()
        return out, IOResult(), ExecutionNode(command="pwd", exit_code=0)

    if name == SB.CD:
        if len(classified) <= 1:
            path = "/"
        else:
            raw = classified[1]
            raw_str = raw.original if isinstance(raw, PathSpec) else str(raw)
            if raw_str == "~":
                path = "/"
            elif isinstance(raw, PathSpec):
                path = raw
            elif raw_str.startswith("/"):
                path = raw_str
            else:
                path = classify_bare_path(raw_str, registry, session.cwd)
        return await handle_cd(dispatch, registry.is_mount_root, path, session)

    if name == SB.TRUE:
        return None, IOResult(), ExecutionNode(command="true", exit_code=0)

    if name == SB.FALSE:
        return None, IOResult(exit_code=1), ExecutionNode(command="false",
                                                          exit_code=1)

    if name in (SB.SOURCE, SB.DOT):
        path = classified[1] if len(classified) > 1 else ""
        return await handle_source(dispatch, execute_fn, path, session)

    if name == SB.EVAL:
        args = expanded[1:]
        return await handle_eval(execute_fn, args, session)

    if name in (SB.BASH, SB.SH):
        args = expanded[1:]
        return await handle_bash(execute_fn, args, session, stdin)

    if name == SB.EXPORT:
        assignments = expanded[1:]
        return await handle_export(assignments, session)

    if name == SB.UNSET:
        names = expanded[1:]
        return await handle_unset(names, session)

    if name == SB.LOCAL:
        assignments = expanded[1:]
        return await handle_local(assignments, session)

    if name == SB.PRINTENV:
        var_name = expanded[1] if len(expanded) > 1 else None
        return await handle_printenv(var_name, session)

    if name == SB.WHOAMI:
        return await handle_whoami(session)

    if name == SB.MAN:
        return await handle_man(expanded[1:], session, registry)

    if name == SB.READ:
        variables = expanded[1:] if len(expanded) > 1 else ["REPLY"]
        return await handle_read(variables, session, stdin)

    if name == SB.SET:
        args = expanded[1:]
        return await handle_set(args, session, call_stack=call_stack)

    if name == SB.SHIFT:
        n = int(expanded[1]) if len(expanded) > 1 else 1
        return await handle_shift(n, call_stack, session=session)

    if name == SB.TRAP:
        return await handle_trap(session)

    if name == SB.TEST:
        argv = classified[1:]
        return await handle_test(dispatch, argv, session)

    if name in (SB.BRACKET, SB.DOUBLE_BRACKET):
        argv = classified[1:]
        return await handle_test(dispatch, argv, session)

    if name == SB.ECHO:
        args = expanded[1:]
        n_flag = "-n" in args
        e_flag = "-e" in args
        args = [a for a in args if a not in ("-n", "-e")]
        return await handle_echo(args, n_flag=n_flag, e_flag=e_flag)

    if name == SB.PRINTF:
        return await handle_printf(expanded[1:])

    if name == SB.SLEEP:
        return await handle_sleep(expanded[1:], cancel=cancel)

    if name == SB.RETURN:
        exit_code = int(expanded[1]) if len(expanded) > 1 else 0
        return await handle_return(exit_code)

    if name == SB.XARGS:
        stdin_data = await materialize(stdin)
        if stdin_data is None:
            stdin_data = b""
        input_args = stdin_data.decode(errors="replace").split()
        xargs_cmd = expanded[1] if len(expanded) > 1 else "echo"
        inner = xargs_cmd + " " + " ".join(input_args)
        io = await execute_fn(inner, session_id=session.session_id)
        return io.stdout, io, ExecutionNode(command="xargs",
                                            exit_code=io.exit_code)

    if name == SB.TIMEOUT:
        if len(expanded) >= 3:
            inner_cmd = " ".join(expanded[2:])
            io = await execute_fn(inner_cmd, session_id=session.session_id)
            return io.stdout, io, ExecutionNode(command="timeout",
                                                exit_code=io.exit_code)
        return None, IOResult(), ExecutionNode(command="timeout", exit_code=0)

    if name == SB.BREAK:
        raise BreakSignal()

    if name == SB.CONTINUE:
        raise ContinueSignal()

    # ── mount command (default) ─────────────────
    return await handle_command(recurse,
                                dispatch,
                                registry,
                                classified,
                                session,
                                stdin,
                                call_stack,
                                job_table=job_table,
                                history=history)

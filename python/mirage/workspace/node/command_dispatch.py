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
from typing import Any

from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.shell.types import NodeType as NT
from mirage.shell.types import ShellBuiltin as SB
from mirage.types import PathSpec
from mirage.workspace.executor.command import handle_command
from mirage.workspace.executor.control import BreakSignal, ContinueSignal
from mirage.workspace.expand import classify_parts, expand_node, expand_parts
from mirage.workspace.expand.classify import classify_bare_path
from mirage.workspace.node.classify_argv import classify_argv_by_spec
from mirage.workspace.node.resolve_globs import resolve_globs
from mirage.workspace.types import ExecutionNode

from mirage.shell.helpers import (  # isort: skip
    ProcessSubDirection, get_command_name, get_parts,
    get_process_sub_direction, get_text)
from mirage.workspace.executor.builtins import (  # isort: skip
    handle_bash, handle_cd, handle_echo, handle_eval, handle_export,
    handle_local, handle_man, handle_printenv, handle_printf, handle_read,
    handle_return, handle_set, handle_shift, handle_sleep, handle_source,
    handle_test, handle_trap, handle_unset, handle_whoami)

_UNSUPPORTED_BUILTINS = frozenset({
    "bg",
    "disown",
    "exec",
    "complete",
    "compgen",
    "ulimit",
})


async def execute_command(
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
        text_set, path_set = classify_argv_by_spec(spec, expanded[1:])
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

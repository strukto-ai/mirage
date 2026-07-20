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

from mirage.commands.builtin.utils.safeguard import run_with_timeout
from mirage.commands.safeguard import resolve_safeguard
from mirage.io import IOResult
from mirage.io.types import materialize
from mirage.runtime.route import RoutingDecision
from mirage.shell.types import NodeType as NT
from mirage.shell.types import ShellBuiltin as SB
from mirage.shell.xtrace import trace_command
from mirage.types import PathSpec, word_text
from mirage.utils.path import CycleError
from mirage.workspace.executor.command import handle_command
from mirage.workspace.executor.control import BreakSignal, ContinueSignal
from mirage.workspace.expand import expand_node
from mirage.workspace.expand.argv import Argv, expand_argv
from mirage.workspace.expand.classify import classify_bare_path
from mirage.workspace.route import NO_FOLLOW_COMMANDS, UNSUPPORTED_BUILTINS
from mirage.workspace.session.shell_dirs import home_dir
from mirage.workspace.types import ExecutionNode

from mirage.shell.helpers import (  # isort: skip
    ProcessSubDirection, get_command_name, get_parts, get_process_sub_body,
    get_process_sub_direction, get_text, split_env_prefix)
from mirage.workspace.executor.builtins import (  # isort: skip
    follow_paths, handle_bash, handle_cd, handle_chmod, handle_chown,
    handle_echo, handle_eval, handle_exit, handle_export, handle_history,
    handle_ln, handle_local, handle_man, handle_printenv, handle_printf,
    handle_read, handle_readlink, handle_return, handle_set, handle_shift,
    handle_sleep, handle_source, handle_test, handle_timeout, handle_touch,
    handle_trap, handle_unset, handle_whoami, handle_xargs, link_flags,
    prepare_mv, strip_link_operands)

_CdArgs = list[str | PathSpec]


def _loop_levels(args: list[str]) -> int:
    """Parse the optional numeric level of ``break``/``continue``.

    Args:
        args (list[str]): words after the builtin name.
    """
    if args and args[0].isdigit() and int(args[0]) > 0:
        return int(args[0])
    return 1


def _split_cd_options(args: _CdArgs) -> tuple[_CdArgs, str | None, bool]:
    """Split leading ``cd`` option flags from the directory operand.

    Accepts the GNU ``cd`` options ``-L -P -e -@`` (and clusters such as
    ``-LP``) plus a ``--`` end-of-options marker; a bare ``-`` is the
    OLDPWD operand, not an option.

    Args:
        args: The classified arguments after the ``cd`` command name.

    Returns:
        ``(operands, bad, physical)`` where ``operands`` are the non-option
        args, ``bad`` is the first unknown option character (or ``None``),
        and ``physical`` is True when ``-P`` is the effective (last-wins)
        mode.
    """
    operands: _CdArgs = []
    parsing = True
    physical = False
    for arg in args:
        s = arg.virtual if isinstance(arg, PathSpec) else str(arg)
        if parsing:
            if s == "--":
                parsing = False
                continue
            if s != "-" and len(s) >= 2 and s.startswith("-"):
                bad = next((c for c in s[1:] if c not in "LPe@"), None)
                if bad is None:
                    for c in s[1:]:
                        if c == "P":
                            physical = True
                        elif c == "L":
                            physical = False
                    continue
                return operands, bad, physical
            parsing = False
        operands.append(arg)
    return operands, None, physical


async def execute_command(
    recurse,
    dispatch,
    registry,
    namespace,
    execute_fn,
    node,
    session,
    stdin,
    call_stack,
    job_table,
    cancel: asyncio.Event | None = None,
    routing_decision: RoutingDecision | None = None,
) -> tuple[Any, IOResult, ExecutionNode]:
    """Dispatch a command node by name."""
    name = get_command_name(node)
    assignment_nodes, parts = split_env_prefix(get_parts(node))

    prefix_assignments: list[tuple[str, str]] = []
    for p in assignment_nodes:
        atext = get_text(p)
        if "=" not in atext:
            continue
        key, _, raw_val = atext.partition("=")
        val_nodes = [c for c in p.named_children if c.type != NT.VARIABLE_NAME]
        if val_nodes:
            v = await expand_node(val_nodes[0], session, execute_fn,
                                  call_stack)
        else:
            v = raw_val
        prefix_assignments.append((key, v))

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
                                            namespace, execute_fn, node, parts,
                                            name, session, stdin, call_stack,
                                            job_table, cancel,
                                            routing_decision)
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
    namespace,
    execute_fn,
    node,
    parts,
    name,
    session,
    stdin,
    call_stack,
    job_table,
    cancel: asyncio.Event | None = None,
    routing_decision: RoutingDecision | None = None,
) -> tuple[Any, IOResult, ExecutionNode]:
    parent = node.parent
    if parent is None or parent.type != NT.REDIRECTED_STATEMENT:
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
    proc_sub_stderr = []
    clean_parts = []
    for p in parts:
        if hasattr(p, "type") and p.type == NT.PROCESS_SUBSTITUTION:
            if get_process_sub_direction(p) == ProcessSubDirection.OUTPUT:
                err = b"mirage: unsupported: process substitution >(...)\n"
                return None, IOResult(exit_code=2, stderr=err), ExecutionNode(
                    command=name or "process_sub", exit_code=2, stderr=err)
            inner = get_process_sub_body(p)
            if inner:
                io_ps = await execute_fn(inner, session_id=session.session_id)
                proc_sub_parts.append(io_ps.stdout or b"")
                stderr = await materialize(io_ps.stderr)
                if stderr:
                    proc_sub_stderr.append(stderr)
        else:
            clean_parts.append(p)
    if proc_sub_parts and stdin is None:
        stdin = b"".join(proc_sub_parts)
    parts = clean_parts

    argv = await expand_argv(parts, session, execute_fn, call_stack, registry)

    # Safeguards resolve against the expanded name, so `$CMD`-style
    # invocations get their real command's policy.
    resolved = resolve_safeguard(argv.name) if argv.name else None
    timeout = (resolved.timeout_seconds if resolved is not None else None)
    body = _run_argv(recurse, dispatch, registry, namespace, execute_fn, argv,
                     session, stdin, call_stack, job_table, cancel,
                     routing_decision)
    # Capture xtrace before the body runs so `set -x` itself is not
    # traced (bash enables tracing only for the following commands).
    xtrace = bool(session.shell_options.get("xtrace"))
    stdout, io, exec_node = await run_with_timeout(body, timeout, argv.name
                                                   or "?")
    if proc_sub_stderr:
        io.stderr = b"".join(proc_sub_stderr) + await materialize(io.stderr)
        exec_node.stderr = io.stderr
    if xtrace and argv.name:
        existing = await materialize(io.stderr) or b""
        io.stderr = trace_command([argv.name, *argv.args]) + existing
    return stdout, io, exec_node


async def _run_argv(
    recurse,
    dispatch,
    registry,
    namespace,
    execute_fn,
    argv: Argv,
    session,
    stdin,
    call_stack,
    job_table,
    cancel: asyncio.Event | None = None,
    routing_decision: RoutingDecision | None = None,
) -> tuple[Any, IOResult, ExecutionNode]:
    """Route one expanded command to its builtin or mount handler."""
    name = argv.name
    args = list(argv.args)
    operands = list(argv.operands)

    # ── unsupported bash builtins ──────────────
    # Constructs the parser accepts but the executor cannot honor.
    # Returning a clear error lets LLMs detect a capability gap instead
    # of treating it as a missing binary or a silent no-op.
    if name in UNSUPPORTED_BUILTINS:
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
        cd_operands, bad_opt, physical = _split_cd_options(operands)
        if bad_opt is not None:
            err = (f"cd: -{bad_opt}: invalid option\n"
                   f"cd: usage: cd [-L|[-P [-e]] [-@]] [dir]\n").encode()
            return None, IOResult(exit_code=2,
                                  stderr=err), ExecutionNode(command="cd",
                                                             exit_code=2,
                                                             stderr=err)
        if len(cd_operands) > 1:
            err = b"cd: too many arguments\n"
            return None, IOResult(exit_code=1,
                                  stderr=err), ExecutionNode(command="cd",
                                                             exit_code=1,
                                                             stderr=err)
        if not cd_operands:
            home = home_dir(session)
            if home is None:
                err = b"cd: HOME not set\n"
                return None, IOResult(exit_code=1,
                                      stderr=err), ExecutionNode(command="cd",
                                                                 exit_code=1,
                                                                 stderr=err)
            return await handle_cd(dispatch,
                                   registry.is_mount_root,
                                   home,
                                   session,
                                   links=namespace.symlink_targets(),
                                   physical=physical)
        raw = cd_operands[0]
        raw_str = raw.virtual if isinstance(raw, PathSpec) else str(raw)
        if raw_str == "-":
            old = session.env.get("OLDPWD")
            if not old:
                err = b"cd: OLDPWD not set\n"
                return None, IOResult(exit_code=1, stderr=err), ExecutionNode(
                    command="cd -", exit_code=1, stderr=err)
            return await handle_cd(dispatch,
                                   registry.is_mount_root,
                                   old,
                                   session,
                                   print_path=True,
                                   links=namespace.symlink_targets(),
                                   physical=physical)
        path: str | PathSpec
        if isinstance(raw, PathSpec):
            path = raw
            cdpath_target = raw.raw_path
        elif raw_str.startswith("/"):
            path = raw_str
            cdpath_target = raw_str
        else:
            path = classify_bare_path(raw_str, registry, session.cwd)
            cdpath_target = raw_str
        return await handle_cd(dispatch,
                               registry.is_mount_root,
                               path,
                               session,
                               cdpath_target=cdpath_target,
                               links=namespace.symlink_targets(),
                               physical=physical)

    if name == SB.HISTORY:
        return await handle_history(registry, args, session)

    if name == SB.TRUE:
        return None, IOResult(), ExecutionNode(command="true", exit_code=0)

    if name == SB.FALSE:
        return None, IOResult(exit_code=1), ExecutionNode(command="false",
                                                          exit_code=1)

    if name in (SB.SOURCE, SB.DOT):
        path = operands[0] if operands else ""
        return await handle_source(dispatch, execute_fn, path, session)

    if name == SB.EVAL:
        return await handle_eval(execute_fn, args, session)

    if name in (SB.BASH, SB.SH):
        return await handle_bash(execute_fn, args, session, stdin)

    if name == SB.EXPORT:
        return await handle_export(args, session)

    if name == SB.UNSET:
        return await handle_unset(args, session)

    if name == SB.LOCAL:
        return await handle_local(args, session)

    if name == SB.PRINTENV:
        var_name = args[0] if args else None
        return await handle_printenv(var_name, session)

    if name == SB.WHOAMI:
        return await handle_whoami(namespace)

    if name == SB.MAN:
        return await handle_man(args, session, registry)

    if name == SB.READ:
        return await handle_read(args, session, stdin)

    if name == SB.SET:
        return await handle_set(args, session, call_stack=call_stack)

    if name == SB.SHIFT:
        return await handle_shift(args, call_stack, session=session)

    if name == SB.TRAP:
        return await handle_trap(session)

    if name in (SB.TEST, SB.BRACKET, SB.DOUBLE_BRACKET):
        test_args = list(operands)
        test_name = "[" if name == SB.BRACKET else "test"
        if name == SB.BRACKET:
            if test_args and word_text(test_args[-1]) == "]":
                test_args = test_args[:-1]
            else:
                err = b"[: missing `]'\n"
                return None, IOResult(exit_code=2,
                                      stderr=err), ExecutionNode(command="[",
                                                                 exit_code=2,
                                                                 stderr=err)
        return await handle_test(dispatch,
                                 namespace,
                                 test_args,
                                 session,
                                 name=test_name)

    if name == SB.ECHO:
        return await handle_echo(args)

    if name == SB.PRINTF:
        return await handle_printf(args)

    if name == SB.SLEEP:
        return await handle_sleep(args, cancel=cancel)

    if name == SB.RETURN:
        return await handle_return(args, session, call_stack)

    if name == SB.EXIT:
        return await handle_exit(args, session)

    if name == SB.XARGS:
        return await handle_xargs(execute_fn, args, session, stdin)

    if name == SB.TIMEOUT:
        return await handle_timeout(execute_fn, args, session)

    if name == SB.BREAK:
        raise BreakSignal(levels=_loop_levels(args))

    if name == SB.CONTINUE:
        raise ContinueSignal(levels=_loop_levels(args))

    # ── symlinks (namespace-backed; not bash builtins, not mount
    #    commands: they mutate the addressing layer) ──
    if name == "ln" and "s" in link_flags(operands, "sfnv"):
        return await handle_ln(namespace, session, operands)

    if name == "readlink":
        return handle_readlink(namespace, session, operands)

    # ── metadata commands (namespace-routed: resolve-then-setattr with
    #    overlay fallback; they run their own link follow) ──
    if name == "chmod":
        return await handle_chmod(namespace, dispatch, operands)
    if name == "chown":
        return await handle_chown(namespace, dispatch, operands)
    if name == "touch":
        return await handle_touch(namespace, dispatch, session, operands)

    # ── symlink-aware dispatch: reads follow links (open(2)); rm/mv act
    #    on the link entry itself (lstat semantics) ──
    post_unlink: str | None = None
    post_rename: tuple[str, str] | None = None
    if namespace.nodes:
        try:
            if name == "rm":
                operands, removed = await strip_link_operands(
                    namespace, operands)
                if removed and not any(
                        isinstance(a, PathSpec) for a in operands):
                    return None, IOResult(), ExecutionNode(command=name,
                                                           exit_code=0)
            elif name == "mv":
                operands, post_unlink, post_rename, early = await prepare_mv(
                    namespace, dispatch, operands)
                if early is not None:
                    return early
            elif name not in NO_FOLLOW_COMMANDS:
                operands = follow_paths(namespace, operands)
        except CycleError as exc:
            err = (f"{name}: {exc}: "
                   f"Too many levels of symbolic links\n").encode()
            return None, IOResult(exit_code=1,
                                  stderr=err), ExecutionNode(command=name,
                                                             exit_code=1,
                                                             stderr=err)
        argv = argv.with_operands(operands)

    # ── mount command (default) ─────────────────
    stdout, io, exec_node = await handle_command(
        recurse,
        dispatch,
        registry,
        argv.words,
        session,
        stdin,
        call_stack,
        job_table=job_table,
        namespace=namespace,
        routing_decision=routing_decision)

    if io.exit_code == 0 and namespace.nodes:
        if name == "rm":
            # A removed path takes its node meta (overlay attrs) with it;
            # a removed dir purges everything underneath. Glob operands
            # reach here unexpanded (backend wrappers expand them), so
            # the node table matches the pattern itself.
            for item in operands:
                if not isinstance(item, PathSpec):
                    continue
                if item.pattern:
                    await namespace.unlink_glob(item.virtual)
                else:
                    await namespace.unlink(item.virtual)
                    await namespace.purge_under(item.virtual)
        if post_unlink is not None:
            await namespace.unlink(post_unlink)
        if post_rename is not None:
            await namespace.rename(post_rename[0], post_rename[1])
    return stdout, io, exec_node

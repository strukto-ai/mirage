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
import dataclasses
from functools import partial
from typing import Any

from mirage.commands.builtin.utils.limit import run_with_timeout
from mirage.context import (redirect_paths_for, reset_admission,
                            reset_op_policies, set_admission, set_op_policies)
from mirage.io import IOResult
from mirage.io.types import materialize
from mirage.policy import PolicyDenied, resolve_limit
from mirage.policy.types import Claimant, HandOff, SessionContext
from mirage.runtime.routing import RouteDecision
from mirage.shell.bytes import encode_text
from mirage.shell.parse import find_syntax_error, parse, syntax_error_result
from mirage.shell.types import NodeType as NT
from mirage.shell.variable import ShellVar, VarAttr
from mirage.shell.xtrace import trace_command
from mirage.types import PathSpec, Producer, word_text
from mirage.utils.glob_walk import glob_pattern
from mirage.utils.path import CycleError
from mirage.workspace.executor.builtins.alias import alias_command_text
from mirage.workspace.executor.builtins.table import BUILTINS
from mirage.workspace.executor.builtins.types import BuiltinCall
from mirage.workspace.executor.command import handle_command
from mirage.workspace.expand import expand_node
from mirage.workspace.expand.argv import Argv, expand_argv
from mirage.workspace.expand.globs import expand_boundary_globs
from mirage.workspace.lookup import (SLASH_KEEPS_LAST, UNSUPPORTED_BUILTINS,
                                     follows_last_component)
from mirage.workspace.node.admission import Admitted, Refused, admit
from mirage.workspace.node.occurrence import claimant_for, evaluated_from
from mirage.workspace.session.state import (ensure_var_visible,
                                            pre_session_gate, seed_var,
                                            session_view, set_attr)
from mirage.workspace.types import ExecutionNode

from mirage.shell.helpers import (  # isort: skip
    get_command_name, get_parts, get_process_sub_body,
    get_process_sub_direction, get_text, split_env_prefix)
from mirage.shell.types import ProcessSubDirection  # isort: skip

from mirage.workspace.executor.builtins import (  # isort: skip
    accepts_line, follow_paths, handle_chgrp, handle_exec_path, handle_chmod,
    handle_chown, handle_df, handle_ln, handle_readlink, handle_touch,
    link_flags, prepare_mv, strip_link_operands)


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
    routing_decision: RouteDecision | None = None,
    agent_id: str = "",
    handed: HandOff | None = None,
) -> tuple[Any, IOResult, ExecutionNode]:
    """Dispatch a command node by name."""
    name = get_command_name(node)
    assignment_nodes, parts = split_env_prefix(get_parts(node))

    # ── alias expansion ─────────────────────────
    # bash rewrites the head word of a simple command before any other
    # expansion, textually, and reads the result as a fresh line: an
    # alias holding a pipe is a pipe. Only an unquoted plain word
    # qualifies (`\x` and `'x'` are never aliases), and `alias_value`
    # applies the rest of bash's rules (expand_aliases, the same-line
    # mark, the no-second-expansion stack). The rewritten line runs
    # through the same executor with the same call stack, so `$1`
    # inside a function still means the function's argument.
    if (session.aliases and parts and parts[0].type == NT.COMMAND_NAME
            and parts[0].named_children
            and parts[0].named_children[0].type == NT.WORD):
        head_node = parts[0]
        head = get_text(head_node)
        mark = (session._parse_current, node.start_point[0])
        source = get_text(node)
        base = node.start_byte
        rest = source[head_node.end_byte - base:]
        rewritten = alias_command_text(session, head, rest, mark)
        if rewritten is not None:
            line = source[:head_node.start_byte - base] + rewritten
            ast = parse(line)
            offending = find_syntax_error(ast)
            if offending is not None:
                io = syntax_error_result(offending)
                bad = io.stderr if isinstance(io.stderr, bytes) else b""
                return None, io, ExecutionNode(command=head,
                                               exit_code=io.exit_code,
                                               stderr=bad)
            session._alias_stack.append(head)
            # The rewritten line is read from this node, so it runs as
            # a line of its own under the word that named it: each
            # invocation of one alias is a place of its own on the line
            # (`c && c` asks twice, as its spelled-out form does), and
            # what its gates claim is the line's again at its end. Run
            # on the line's own hand-off, both reads stood at the same
            # offsets of the same text and the second ran on the
            # first's nod.
            expansion = (evaluated_from(node, handed)
                         if handed is not None else None)
            try:
                if expansion is None:
                    return await recurse(ast, session, stdin, call_stack)
                return await recurse(ast,
                                     session,
                                     stdin,
                                     call_stack,
                                     handed=expansion)
            finally:
                session._alias_stack.pop()
                if expansion is not None:
                    registry.decisions.hand_up(session.session_id, expansion)

    prefix_assignments: list[tuple[str, str]] = []
    for p in assignment_nodes:
        atext = get_text(p)
        if "=" not in atext:
            continue
        key, _, raw_val = atext.partition("=")
        val_nodes = [c for c in p.named_children if c.type != NT.VARIABLE_NAME]
        if val_nodes:
            v = await expand_node(val_nodes[0],
                                  session,
                                  execute_fn,
                                  call_stack,
                                  view=session_view(session,
                                                    registry.policies))
        else:
            v = raw_val
        prefix_assignments.append((key, v))

    for k, v in prefix_assignments:
        # The hidden gate runs first, as in set_var: calling a hidden
        # name "readonly" would leak that it exists. Both branches
        # below write session.env raw (a function-call prefix on
        # purpose never restores), so ungated they would let a
        # narrowed session clobber the host's value.
        try:
            ensure_var_visible(session, k)
            # ...and `pre_session` right after, with the value, because a
            # prefix assignment is a session write like any other and the
            # form exports it for the command. Only the hidden half was
            # checked here, so a deployment refusing `SECRET_*` still saw
            # `SECRET_K=leak printenv SECRET_K` print the secret: the
            # seeding below goes through `seed_var`, which is the ungated
            # door, so this loop is the only place the rule can be asked.
            await pre_session_gate(
                registry.policies,
                SessionContext(plane="env",
                               verb="set",
                               key=k,
                               value=v,
                               session_id=session.session_id))
        except PolicyDenied as exc:
            err = f"bash: {exc.strerror}\n".encode()
            return None, IOResult(exit_code=1,
                                  stderr=err), ExecutionNode(command=name or k,
                                                             exit_code=1,
                                                             stderr=err)
        if k in session.readonly_vars:
            err = f"bash: {k}: readonly variable\n".encode()
            return None, IOResult(exit_code=1,
                                  stderr=err), ExecutionNode(command=name or k,
                                                             exit_code=1,
                                                             stderr=err)

    if prefix_assignments and not name:
        for k, v in prefix_assignments:
            seed_var(session, k, v)
        return None, IOResult(), ExecutionNode(command=" ".join(
            f"{k}={v}" for k, v in prefix_assignments),
                                               exit_code=0)

    is_function_call = name in session.functions
    saved_env_overrides: dict[str, ShellVar | None] = {}
    for k, v in prefix_assignments:
        if not is_function_call:
            saved_env_overrides[k] = session.vars.get(k)
        # Exported for the duration, which is the whole point of the
        # form: `TOKEN=x printenv TOKEN` prints `x` because bash puts a
        # prefix assignment in the *command's environment*, not merely in
        # the shell. Seeding it plain left it invisible to every reader
        # of `env_snapshot` -- the command's own env, an installed CLI,
        # a guest runtime -- once that view narrowed to the exported set.
        # The saved record is put back below, so the attribute does not
        # outlive the command; a function call deliberately saves nothing
        # and keeps the assignment, as bash does.
        seed_var(session, k, v)
        set_attr(session, k, VarAttr.EXPORT)

    try:
        return await _dispatch_command_body(recurse, dispatch, registry,
                                            namespace, execute_fn, node, parts,
                                            name, session, stdin, call_stack,
                                            job_table, cancel,
                                            routing_decision, agent_id, handed)
    finally:
        for k, prev in saved_env_overrides.items():
            if prev is None:
                session.vars.pop(k, None)
            else:
                session.vars[k] = prev


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
    routing_decision: RouteDecision | None = None,
    agent_id: str = "",
    handed: HandOff | None = None,
) -> tuple[Any, IOResult, ExecutionNode]:
    # The command's place on the line, as the pass computed it, and
    # the door its nested evaluations re-enter through: a word that
    # runs a line (eval, source, xargs) is bound to this node, and a
    # substitution names its own node when it calls, so every nested
    # line stands under the node its text came from.
    claimant = claimant_for(node, handed)
    execute_fn = partial(execute_fn, node=node)
    parent = node.parent
    if parent is None or parent.type != NT.REDIRECTED_STATEMENT:
        for child in node.named_children:
            if child.type == NT.HERESTRING_REDIRECT:
                for sc in child.named_children:
                    content = await expand_node(sc,
                                                session,
                                                execute_fn,
                                                call_stack,
                                                view=session_view(
                                                    session,
                                                    registry.policies))
                    stdin = encode_text(content) + b"\n"
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
                io_ps = await execute_fn(inner,
                                         session_id=session.session_id,
                                         node=p)
                proc_sub_parts.append(io_ps.stdout or b"")
                stderr = await materialize(io_ps.stderr)
                if stderr:
                    proc_sub_stderr.append(stderr)
        else:
            clean_parts.append(p)
    if proc_sub_parts and stdin is None:
        stdin = b"".join(proc_sub_parts)
    parts = clean_parts

    argv = await expand_argv(parts,
                             session,
                             execute_fn,
                             call_stack,
                             registry,
                             namespace,
                             view=session_view(session, registry.policies))

    # Limits resolve against the expanded name, so `$CMD`-style
    # invocations get their real command's policy.
    resolved = resolve_limit(argv.name) if argv.name else None
    timeout = (resolved.timeout_seconds if resolved is not None else None)
    body = _run_argv(recurse,
                     dispatch,
                     registry,
                     namespace,
                     execute_fn,
                     argv,
                     session,
                     stdin,
                     call_stack,
                     job_table,
                     cancel,
                     routing_decision,
                     row=node.start_point[0],
                     agent_id=agent_id,
                     redirects=redirect_paths_for(node.id),
                     claimant=claimant)
    # Capture xtrace before the body runs so `set -x` itself is not
    # traced (bash enables tracing only for the following commands).
    xtrace = bool(session.shell_options.get("xtrace"))
    stdout, io, exec_node = await run_with_timeout(body, timeout, argv.name
                                                   or "?")
    if io.producer is None and argv.name:
        # Builtins and other non-mount routes return no rider; stamp the
        # expanded name here so post_execute policies keyed on a command
        # (echo, printf, ...) still see it.
        io.producer = Producer(command=argv.name)
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
    routing_decision: RouteDecision | None = None,
    row: int = 0,
    agent_id: str = "",
    redirects: tuple[PathSpec, ...] = (),
    claimant: Claimant | None = None,
) -> tuple[Any, IOResult, ExecutionNode]:
    """Route one expanded command to its builtin or mount handler.

    ``row`` is the command's line within its parse, which only ``alias``
    reads: a definition remembers where it was made so a use on the
    same line does not see it, as bash's line reader would not.
    ``agent_id`` is the agent the line is attributed to, which an
    approval request names. ``redirects`` are the statement's expanded
    redirect targets, judged with the line because their I/O runs on
    the shell's own fds outside the admitted command's gate window.
    """
    name = argv.name

    # ── boundary globs ──────────────────────────
    # A glob whose directory holds a child mount cannot be pushed down
    # to one backend: the mount root is a child of that directory but
    # its keys live in another resource, so the backend reports "no such
    # file" for a name its own listing shows. Expanding such a word here
    # lets the matches route per mount. It has to happen before the
    # admission policies below, not just before the follow policy: a
    # word left unexpanded reaches `pre_command` as the literal pattern,
    # and `MountRootPolicy` cannot recognize a mount root inside one, so
    # `tar -cf out.tar /base/*` would archive a whole backend the same
    # operand typed by hand is refused for.
    boundary = await expand_boundary_globs(list(argv.operands), registry,
                                           namespace)
    expanded = [word_text(w) for w in boundary]
    # Compared as words, not as a count: a glob that matches exactly one
    # name (`du /base/i*` where only the mount root matches) is still an
    # expansion, and dropping it routes the pattern to a backend that
    # cannot serve the child mount's keys.
    if expanded != [word_text(w) for w in argv.operands]:
        argv = dataclasses.replace(argv,
                                   operands=tuple(boundary),
                                   args=tuple(expanded))

    # ── visibility and admission ────────────────
    # The one chokepoint every command class passes through: shell
    # builtins, namespace-routed commands (touch/chmod/ln -s), job
    # builtins, shell functions, and mount commands all route below, so
    # the gate must fire here, not in handle_command. Checked ahead of
    # the BUILTINS table, which runs before lookup(); the enumerators
    # read the same visibility filter through _layers. Refusals win
    # over flag parsing, routing, and runtime placement.
    admitted: Admitted | None = None
    if name:
        verdict = await admit(name,
                              list(argv.args),
                              list(argv.operands),
                              session,
                              registry,
                              namespace,
                              agent_id,
                              stdin,
                              redirects=redirects,
                              cancel=cancel,
                              claimant=claimant)
        if isinstance(verdict, Refused):
            cmd_str = " ".join([name, *argv.args])
            return None, IOResult(exit_code=verdict.exit_code,
                                  stderr=verdict.stderr,
                                  refusal=verdict.refusal), ExecutionNode(
                                      command=cmd_str,
                                      exit_code=verdict.exit_code,
                                      stderr=verdict.stderr,
                                      refused=True)
        admitted = verdict

    # ── run ────────────────────────────────────
    # The admitted command's gate is bound for its run and reset after,
    # so its own I/O can ask about the entries the gate did not see and
    # a nested line binds its own (see ``Admitted``). The workspace's
    # policies bind in the same window, whether or not a gate judged the
    # line, so the command tier's policy guard can fire pre_ops for the
    # backend I/O a handler performs.
    ptoken = set_op_policies(registry.policies)
    try:
        if admitted is None:
            return await _route_argv(recurse, dispatch, registry, namespace,
                                     execute_fn, argv, session, stdin,
                                     call_stack, job_table, cancel,
                                     routing_decision, row)
        token = set_admission(admitted)
        try:
            return await _route_argv(recurse, dispatch, registry, namespace,
                                     execute_fn, argv, session, stdin,
                                     call_stack, job_table, cancel,
                                     routing_decision, row)
        finally:
            reset_admission(token)
    finally:
        reset_op_policies(ptoken)


def unsaid(lines: list[str], said: bytes) -> list[str]:
    """Drop the refusal lines the command tier already wrote.

    A mount-mode refusal names the mount, not the operand, so the line
    the node table wrote for a refused link is the very line
    ``Mount.execute_cmd`` writes for the backend operands beside it on
    the same mount, and ``rm dlink file`` would say it twice. The tier
    writes it without a trailing newline, so the comparison is on the
    stripped text.

    Args:
        lines (list[str]): the node table's refusal lines, in order.
        said (bytes): stderr the command tier already produced.

    Returns:
        list[str]: the lines not already present.
    """
    if not said:
        return lines
    spoken = {t.strip() for t in said.decode(errors="replace").split("\n")}
    return [line for line in lines if line.strip() not in spoken]


async def _route_argv(
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
    cancel: asyncio.Event | None,
    routing_decision: RouteDecision | None,
    row: int,
) -> tuple[Any, IOResult, ExecutionNode]:
    """Route one admitted command to its builtin or mount handler.

    The half of ``_run_argv`` past the gate, split out so the gate's
    verdict can be bound around it.
    """
    name = argv.name
    args = list(argv.args)
    operands = list(argv.operands)

    # ── path execution ─────────────────────────
    # bash hands a slash-carrying head word to the loader, never to
    # command lookup: no builtin, function, or CLI can claim it. After
    # the admission gate so a policy sees the line like any other.
    if name and "/" in name:
        return await handle_exec_path(dispatch, execute_fn, name,
                                      [word_text(a) for a in args], session,
                                      stdin)

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
    # One lookup: every executor-run builtin word maps to a handler that
    # takes the whole invocation, so the arms live beside their workers
    # (builtins/<word>/) rather than here. Job builtins and the
    # interpreters are not in the table; they route below.
    builtin = BUILTINS.get(name)
    if builtin is not None:
        return await builtin(
            BuiltinCall(argv=argv,
                        session=session,
                        stdin=stdin,
                        call_stack=call_stack,
                        cancel=cancel,
                        row=row,
                        dispatch=dispatch,
                        registry=registry,
                        namespace=namespace,
                        execute_fn=execute_fn))

    # ── pathname resolution (POSIX): every component of an operand but
    #    the last resolves for every command, so `stat dlink/f2` reports
    #    f2 the way GNU does. The last one resolves only for a command
    #    that follows (open(2) rather than lstat(2)) or an operand typed
    #    with a trailing slash, which POSIX reads as `dlink/.`. This runs
    #    ahead of every handler below because the kernel resolves a path
    #    before the syscall, not inside it.
    if namespace.nodes and operands:
        try:
            operands = follow_paths(namespace,
                                    operands,
                                    follows_last_component(name, argv.words),
                                    slash_follows=name not in SLASH_KEEPS_LAST)
        except CycleError as exc:
            err = (f"{name}: {exc}: "
                   f"Too many levels of symbolic links\n").encode()
            return None, IOResult(exit_code=1,
                                  stderr=err), ExecutionNode(command=name,
                                                             exit_code=1,
                                                             stderr=err)
        argv = argv.with_operands(operands)

    # ── symlinks (namespace-backed; not bash builtins, not mount
    #    commands: they mutate the addressing layer) ──
    if name == "ln" and "s" in link_flags(operands, "sfnvrT"):
        return await handle_ln(namespace, dispatch, session, operands)

    if name == "readlink":
        return await handle_readlink(namespace, dispatch, session, operands)

    # ── metadata commands (namespace-routed: resolve-then-setattr with
    #    overlay fallback; they run their own link follow) ──
    if name == "chmod":
        return await handle_chmod(namespace, dispatch, operands)
    if name == "chown":
        return await handle_chown(namespace, dispatch, operands)
    if name == "chgrp":
        return await handle_chgrp(namespace, dispatch, operands)
    if name == "touch":
        return await handle_touch(namespace, dispatch, session, operands)

    # ── capacity (registry-routed: enumerates mounts, reports per-mount
    #    statfs; never fabricates numbers) ──
    if name == "df":
        return await handle_df(registry, session, dispatch, operands)

    # ── symlink-aware dispatch: reads follow links (open(2)); rm/mv act
    #    on the link entry itself (lstat semantics) ──
    post_unlink: str | None = None
    post_rename: tuple[str, str] | None = None
    link_errors: list[str] = []
    if namespace.nodes:
        try:
            # Both remove the link entry itself, which no backend can
            # see; unlink(1) is rm(1) restricted to one non-directory.
            # Gated on the line being one the command layer accepts,
            # because this removal happens before that layer parses and
            # it cannot be taken back (GNU refuses `rm --bogus dlink`
            # and `unlink dlink other` with the link still there).
            if name in ("rm", "unlink") and accepts_line(
                    name, argv.args, operands, session.cwd):
                operands, handled, link_errors = await strip_link_operands(
                    name, dispatch, namespace, operands, argv.args,
                    session.cwd)
                if handled and not any(
                        isinstance(a, PathSpec) for a in operands):
                    if not link_errors:
                        return None, IOResult(), ExecutionNode(command=name,
                                                               exit_code=0)
                    err = "".join(link_errors).encode()
                    return None, IOResult(
                        exit_code=1, stderr=err), ExecutionNode(command=name,
                                                                exit_code=1,
                                                                stderr=err)
            elif name == "mv":
                operands, post_unlink, post_rename, early = await prepare_mv(
                    namespace, dispatch, operands)
                if early is not None:
                    return early
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
        routing_decision=routing_decision,
        execute_fn=execute_fn)

    if io.exit_code == 0 and namespace.nodes:
        if name == "rm":
            # A removed path takes its node meta (overlay attrs) with it;
            # a removed dir purges everything underneath. Glob operands
            # reach here unexpanded (backend wrappers expand them), so
            # the node table matches the pattern itself.
            for item in operands:
                if not isinstance(item, PathSpec):
                    continue
                if item.raw_path.endswith("/"):
                    # A trailing slash asked for the directory, and rm
                    # refused (or -f silenced the refusal). Nothing was
                    # removed, so nothing may be purged: dropping the
                    # node here deleted the very link the slash
                    # protects (GNU keeps it through `rm -rf dlink/`).
                    continue
                if item.pattern:
                    # A quoted metacharacter is a literal here too,
                    # so the node table is matched with the same
                    # pattern the backend resolved with.
                    await namespace.unlink_glob(glob_pattern(item.virtual))
                else:
                    await namespace.unlink(item.virtual)
                    await namespace.purge_under(item.virtual)
        if post_unlink is not None:
            await namespace.unlink(post_unlink)
        if post_rename is not None:
            await namespace.rename(post_rename[0], post_rename[1])
    if link_errors:
        # A refused link operand fails the line the way a refused
        # backend operand does: its lines lead (they were reported
        # first) and any success stays a partial one. Merged after the
        # bookkeeping above so the operands the backend did remove
        # still shed their node meta.
        tail = io.stderr if isinstance(io.stderr, bytes) else b""
        err = "".join(unsaid(link_errors, tail)).encode()
        io.stderr = err + tail
        if io.exit_code == 0:
            io.exit_code = 1
        node_tail = exec_node.stderr or b""
        node_err = "".join(unsaid(link_errors, node_tail)).encode()
        exec_node.stderr = node_err + node_tail
        if exec_node.exit_code == 0:
            exec_node.exit_code = 1
    return stdout, io, exec_node

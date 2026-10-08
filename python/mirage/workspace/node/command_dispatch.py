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
from collections.abc import Awaitable, Callable
from functools import partial
from itertools import accumulate
from types import SimpleNamespace
from typing import Any, TypeVar

from mirage.commands.builtin.utils.limit import guard_io, run_with_timeout
from mirage.context import (
    RedirectOpener,
    redirect_opener_for,
    redirect_paths_for,
    reset_admission,
    set_admission,
)
from mirage.io import IOResult
from mirage.io.types import materialize
from mirage.policy import PolicyDenied, resolve_limit, resolve_producer
from mirage.policy.policies import reset_op_policies, set_op_policies
from mirage.policy.types import Claimant, HandOff, SessionContext
from mirage.runtime.routing import RouteDecision
from mirage.shell.bytes import decode_text, encode_text
from mirage.shell.console import Channel, JobConsole
from mirage.shell.errors import ExitSignal
from mirage.shell.helpers import (
    get_command_name,
    get_parts,
    get_process_sub_body,
    get_process_sub_direction,
    get_text,
    split_env_prefix,
)
from mirage.shell.parse import check_syntax, syntax_error_result
from mirage.shell.parse.scope import ParseScope
from mirage.shell.parse.source import source_offsets
from mirage.shell.parse.syntax import find_syntax_issue
from mirage.shell.types import AliasExpansion, ProcessSubDirection
from mirage.shell.types import NodeType as NT
from mirage.shell.variable import TempEnv, VarAttr
from mirage.shell.xtrace import trace_command
from mirage.types import LsLinkMode, PathSpec, Producer, word_text
from mirage.utils.glob_walk import glob_pattern
from mirage.utils.path import CycleError
from mirage.vfs.dev.dev import DevVFS
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.executor.builtins import (
    accepts_line,
    follow_directory_links,
    follow_paths,
    handle_chgrp,
    handle_chmod,
    handle_chown,
    handle_df,
    handle_exec_path,
    handle_getfattr,
    handle_ln,
    handle_mount,
    handle_readlink,
    handle_setfattr,
    handle_touch,
    prepare_mv,
    settle_moves,
    strip_link_operands,
)
from mirage.workspace.executor.builtins.alias import (
    alias_command_text,
    expanding_aliases,
)
from mirage.workspace.executor.builtins.table import BUILTINS
from mirage.workspace.executor.builtins.types import BuiltinCall
from mirage.workspace.executor.command import handle_command
from mirage.workspace.executor.command.external import run_external
from mirage.workspace.expand import expand_node
from mirage.workspace.expand.argv import Argv, expand_argv
from mirage.workspace.expand.globs import expand_boundary_globs
from mirage.workspace.expand.node import child_line
from mirage.workspace.lookup import (
    SLASH_KEEPS_LAST,
    UNSUPPORTED_BUILTINS,
    Consumer,
    follows_last_component,
    lookup,
    ls_link_mode,
    runtime_refused,
)
from mirage.workspace.lookup.constants import INTERPRETER_NAMES
from mirage.workspace.node.admission import Admitted, Refused, admit
from mirage.workspace.node.occurrence import claimant_for, evaluated_from
from mirage.workspace.session.state import (
    ensure_var_visible,
    pre_session_gate,
    seed_var,
    session_view,
    set_attr,
)
from mirage.workspace.types import ExecutionNode

T = TypeVar("T")


async def _own_words(node: Any, pending: Awaitable[T]) -> T:
    """Await an expansion of the command's own words; an ``ExitSignal``
    it raises names the command, whose redirects bash had not applied.

    Args:
        node (Any): the command.
        pending (Awaitable[T]): the expansion.
    """
    try:
        return await pending
    except ExitSignal as exc:
        exc.expanding = node.id
        raise


async def execute_command(
    recurse,
    dispatch,
    registry,
    namespace,
    execute_fn,
    node,
    context: EvaluationContext,
    stdin,
    call_stack,
    job_table,
    cancel: asyncio.Event | None = None,
    routing_decision: RouteDecision | None = None,
    agent_id: str = "",
    handed: HandOff | None = None,
    sink: JobConsole | None = None,
) -> tuple[Any, IOResult, ExecutionNode]:
    """Dispatch a command node by name.

    ``sink`` is where a command that runs statements of its own (a
    function body, a nested shell) writes them as they finish.
    """
    session = context.session
    name = get_command_name(node)
    assignment_nodes, parts = split_env_prefix(get_parts(node))

    # ── alias expansion ─────────────────────────
    # bash rewrites the head word of a simple command before any other
    # expansion, textually, and reads the result as a fresh line: an
    # alias holding a pipe is a pipe. Only an unquoted plain word
    # qualifies (`\x` and `'x'` are never aliases), and `alias_value`
    # applies the rest of bash's rules (expand_aliases, the same-line
    # mark, the guards on inserted text). The rewritten line runs
    # through the same executor with the same call stack, so `$1`
    # inside a function still means the function's argument.
    if (
        (session.aliases or session._alias_view)
        and parts
        and parts[0].type == NT.COMMAND_NAME
        and parts[0].named_children
        and parts[0].named_children[0].type == NT.WORD
    ):
        head_node = parts[0]
        head = get_text(head_node)
        mark = (
            session._parse_current,
            session._parse_row + node.start_point[0],
        )
        rewrite = alias_command_text(session, node, head_node, mark)
        if rewrite is not None:
            line, owners = rewrite
            offsets = tuple(
                accumulate((len(encode_text(c)) for c in line), initial=0)
            )
            names = frozenset(name for names in owners for name in names)
            previous = session._alias_expansion
            scope = ParseScope()
            try:
                ast = scope.parse(line)
                found = check_syntax(
                    line,
                    expanding_aliases(session) | names,
                    lambda name, at: name in owners[offsets[at]],
                ) or find_syntax_issue(ast)
                if found is not None:
                    io = syntax_error_result(found)
                    bad = io.stderr if isinstance(io.stderr, bytes) else b""
                    return (
                        None,
                        io,
                        ExecutionNode(
                            command=head, exit_code=io.exit_code, stderr=bad
                        ),
                    )
                mapped = owners + (frozenset(),)
                session._alias_expansion = AliasExpansion(
                    ast.id,
                    tuple(mapped[i] for i in source_offsets(line, ast)),
                    names,
                )
                # The rewritten line is read from this node, so it runs as
                # a line of its own under the word that named it: each
                # invocation of one alias is a place of its own on the line
                # (`c && c` asks twice, as its spelled-out form does), and
                # what its gates claim is the line's again at its end. Run
                # on the line's own hand-off, both reads stood at the same
                # offsets of the same text and the second ran on the
                # first's nod.
                expansion = (
                    evaluated_from(node, handed)
                    if handed is not None
                    else None
                )
                try:
                    if expansion is None:
                        return await recurse(ast, context, stdin, call_stack)
                    return await recurse(
                        ast, context, stdin, call_stack, handed=expansion
                    )
                finally:
                    session._alias_expansion = previous
                    if expansion is not None:
                        registry.decisions.hand_up(
                            session.session_id, expansion
                        )
            finally:
                scope.release()

    prefix_assignments: list[tuple[str, str]] = []
    for p in assignment_nodes:
        atext = get_text(p)
        if "=" not in atext:
            continue
        key, _, raw_val = atext.partition("=")
        val_nodes = [c for c in p.named_children if c.type != NT.VARIABLE_NAME]
        if val_nodes:
            v = await _own_words(
                node,
                expand_node(
                    val_nodes[0],
                    context,
                    execute_fn,
                    call_stack,
                    view=session_view(
                        session,
                        registry.policies,
                        diagnostics=context.frame.diagnostics,
                    ),
                ),
            )
        else:
            v = raw_val
        prefix_assignments.append((key, v))

    for k, v in prefix_assignments:
        # The hidden gate runs first, as in set_var: calling a hidden
        # name "readonly" would leak that it exists. Both branches
        # below write session.env raw (an `export` inside a function
        # keeps its prefix past the call), so ungated they would let a
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
                SessionContext(
                    plane="env",
                    verb="set",
                    key=k,
                    value=v,
                    session_id=session.session_id,
                ),
            )
        except PolicyDenied as exc:
            err = encode_text(f"bash: {exc.strerror}\n")
            return (
                None,
                IOResult(exit_code=1, stderr=err),
                ExecutionNode(command=name or k, exit_code=1, stderr=err),
            )
        if k in session.readonly_vars:
            err = encode_text(f"bash: {k}: readonly variable\n")
            return (
                None,
                IOResult(exit_code=1, stderr=err),
                ExecutionNode(command=name or k, exit_code=1, stderr=err),
            )

    if prefix_assignments and not name:
        for k, v in prefix_assignments:
            seed_var(session, k, v)
        return (
            None,
            IOResult(),
            ExecutionNode(
                command=" ".join(f"{k}={v}" for k, v in prefix_assignments),
                exit_code=0,
            ),
        )

    saved_env_overrides = TempEnv()

    def seed_prefix(command: str) -> None:
        # Seeded once the command's words are expanded, since bash
        # expands them with the values from before the assignment:
        # `x=new echo $x` prints the old x and `IFS=, cmd $v` splits on
        # the old IFS.
        for k, v in prefix_assignments:
            saved_env_overrides.setdefault(k, session.vars.get(k))
            # Exported for the duration, which is the whole point of the
            # form: `TOKEN=x printenv TOKEN` prints `x` because bash puts
            # a prefix assignment in the *command's environment*, not
            # merely in the shell. Seeding it plain left it invisible to
            # every reader of `env_snapshot` -- the command's own env, an
            # installed CLI, a guest runtime -- once that view narrowed
            # to the exported set. The saved record is put back below, so
            # neither the value nor the attribute outlives the command.
            seed_var(session, k, v)
            set_attr(session, k, VarAttr.EXPORT)
        if command in session.functions:
            # A function runs with the prefix as its temporary
            # environment, a scope under its own locals: `unset` inside
            # reveals the caller's value and `export` keeps the name.
            session._local_frames.append(saved_env_overrides)

    try:
        return await _dispatch_command_body(
            recurse,
            dispatch,
            registry,
            namespace,
            execute_fn,
            node,
            parts,
            name,
            context,
            stdin,
            call_stack,
            job_table,
            seed_prefix,
            cancel,
            routing_decision,
            agent_id,
            handed,
            sink,
        )
    finally:
        frames = session._local_frames
        if frames and frames[-1] is saved_env_overrides:
            frames.pop()
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
    context: EvaluationContext,
    stdin,
    call_stack,
    job_table,
    seed_prefix: Callable[[str], None],
    cancel: asyncio.Event | None = None,
    routing_decision: RouteDecision | None = None,
    agent_id: str = "",
    handed: HandOff | None = None,
    sink: JobConsole | None = None,
) -> tuple[Any, IOResult, ExecutionNode]:
    # The command's place on the line, as the pass computed it, and
    # the door its nested evaluations re-enter through: a word that
    # runs a line (eval, source, xargs) is bound to this node, and a
    # substitution names its own node when it calls, so every nested
    # line stands under the node its text came from.
    session = context.session
    claimant = claimant_for(node, handed)
    execute_fn = partial(execute_fn, node=node)

    # Buffered virtual files preserve operand identity without host pipes.
    dev: DevVFS | None = None
    proc_sub_inputs: list[tuple[str, int]] = []
    proc_sub_stderr = []
    clean_parts = []
    try:
        for p in parts:
            if p.type != NT.PROCESS_SUBSTITUTION:
                clean_parts.append(p)
                continue
            if get_process_sub_direction(p) == ProcessSubDirection.OUTPUT:
                err = b"mirage: unsupported: process substitution >(...)\n"
                return (
                    None,
                    IOResult(exit_code=2, stderr=err),
                    ExecutionNode(
                        command=name or "process_sub", exit_code=2, stderr=err
                    ),
                )
            if dev is None:
                dev, _, _ = registry.resolve("/dev/null")
                assert isinstance(dev, DevVFS)
            path, allocation = dev.allocate_input()
            proc_sub_inputs.append((path, allocation))
            inner = get_process_sub_body(p)
            if inner:
                io_ps = await child_line(
                    context, execute_fn, inner, p, call_stack
                )
                data = await materialize(io_ps.stdout)
                dev.set_input(path, allocation, data)
                proc_sub_stderr.append(await materialize(io_ps.stderr))
            clean_parts.append(
                SimpleNamespace(
                    type=NT.WORD,
                    text=encode_text(path),
                    children=[],
                    named_children=[],
                )
            )
        parts = clean_parts

        argv = await _own_words(
            node,
            expand_argv(
                parts,
                context,
                execute_fn,
                call_stack,
                registry,
                namespace,
                view=session_view(
                    session,
                    registry.policies,
                    diagnostics=context.frame.diagnostics,
                ),
                routing=routing_decision,
            ),
        )
        seed_prefix(argv.name)

        # Limits resolve against the expanded name, so `$CMD`-style
        # invocations get their real command's policy.
        # Mount, CLI and external dispatch own their resolved deadlines.
        owns_deadline = (
            "/" not in argv.name
            and lookup(argv.name, session, registry, routing_decision)
            in (Consumer.EXTERNAL, Consumer.MOUNT, Consumer.CLI)
        ) or argv.name in INTERPRETER_NAMES
        resolved = (
            resolve_limit(
                argv.name,
                workspace_limits=registry.command_limits,
                profile_limits=session.command_limits,
            )
            if argv.name and not owns_deadline
            else None
        )
        timeout = resolved.timeout_seconds if resolved is not None else None
        body = _run_argv(
            recurse,
            dispatch,
            registry,
            namespace,
            execute_fn,
            argv,
            context,
            stdin,
            call_stack,
            job_table,
            cancel,
            routing_decision,
            row=node.start_point[0],
            agent_id=agent_id,
            redirects=redirect_paths_for(node.id),
            opener=redirect_opener_for(node.id),
            claimant=claimant,
            sink=sink,
        )
        # Capture xtrace before the body runs so `set -x` itself is not
        # traced (bash enables tracing only for the following commands).
        # A body that writes as it runs is traced before it starts.
        xtrace = bool(session.shell_options.get("xtrace")) and bool(argv.name)
        if xtrace and sink is not None:
            await sink.emit(
                Channel.STDERR, trace_command([argv.name, *argv.args])
            )
            xtrace = False
        stdout, io, exec_node = await run_with_timeout(
            body, timeout, argv.name or "?"
        )
        if io.producer is None and argv.name:
            # Builtins and other non-mount routes return no rider; stamp the
            # expanded name here so post_execute policies keyed on a command
            # (echo, printf, ...) still see it.
            io.producer = Producer(command=argv.name)
        if not io.output_finalized:
            io.output_finalized = True
            if (
                session.terminal_output
                and session.exec_stdout in (None, "&1")
                and io.producer is not None
            ):
                bound = resolve_producer(
                    io.producer,
                    registry.limit_override,
                    registry.command_limits,
                    session.command_limits,
                )
                stdout = guard_io(stdout, io, bound, io.producer.command)
                exec_node.exit_code = io.exit_code
        if proc_sub_stderr:
            io.stderr = b"".join(proc_sub_stderr) + await materialize(
                io.stderr
            )
            exec_node.stderr = io.stderr
        if xtrace:
            existing = await materialize(io.stderr) or b""
            io.stderr = trace_command([argv.name, *argv.args]) + existing
        if proc_sub_inputs and stdout is not None:
            stdout = await materialize(stdout)
        return stdout, io, exec_node
    finally:
        if dev is not None:
            for path, allocation in proc_sub_inputs:
                dev.release_input(path, allocation)


async def _run_argv(
    recurse,
    dispatch,
    registry,
    namespace,
    execute_fn,
    argv: Argv,
    context: EvaluationContext,
    stdin,
    call_stack,
    job_table,
    cancel: asyncio.Event | None = None,
    routing_decision: RouteDecision | None = None,
    row: int = 0,
    agent_id: str = "",
    redirects: tuple[PathSpec, ...] = (),
    opener: RedirectOpener | None = None,
    claimant: Claimant | None = None,
    sink: JobConsole | None = None,
) -> tuple[Any, IOResult, ExecutionNode]:
    """Route one expanded command to its builtin or mount handler.

    ``row`` is the command's line within its parse, which only ``alias``
    reads: a definition remembers where it was made so a use on the
    same line does not see it, as bash's line reader would not.
    ``agent_id`` is the agent the line is attributed to, which an
    approval request names. ``redirects`` are the statement's expanded
    redirect targets, judged with the line because their I/O runs on
    the shell's own fds outside the admitted command's gate window, and
    ``opener`` opens them once the line is admitted.
    """
    session = context.session
    name = argv.name

    # ── boundary globs ──────────────────────────
    # A glob whose directory holds a child mount cannot be pushed down
    # to one backend: the mount root is a child of that directory but
    # its keys live in another VFS, so the backend reports "no such
    # file" for a name its own listing shows. Expanding such a word here
    # lets the matches route per mount. It has to happen before the
    # admission policies below, not just before the follow policy: a
    # word left unexpanded reaches `pre_command` as the literal pattern,
    # and `MountRootPolicy` cannot recognize a mount root inside one, so
    # `tar -cf out.tar /base/*` would archive a whole backend the same
    # operand typed by hand is refused for.
    refused_external = runtime_refused(
        name, session, registry, routing_decision
    )
    boundary = (
        list(argv.operands)
        if refused_external
        else await expand_boundary_globs(
            list(argv.operands), registry, namespace
        )
    )
    expanded = [word_text(w) for w in boundary]
    # Compared as words, not as a count: a glob that matches exactly one
    # name (`du /base/i*` where only the mount root matches) is still an
    # expansion, and dropping it routes the pattern to a backend that
    # cannot serve the child mount's keys.
    if expanded != [word_text(w) for w in argv.operands]:
        argv = dataclasses.replace(
            argv, operands=tuple(boundary), args=tuple(expanded)
        )

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
        verdict = await admit(
            name,
            list(argv.args),
            list(argv.operands),
            session,
            registry,
            namespace,
            agent_id,
            stdin,
            redirects=redirects,
            cancel=cancel,
            claimant=claimant,
        )
        if isinstance(verdict, Refused):
            cmd_str = " ".join([name, *argv.args])
            return (
                None,
                IOResult(
                    exit_code=verdict.exit_code,
                    stderr=verdict.stderr,
                    refusal=verdict.refusal,
                ),
                ExecutionNode(
                    command=cmd_str,
                    exit_code=verdict.exit_code,
                    stderr=verdict.stderr,
                    refused=True,
                ),
            )
        admitted = verdict
    # bash opens a command's write targets before it runs, so `cat f > f`
    # reads an emptied file; here that waits for the admission above,
    # because a command the gate refuses must leave its targets alone.
    if opener is not None and not await opener(name, tuple(argv.args)):
        return None, IOResult(exit_code=1), ExecutionNode(exit_code=1)

    # ── run ────────────────────────────────────
    # The admitted command's gate is bound for its run and reset after,
    # so its own I/O can ask about the entries the gate did not see and
    # a nested line binds its own (see ``Admitted``). The workspace's
    # policies bind in the same window, whether or not a gate judged the
    # line, so the command tier's policy guard can fire pre_vfs for the
    # backend I/O a handler performs.
    ptoken = set_op_policies(registry.policies)
    try:
        if admitted is None:
            return await _route_argv(
                recurse,
                dispatch,
                registry,
                namespace,
                execute_fn,
                argv,
                context,
                stdin,
                call_stack,
                job_table,
                cancel,
                routing_decision,
                row,
                agent_id,
                claimant.line if claimant is not None else None,
                sink,
            )
        token = set_admission(admitted)
        try:
            return await _route_argv(
                recurse,
                dispatch,
                registry,
                namespace,
                execute_fn,
                argv,
                context,
                stdin,
                call_stack,
                job_table,
                cancel,
                routing_decision,
                row,
                agent_id,
                claimant.line if claimant is not None else None,
                sink,
            )
        finally:
            reset_admission(token)
    finally:
        reset_op_policies(ptoken)


def unsaid(lines: list[str], said: bytes) -> list[str]:
    """Drop the refusal lines the command tier already wrote.

    A mount-mode refusal names the mount, not the operand, so the line
    the node table wrote for a refused link is the very line
    ``Mount.run_command`` writes for the backend operands beside it on
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
    spoken = {t.strip() for t in decode_text(said).split("\n")}
    return [line for line in lines if line.strip() not in spoken]


async def _route_argv(
    recurse,
    dispatch,
    registry,
    namespace,
    execute_fn,
    argv: Argv,
    context: EvaluationContext,
    stdin,
    call_stack,
    job_table,
    cancel: asyncio.Event | None,
    routing_decision: RouteDecision | None,
    row: int,
    agent_id: str = "",
    handed: HandOff | None = None,
    sink: JobConsole | None = None,
) -> tuple[Any, IOResult, ExecutionNode]:
    """Route one admitted command to its builtin or mount handler.

    The half of ``_run_argv`` past the gate, split out so the gate's
    verdict can be bound around it.
    """
    session = context.session
    name = argv.name
    args = list(argv.args)
    operands = list(argv.operands)

    # ── path execution ─────────────────────────
    # bash hands a slash-carrying head word to the loader, never to
    # command lookup: no builtin, function, or CLI can claim it. After
    # the admission gate so a policy sees the line like any other.
    if name and "/" in name:
        return await handle_exec_path(
            dispatch,
            execute_fn,
            name,
            [word_text(a) for a in args],
            context,
            registry,
            namespace,
            stdin,
            sink,
            job_table,
        )

    # ── unsupported bash builtins ──────────────
    # Constructs the parser accepts but the executor cannot honor.
    # Returning a clear error lets LLMs detect a capability gap instead
    # of treating it as a missing binary or a silent no-op.
    if name in UNSUPPORTED_BUILTINS:
        err = encode_text(f"mirage: unsupported builtin: {name}\n")
        return (
            None,
            IOResult(exit_code=2, stderr=err),
            ExecutionNode(command=name, exit_code=2, stderr=err),
        )

    consumer = lookup(name, session, registry, routing_decision)
    if consumer is Consumer.EXTERNAL:
        return await run_external(
            argv, stdin, session, registry, routing_decision
        )

    # ── shell builtins ──────────────────────────
    # One lookup: every executor-run builtin word maps to a handler that
    # takes the whole invocation, so the arms live beside their workers
    # (builtins/<word>/) rather than here. Job builtins and the
    # interpreters are not in the table; they route below.
    builtin = BUILTINS.get(name)
    if builtin is not None:
        return await builtin(
            BuiltinCall(
                argv=argv,
                context=context,
                stdin=stdin,
                call_stack=call_stack,
                cancel=cancel,
                row=row,
                dispatch=dispatch,
                registry=registry,
                namespace=namespace,
                execute_fn=execute_fn,
                sink=sink,
                job_table=job_table,
            )
        )

    # ── pathname resolution (POSIX): every component of an operand but
    #    the last resolves for every command, so `stat dlink/f2` reports
    #    f2 the way GNU does. The last one resolves only for a command
    #    that follows (open(2) rather than lstat(2)) or an operand typed
    #    with a trailing slash, which POSIX reads as `dlink/.`. This runs
    #    ahead of every handler below because the kernel resolves a path
    #    before the syscall, not inside it. An operand a link loop stands
    #    in comes back refused (`walk_error`) rather than failing the
    #    line: the command meets ELOOP at its op and words it per operand.
    if namespace.nodes and operands:
        ls_mode = ls_link_mode(argv.words) if name == "ls" else None
        operands = follow_paths(
            namespace,
            operands,
            ls_mode is LsLinkMode.ALL
            if ls_mode is not None
            else follows_last_component(name, argv.words),
            slash_follows=name not in SLASH_KEEPS_LAST,
        )
        if ls_mode is LsLinkMode.DIRECTORY:
            # ls resolves a command-line link only when it leads to a
            # directory, and only a stat can tell where it leads.
            operands = await follow_directory_links(
                namespace, dispatch, operands
            )
        argv = argv.with_operands(operands)

    # ── symlinks (namespace-backed; not bash builtins, not mount
    #    commands: they mutate the addressing layer) ──
    if name == "ln":
        return await handle_ln(namespace, dispatch, session, operands)

    if name == "readlink":
        return await handle_readlink(namespace, dispatch, session, operands)

    # ── extended attributes (the door's node table and the backend's
    #    own facts; they read -h themselves) ──
    if name == "getfattr":
        return await handle_getfattr(dispatch, session, operands)
    if name == "setfattr":
        return await handle_setfattr(dispatch, session, operands)

    # ── metadata commands (namespace-routed: resolve-then-setattr with
    #    overlay fallback; they run their own link follow) ──
    if name == "chmod":
        return await handle_chmod(namespace, dispatch, session, operands)
    if name == "chown":
        return await handle_chown(namespace, dispatch, session, operands)
    if name == "chgrp":
        return await handle_chgrp(namespace, dispatch, session, operands)
    if name == "touch":
        return await handle_touch(namespace, dispatch, session, operands)

    # ── capacity (registry-routed: enumerates mounts, reports per-mount
    #    capacity; never fabricates numbers) ──
    if name == "df":
        return await handle_df(registry, session, dispatch, operands)
    if name == "mount":
        return await handle_mount(registry, session, operands)

    # ── symlink-aware dispatch: reads follow links (open(2)); rm/mv act
    #    on the link entry itself (lstat semantics) ──
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
                name, argv.args, operands, session.cwd
            ):
                operands, handled, link_errors = await strip_link_operands(
                    name, dispatch, namespace, operands, argv.args, session.cwd
                )
                if handled and not any(
                    isinstance(a, PathSpec) for a in operands
                ):
                    if not link_errors:
                        return (
                            None,
                            IOResult(),
                            ExecutionNode(command=name, exit_code=0),
                        )
                    err = encode_text("".join(link_errors))
                    return (
                        None,
                        IOResult(exit_code=1, stderr=err),
                        ExecutionNode(command=name, exit_code=1, stderr=err),
                    )
            elif name == "mv":
                operands, early = await prepare_mv(
                    namespace, dispatch, operands, argv.args, session.cwd
                )
                if early is not None:
                    return early
        except CycleError as exc:
            err = encode_text(f"{name}: {exc.filename}: {exc.strerror}\n")
            return (
                None,
                IOResult(exit_code=1, stderr=err),
                ExecutionNode(command=name, exit_code=1, stderr=err),
            )
        argv = argv.with_operands(operands)

    # ── mount command (default) ─────────────────
    stdout, io, exec_node = await handle_command(
        recurse,
        dispatch,
        registry,
        argv.words,
        context,
        stdin,
        call_stack,
        job_table=job_table,
        namespace=namespace,
        routing_decision=routing_decision,
        agent_id=agent_id,
        execute_fn=execute_fn,
        handed=handed,
        sink=sink,
    )

    if io.exit_code == 0 and namespace.nodes:
        if name == "rm":
            # A removed path takes its node meta (overlay attrs) with it;
            # a removed dir purges everything underneath. Glob operands
            # reach here unexpanded (backend wrappers expand them), so
            # the node table matches the pattern itself.
            for item in operands:
                if not isinstance(item, PathSpec):
                    continue
                if item.walk_error is not None:
                    # The walk refused it, so rm removed nothing there
                    # (-f only silenced the refusal), and the empty
                    # name's `virtual` is the working directory: purging
                    # under it dropped every link the directory held.
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
    if name == "mv" and io.renames:
        await settle_moves(namespace, io.renames)
    if link_errors:
        # A refused link operand fails the line the way a refused
        # backend operand does: its lines lead (they were reported
        # first) and any success stays a partial one. Merged after the
        # bookkeeping above so the operands the backend did remove
        # still shed their node meta.
        tail = io.stderr if isinstance(io.stderr, bytes) else b""
        err = encode_text("".join(unsaid(link_errors, tail)))
        io.stderr = err + tail
        if io.exit_code == 0:
            io.exit_code = 1
        node_tail = exec_node.stderr or b""
        node_err = encode_text("".join(unsaid(link_errors, node_tail)))
        exec_node.stderr = node_err + node_tail
        if exec_node.exit_code == 0:
            exec_node.exit_code = 1
    return stdout, io, exec_node

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
from collections.abc import (
    AsyncIterator,
    Awaitable,
    Callable,
    Mapping,
    Sequence,
)
from contextlib import ExitStack
from functools import partial
from itertools import accumulate
from typing import Any, TypeVar, assert_never

from mirage.commands.builtin.utils.limit import (
    guard_io,
)
from mirage.context import (
    RedirectRunner,
    bind_caller,
    current_caller,
    is_program_invocation,
    note_decision,
    redirect_paths_for,
    redirect_runner_for,
    reset_caller,
    set_program_invocation,
    set_redirect_paths,
)
from mirage.context.session_context import (
    RedirectResult,
    redirect_syntax_for,
    syntax_head,
)
from mirage.core.machine.place import crossing_reason
from mirage.execution.types import MachineName
from mirage.io import IOResult
from mirage.io.types import ByteSource, OutputState, materialize
from mirage.observe.context import command_records
from mirage.policy import (
    CommandResultContext,
    Deny,
    PolicyDenied,
    decision_of,
    post_command_gate,
    render_deny,
    resolve_producer,
)
from mirage.policy.match import closed_by_default
from mirage.policy.policies import agreed
from mirage.policy.types import Claimant, HandOff, Route
from mirage.runtime.routing import RouteError
from mirage.runtime.table import routed
from mirage.runtime.types import DispatchFn, RouteDecision, RuntimeIdentity
from mirage.shell.bytes import decode_text, encode_text, utf8_locale
from mirage.shell.call_stack import CallStack
from mirage.shell.console import Channel, JobConsole
from mirage.shell.constants import CANNOT_EXECUTE_STATUS
from mirage.shell.descriptors import Recorder, output_target
from mirage.shell.errors import (
    ArithError,
    DiscardSignal,
    ExitSignal,
    TooManyMatches,
)
from mirage.shell.helpers import (
    get_command_name,
    get_parts,
    get_text,
    read_row,
    split_env_prefix,
)
from mirage.shell.parse.constants import ALIAS_WORD_TYPES, WORD_BREAKS
from mirage.shell.parse.parse import syntax_refusal
from mirage.shell.parse.scope import ParseScope
from mirage.shell.types import (
    AliasExpansion,
    Redirect,
    RedirectKind,
    TSNodeLike,
)
from mirage.shell.types import NodeType as NT
from mirage.shell.variable import ShellVar, VarAttr
from mirage.shell.voice import shell_voice
from mirage.shell.xtrace import trace_command
from mirage.types import PathSpec, Producer, word_text
from mirage.utils.glob_walk import glob_pattern, unmark_globs
from mirage.utils.path import (
    CycleError,
    glob_prefix_match,
    parent,
    resolve_path,
)
from mirage.workspace.dispatcher.reader import NamespaceReader
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.executor.builtins import (
    accepts_line,
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
    handle_wrapper,
    operand_follow,
    prepare_mv,
    strip_link_operands,
)
from mirage.workspace.executor.builtins.alias import (
    alias_command_text,
    alias_mark,
    expanding_aliases,
)
from mirage.workspace.executor.builtins.exec import diverted_file
from mirage.workspace.executor.builtins.help import flag_help
from mirage.workspace.executor.builtins.links.ln import LinkPlan, LnFlags
from mirage.workspace.executor.builtins.table import BUILTINS
from mirage.workspace.executor.builtins.types import BuiltinCall
from mirage.workspace.executor.command import handle_command
from mirage.workspace.executor.command.command import (
    command_worker,
    fill_tree_env,
    made_by_command,
)
from mirage.workspace.executor.command.external import run_external
from mirage.workspace.executor.command.handler import argument_list_too_long
from mirage.workspace.executor.command.resolved import (
    NAMESPACE_PROGRAMS,
    ExecutionTarget,
    MountTarget,
    NamespaceProgram,
    PathTarget,
    ResolvedCommand,
    WorkerTarget,
)
from mirage.workspace.executor.deps import ExecuteNodeDeps, with_opts
from mirage.workspace.expand import expand_assignment
from mirage.workspace.expand.argv import Argv, expand_argv
from mirage.workspace.expand.globs import (
    expand_boundary_globs,
    glob_options,
    resolve_globs,
)
from mirage.workspace.frame import PipeWriter
from mirage.workspace.lookup import (
    UNSUPPORTED_BUILTINS,
    Consumer,
    runtime_refused,
)
from mirage.workspace.lookup.constants import (
    EXEC_WRAPPERS,
    MACHINE_ANSWERED,
    MACHINE_ONLY_BUILTINS,
    PROGRAM_WRAPPERS,
)
from mirage.workspace.lookup.lookup import (
    CliTarget,
    external_target,
    program_head,
    program_runtime,
    resolve_target,
    runs_as,
    runs_programs,
    runs_wrapper,
    target_consumer,
)
from mirage.workspace.lookup.machine.about import fact_machine
from mirage.workspace.lookup.machine.answers import bin_program
from mirage.workspace.lookup.machine.command import operand_machine
from mirage.workspace.lookup.machine.links import link_machine
from mirage.workspace.lookup.machine.mounts import (
    machine_names,
    several_machines,
)
from mirage.workspace.lookup.machine.preferred import (
    asks_machines,
    pipe_writer_machine,
    preferred_machine,
)
from mirage.workspace.lookup.machine.program import program_machine
from mirage.workspace.lookup.machine.search import (
    bound_to,
    config_pins,
    is_searched,
    searched_machine,
)
from mirage.workspace.lookup.types import ExternalTarget, FunctionTarget
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.node.admission import (
    Admitted,
    Refused,
    admit,
    classified_words,
)
from mirage.workspace.node.explain import UNREADABLE_LINES
from mirage.workspace.node.inner_lines import Word, program_lines
from mirage.workspace.node.occurrence import (
    argv_frame,
    claimant_for,
    evaluated_from,
    whole_occurrence,
)
from mirage.workspace.node.types import ExpandedWords
from mirage.workspace.session import SessionState
from mirage.workspace.session.budget import check_env, entry_bytes
from mirage.workspace.session.state import (
    bind_last_word,
    deref,
    ensure_var_visible,
    env_is_readonly,
    seed_var,
    visible_env,
)
from mirage.workspace.types import ExecutionNode

T = TypeVar("T")


async def _own_words(node: TSNodeLike, pending: Awaitable[T]) -> T:
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


def parser_aliases(
    line: str,
    aliases: frozenset[str],
    owners: tuple[frozenset[str], ...],
    offsets: tuple[int, ...],
) -> frozenset[str]:
    """The aliases the parser takes for a line an alias rewrote.

    An alias is no alias inside the text its own expansion produced, so
    a name spelling a reserved word is that word there (``alias fi='if
    :; then :; fi'`` closes its own ``if``). The parser takes one set for
    the line, so a name that stands in its own text leaves it.

    Args:
        line (str): the rewritten line.
        aliases (frozenset[str]): the names the line's reader expands.
        owners (tuple[frozenset[str], ...]): per byte, the aliases whose
            expansion wrote it.
        offsets (tuple[int, ...]): each character's byte offset.
    """
    return frozenset(
        name
        for name in aliases
        if not _owned_word(line, name, owners, offsets)
    )


def _owned_word(
    line: str,
    name: str,
    owners: tuple[frozenset[str], ...],
    offsets: tuple[int, ...],
) -> bool:
    """Whether ``name`` stands as a word of ``line`` inside text its own
    expansion produced.

    Args:
        line (str): the rewritten line.
        name (str): an alias name.
        owners (tuple[frozenset[str], ...]): per byte, the aliases whose
            expansion wrote it.
        offsets (tuple[int, ...]): each character's byte offset.
    """
    at = line.find(name)
    while at >= 0:
        end = at + len(name)
        if (
            (at == 0 or line[at - 1] in WORD_BREAKS)
            and (end == len(line) or line[end] in WORD_BREAKS)
            and name in owners[offsets[at]]
        ):
            return True
        at = line.find(name, at + 1)
    return False


async def _run_alias(
    recurse: Callable[..., Awaitable[RedirectResult]],
    registry: MountRegistry,
    node: TSNodeLike,
    parts: list[TSNodeLike],
    context: EvaluationContext,
    stdin: ByteSource | None,
    call_stack: CallStack | None,
    handed: HandOff | None,
    sink: JobConsole | None,
) -> RedirectResult | None:
    """Run a command whose head word is an alias, None when it is not.

    bash rewrites the head word of a simple command before any other
    expansion, textually, and reads the result as a fresh line: an alias
    holding a pipe is a pipe. Only an unquoted plain word qualifies
    (`\\x` and `'x'` are never aliases), and `alias_value` applies the
    rest of bash's rules (the aliases and expand_aliases as the
    command's read found them, the guards on inserted text). The
    rewritten line runs through the same executor with the same call
    stack, so `$1` inside a function still means the function's
    argument. A line run as a program (`exec`, `env`, `find -exec`) is
    an argv, which no alias rewrites.

    Args:
        recurse (Callable): runs the rewritten line.
        registry (MountRegistry): holds the decision ledger.
        node (TSNodeLike): the command.
        parts (list[TSNodeLike]): its words past the prefix assignments.
        context (EvaluationContext): the evaluation.
        stdin (ByteSource | None): its input.
        call_stack (CallStack | None): the call stack.
        handed (HandOff | None): the line's grants.
        sink (JobConsole | None): where its statements write.
    """
    session = context.session
    if (
        (session.aliases or session._alias_view or session._alias_marks)
        and not is_program_invocation(session)
        and parts
        and parts[0].type == NT.COMMAND_NAME
        and parts[0].named_children
        and parts[0].named_children[0].type in ALIAS_WORD_TYPES
    ):
        head_node = parts[0]
        head = get_text(head_node)
        rewrite = alias_command_text(
            session, node, head_node, alias_mark(session, read_row(node))
        )
        if rewrite is not None:
            line, owners = rewrite
            offsets = tuple(
                accumulate((len(encode_text(c)) for c in line), initial=0)
            )
            names = frozenset(name for names in owners for name in names)
            previous = session._alias_expansion
            scope = ParseScope()
            try:
                aliases = expanding_aliases(session) | names
                ast = scope.parse(
                    line,
                    parser_aliases(line, aliases, owners, offsets),
                    session.shopts.get("extglob", False),
                )
                io = syntax_refusal(
                    ast,
                    syntax_head(session),
                    session.line_number,
                    utf8_locale(visible_env(session)),
                )
                if io is not None:
                    bad = io.stderr if isinstance(io.stderr, bytes) else b""
                    return (
                        None,
                        io,
                        ExecutionNode(
                            command=head, exit_code=io.exit_code, stderr=bad
                        ),
                    )
                mapped = owners + (frozenset(),)
                offsets = getattr(ast, "offsets", ())
                session._alias_expansion = AliasExpansion(
                    ast.id,
                    mapped
                    if isinstance(offsets, range)
                    else tuple(mapped[i] for i in offsets),
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

                token = set_redirect_paths(
                    ast.id, (), syntax=redirect_syntax_for(node.id)
                )
                try:
                    return await recurse(
                        ast,
                        context,
                        stdin,
                        call_stack,
                        handed=expansion,
                        sink=sink,
                    )
                finally:
                    reset_caller(token)
                    session._alias_expansion = previous
                    if expansion is not None:
                        registry.decisions.hand_up(
                            session.session_id, expansion
                        )
            finally:
                scope.release()
    return None


async def execute_command(
    deps: ExecuteNodeDeps,
    recurse: Callable[..., Awaitable[RedirectResult]],
    node: TSNodeLike,
    context: EvaluationContext,
    stdin: ByteSource | None,
    call_stack: CallStack | None,
    expanded: ExpandedWords | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Dispatch a command node by name.

    ``deps.sink`` is where a command that runs statements of its own (a
    function body, a nested shell) writes them as they finish, and
    ``expanded`` is filled with the words the command expanded to, so
    its caller knows what the head ran as.

    Args:
        deps (ExecuteNodeDeps): what the command runs against.
        recurse (Callable): the plain execute_node recursion.
        node (TSNodeLike): the command node.
        context (EvaluationContext): the evaluation's session and frame.
        stdin (ByteSource | None): input stream.
        call_stack (CallStack | None): shell call stack.
        expanded (ExpandedWords | None): filled with the words the
            command expanded to.
    """
    registry = deps.registry
    execute_fn = deps.execute_fn
    handed = deps.handed
    sink = deps.sink
    session = context.session
    name = get_command_name(node)
    assignment_nodes, parts = split_env_prefix(get_parts(node))

    aliased = await _run_alias(
        recurse,
        registry,
        node,
        parts,
        context,
        stdin,
        call_stack,
        handed,
        sink,
    )
    if aliased is not None:
        return aliased

    prefix_assignments: list[tuple[str, str]] = []
    # A readonly name before a command is refused before its value
    # expands, on the shell's own stderr, and the command runs without
    # it; with no command it is a plain assignment, refused once its
    # value expands (below), and the line is discarded.
    refused = b""
    for p in assignment_nodes:
        atext = get_text(p)
        if "=" not in atext:
            continue
        key, _, raw_val = atext.partition("=")
        if name and env_is_readonly(session, key, True):
            refused += encode_text(
                f"{shell_voice()}{key}: readonly variable\n"
            )
            continue
        val_nodes = [c for c in p.named_children if c.type != NT.VARIABLE_NAME]
        if val_nodes:
            v = await _own_words(
                node,
                expand_assignment(
                    val_nodes[0],
                    context,
                    execute_fn,
                    call_stack,
                ),
            )
        else:
            v = raw_val
        prefix_assignments.append((key, v))

    for given, v in prefix_assignments:
        # Each check is of the name the write lands on, a reference's
        # target (`r=new cmd` over `declare -n r=T` writes T).
        k = deref(session, given)
        # The hidden check runs first, as in set_var: calling a hidden
        # name "readonly" would leak that it exists. Both branches below
        # write through `seed_var`, past the writer's checks (an `export`
        # inside a function keeps its prefix past the call), so this loop
        # is the only place a narrowed session is kept from clobbering the
        # host's value.
        try:
            ensure_var_visible(session, k)
        except PolicyDenied as exc:
            return _write_refused(exc, name or k)
        if k in session.readonly_vars:
            raise DiscardSignal(
                encode_text(f"{shell_voice()}{given}: readonly variable\n")
            )

    # The saved records of arrays declared and never assigned, which a
    # record put back as a table entry no longer says.
    unassigned: dict[str, ShellVar] = {}

    def restore(saved: Mapping[str, Any]) -> None:
        for k, prev in saved.items():
            if prev is None:
                session.vars.pop(k, None)
            else:
                session.vars[k] = prev
                if unassigned.get(k) is prev:
                    session.vars.shell.unassigned(k)
        saves = session._prefix_saves
        saves[:] = [s for s in saves if s is not saved]

    if prefix_assignments and not name:
        for k, v in prefix_assignments:
            seed_var(session, k, v)
        landed: RedirectResult = (
            None,
            IOResult(),
            ExecutionNode(
                command=" ".join(f"{k}={v}" for k, v in prefix_assignments),
                exit_code=0,
            ),
        )
        # Redirects among the assignments (`x=1 > f y=2`) still open
        # their files, and one that fails fails the line; the assignments
        # stand either way.
        runner = redirect_runner_for(node.id)
        if runner is None:
            return landed

        async def assigned_only(
            given: ByteSource | None,
            sink: JobConsole | None,
            paths: tuple[PathSpec, ...],
        ) -> RedirectResult:
            return landed

        return await runner(assigned_only, None, "", ())

    saved_env_overrides: dict[str, ShellVar | None] = {}
    # A function's prefix is its temporary environment, a scope the
    # shell keeps under the function's locals: `unset` inside reveals
    # the caller's value and `export` keeps the name.
    temp: int | None = None

    def seed_prefix(command: str) -> None:
        nonlocal temp
        shell = session.vars.shell
        if command in session.functions:
            temp = shell.open_temp()
        # A function's prefix scope keeps the records it saves, and the
        # shell counts them against max_env itself.
        if temp is None:
            session._prefix_saves.append(saved_env_overrides)
        # Seeded once the command's words are expanded, since bash
        # expands them with the values from before the assignment:
        # `x=new echo $x` prints the old x and `IFS=, cmd $v` splits on
        # the old IFS.
        for given, v in prefix_assignments:
            # A reference's temporary is its target's (`N=5 cmd` over
            # `declare -n N=T` sets T).
            k = deref(session, given)
            # A first write's old record stays held; a repeat drops the earlier value.
            old = session.vars.get(k) if k in saved_env_overrides else None
            check_env(
                session,
                0 if old is None else entry_bytes(k, old.value),
                entry_bytes(k, v),
            )
            if k not in saved_env_overrides:
                held = saved_env_overrides[k] = session.vars.get(k)
                if held is not None and shell.is_unassigned(k):
                    unassigned[k] = held
            if temp is not None:
                shell.save_temp(temp, k)
            # Exported for the duration, which is the whole point of the
            # form: `TOKEN=x printenv TOKEN` prints `x` because bash puts
            # a prefix assignment in the *command's environment*, not
            # merely in the shell. Seeding it plain left it invisible to
            # every reader of `env_snapshot` -- the command's own env, an
            # installed CLI, a guest runtime -- once that view narrowed
            # to the exported set. The temporary carries that mark alone,
            # as bash's does: `declare -i n; n=1+2 cmd` hands cmd `1+2`
            # and `declare -p n` there prints `declare -x`. The saved
            # record is put back below, so neither outlives the command.
            session.vars[k] = ShellVar(v, frozenset({VarAttr.EXPORT}))

    if refused and sink is not None:
        await sink.emit(Channel.STDERR, refused)
        refused = b""
    settling: OutputState | None = None
    try:
        stdout, io, exec_node = await _run_command_body(
            deps,
            recurse,
            node,
            parts,
            context,
            stdin,
            call_stack,
            seed_prefix,
            expanded,
            assigned=frozenset(k for k, _ in prefix_assignments),
            prefix_path={
                deref(session, given): v for given, v in prefix_assignments
            }.get("PATH"),
        )
        if refused:
            io.stderr = refused + (await materialize(io.stderr))
        # A run that starts as its output is read still runs under the
        # prefix, so the lines it shells out see it: the prefix ends as
        # that output settles.
        if (
            prefix_assignments
            and io.output is not None
            and not io.output.settled
        ):
            settling = io.output
        return stdout, io, exec_node
    except TooManyMatches as exc:
        # The command a glob was given to does not run, as exec(2)
        # refuses an argument list too long; the line goes on.
        err = argument_list_too_long(name, exc.reason)
        return (
            None,
            IOResult(exit_code=CANNOT_EXECUTE_STATUS, stderr=err),
            ExecutionNode(
                command=name, exit_code=CANNOT_EXECUTE_STATUS, stderr=err
            ),
        )
    finally:
        saved = saved_env_overrides
        if temp is not None:
            # The scope closes now and puts back what it saved, which a
            # name `export` let outlive the call no longer is; a run
            # still settling keeps the prefix until it settles.
            shell = session.vars.shell
            running = {k: session.vars.get(k) for k in saved}
            shell.close_temp(temp)
            saved = {k: session.vars.get(k) for k in saved}
            if settling is not None:
                restore(running)
        if settling is not None:
            settling.callbacks.append(partial(restore, saved))
        elif temp is None:
            restore(saved)


def _unmet(
    namespace: Namespace, session: SessionState, pattern: str
) -> frozenset[str]:
    """The node entries a glob ``rm`` never removed: those whose name
    the pattern matched is one the session cannot see, which the
    backend's expansion met as absent. Empty for a session that hides
    nothing.

    Args:
        namespace (Namespace): the name plane.
        session (SessionState): the session ``rm`` ran in.
        pattern (str): the operand's absolute glob pattern.
    """
    links = namespace.session_links(session)
    if not links.hides_under("/"):
        return frozenset()
    depth = len(pattern.strip("/").split("/"))
    return frozenset(
        path
        for path in namespace.nodes
        if glob_prefix_match(path, pattern)
        and not links.visible(
            "/" + "/".join(path.strip("/").split("/")[:depth])
        )
    )


def _rm_unseen(
    namespace: Namespace,
    session: SessionState,
    operands: Sequence[str | PathSpec],
) -> tuple[dict[str, frozenset[str]], frozenset[str]]:
    """What ``rm`` meets as absent, read before it runs: per glob
    operand the node entries it never removes (``_unmet``), and the
    literal operands the session cannot see. Read afterwards, a link
    hidden only because its walk passed through a directory the line
    removed reads as a visible dangling link, and its node would go.

    Args:
        namespace (Namespace): the name plane.
        session (SessionState): the session ``rm`` runs in.
        operands (Sequence[str | PathSpec]): the line's operands.
    """
    links = namespace.session_links(session)
    kept: dict[str, frozenset[str]] = {}
    hidden: set[str] = set()
    for item in operands:
        if not isinstance(item, PathSpec):
            continue
        if item.pattern:
            pattern = glob_pattern(item.virtual)
            kept[pattern] = _unmet(namespace, session, pattern)
        elif not links.visible(item.virtual):
            hidden.add(item.virtual)
    return kept, frozenset(hidden)


def _write_refused(
    exc: PolicyDenied, command: str
) -> tuple[None, IOResult, ExecutionNode]:
    """A prefix assignment to a hidden name: bash's line, exit 1.

    Args:
        exc (PolicyDenied): the refusal.
        command (str): the command the assignment prefixed.
    """
    err = encode_text(f"{shell_voice()}{exc.strerror}\n")
    return (
        None,
        IOResult(exit_code=1, stderr=err),
        ExecutionNode(command=command, exit_code=1, stderr=err),
    )


async def _run_command_body(
    deps: ExecuteNodeDeps,
    recurse: Callable[..., Awaitable[RedirectResult]],
    node: TSNodeLike,
    parts: list[TSNodeLike],
    context: EvaluationContext,
    stdin: ByteSource | None,
    call_stack: CallStack | None,
    seed_prefix: Callable[[str], None],
    expanded: ExpandedWords | None = None,
    assigned: frozenset[str] = frozenset(),
    prefix_path: str | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    # The command's place on the line, as the pass computed it, and
    # the entry point its nested evaluations re-enter through: a word that
    # runs a line (eval, source, xargs) is bound to this node, and a
    # substitution names its own node when it calls, so every nested
    # line stands under the node its text came from.
    session = context.session
    registry = deps.registry
    namespace = deps.namespace
    sink = deps.sink
    claimant = claimant_for(node, deps.handed)
    deps = ExecuteNodeDeps(
        dispatch=deps.dispatch,
        registry=registry,
        namespace=namespace,
        job_table=deps.job_table,
        entry=partial(deps.entry, node=node),
        cancel=deps.cancel,
        handed=deps.handed,
        line_handle=deps.line_handle,
        sink=sink,
    )
    execute_fn = deps.execute_fn

    argv = await _own_words(
        node,
        expand_argv(
            parts,
            context,
            execute_fn,
            call_stack,
            registry,
            namespace,
        ),
    )
    if expanded is not None:
        expanded.words = (argv.name, *argv.args)

    body = _run_argv(
        deps,
        recurse,
        argv,
        context,
        stdin,
        call_stack,
        row=read_row(node),
        redirects=redirect_paths_for(node.id),
        runner=redirect_runner_for(node.id),
        seed_prefix=seed_prefix,
        claimant=claimant,
        assigned=assigned,
        prefix_path=prefix_path,
    )
    # Capture xtrace before the body runs so `set -x` itself is not
    # traced (bash enables tracing only for the following commands).
    # A body that writes as it runs is traced before it starts.
    xtrace = bool(session.shell_options.get("xtrace")) and bool(argv.name)
    if xtrace and sink is not None:
        await sink.emit(Channel.STDERR, trace_command([argv.name, *argv.args]))
        xtrace = False
    stdout, io, exec_node = await body
    bind_last_word(session, (argv.name, *argv.args) if argv.name else ())
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
                registry.limit_mount,
                registry.command_limits,
                session.command_limits,
            )
            stdout = guard_io(stdout, io, bound, io.producer.command)
            exec_node.exit_code = io.exit_code
    if xtrace:
        existing = await materialize(io.stderr)
        io.stderr = trace_command([argv.name, *argv.args]) + existing
    return stdout, io, exec_node


async def _run_argv(
    deps: ExecuteNodeDeps,
    recurse: Callable[..., Awaitable[RedirectResult]],
    argv: Argv,
    context: EvaluationContext,
    stdin: ByteSource | None,
    call_stack: CallStack | None,
    row: int = 0,
    redirects: tuple[PathSpec, ...] = (),
    runner: RedirectRunner | None = None,
    seed_prefix: Callable[[str], None] | None = None,
    claimant: Claimant | None = None,
    assigned: frozenset[str] = frozenset(),
    prefix_path: str | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Route one expanded command to its builtin or mount handler.

    ``row`` is the row the shell began reading the command on within its
    parse (``read_row``), which only ``alias``, ``unalias`` and ``shopt``
    read: the commands of one read keep the aliases it began with.
    ``redirects`` are the statement's expanded
    redirect targets, judged with the line because their I/O runs on
    the shell's own fds outside the admitted command's gate window, and
    ``runner`` applies redirects after word expansion, gating each open.

    Args:
        deps (ExecuteNodeDeps): what the command runs against.
        recurse (Callable): the plain execute_node recursion.
        argv (Argv): the expanded command words.
        context (EvaluationContext): the evaluation's session and frame.
        stdin (ByteSource | None): input stream.
        call_stack (CallStack | None): shell call stack.
        row (int): the row the shell began reading the command on.
        redirects (tuple[PathSpec, ...]): the statement's expanded
            redirect targets.
        runner (RedirectRunner | None): applies the redirects after word
            expansion, None when the command has none.
        seed_prefix (Callable[[str], None] | None): seeds the prefix
            assignments once the command's name is known.
        claimant (Claimant | None): the command and its line.
        assigned (frozenset[str]): the names the command's prefix
            assignments set.
        prefix_path (str | None): the PATH the command's prefix sets
            (``PATH=/opt/bin tool``), which its program is looked up
            on; None when it sets none.
    """
    registry = deps.registry
    namespace = deps.namespace
    cancel = deps.cancel
    sink = deps.sink
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
        name, session, registry, context.frame.routing
    )
    boundary = (
        list(argv.operands)
        if refused_external
        else await expand_boundary_globs(
            list(argv.operands), registry, namespace.session_links(session)
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
    # Ahead of every admission of the command: the gate walks a mount's tree
    # under the managed values its run reads. A first fetch changes how the
    # words read (an env-filled required option lets the walk reach the
    # leaf, whose files are paths), so they are classified again.
    if name and await fill_tree_env(
        name, list(argv.args), session, registry, assigned
    ):
        words = await classified_words(
            name, list(argv.args), session, registry
        )
        argv = dataclasses.replace(argv, operands=tuple(words[1:]))

    admitted: Admitted | None = None
    # What the last admission was asked about: the redirect layer admits
    # each target before it opens it, and then the run admits the whole
    # statement, so the policies are asked again only for a target they
    # have not seen.
    asked: tuple[bool | str, ...] | None = None

    async def guard(
        paths: tuple[PathSpec, ...],
        given: ByteSource | None,
        opening: Redirect | None = None,
    ) -> RedirectResult | None:
        nonlocal admitted, asked
        key: tuple[bool | str, ...] = (
            given is None,
            *(p.virtual for p in paths),
        )
        if admitted is not None and asked == key:
            return None
        if name:
            asked = key
            verdict = await admit(
                name,
                list(argv.args),
                list(argv.operands),
                session,
                registry,
                namespace,
                given,
                redirects=paths,
                cancel=cancel,
                claimant=claimant,
            )
            if isinstance(verdict, Refused):
                return _refused(" ".join([name, *argv.args]), verdict)
            admitted = verdict
        return None

    async def run_redirected(
        given: ByteSource | None,
        output: JobConsole | None,
        paths: tuple[PathSpec, ...],
    ) -> RedirectResult:
        if seed_prefix is not None:
            seed_prefix(name)
        decision = await guard(paths, given)
        if decision is not None:
            return decision
        # ── run ────────────────────────────────────
        # The admitted command's gate is bound for its run and reset after,
        # so its own I/O can ask about the entries the gate did not see and
        # a nested line binds its own (see ``Admitted``).
        # A post method reads what the command did: its file records,
        # gathered as it runs and as its output drains, and its result
        # node, settled once the output has drained.
        policies = registry.policies
        sid = context.session.session_id
        judging = admitted is not None and (
            await policies.wants_for("post_command", sid)
        )
        watched = judging or await policies.wants_for("post_execute", sid)
        # The command's own layer of the caller: once admitted, its gate,
        # and no declared limit until its mount binds its own, so a
        # command a registered one runs keeps none of that one's.
        outer = current_caller()
        token = bind_caller(
            outer.changed(
                {
                    "gate": admitted if admitted is not None else outer.gate,
                    "command": argv.name,
                    "invocation": (
                        admitted.ctx if admitted is not None else None
                    ),
                    "declared": None,
                    "output_file": (
                        output_target(diverted_file(context.session, output))
                        if isinstance(output, Recorder)
                        else None
                    ),
                }
            )
        )
        # A pre_command route places this command, and what it runs, over
        # the line's placement for its run alone: the lines it runs
        # (`eval`) keep the command's placement, not the line's.
        line_routing = context.frame.routing
        entry = deps.entry

        def place(route: Route | None) -> None:
            nonlocal entry
            here = context.frame.routing
            if route is None or here is None:
                return
            if searched is not None and unplaced is not None:
                here = unplaced
            try:
                context.frame.routing = routed(
                    registry.runtime_entries,
                    here.bindings,
                    route.machine,
                    here.machine,
                )
            except ValueError as exc:
                raise RouteError(str(exc)) from exc
            entry = partial(deps.entry, routing_decision=context.frame.routing)

        try:
            place(admitted.route if admitted is not None else None)
            # A wrapper a machine takes by name starts its program there,
            # where Mirage never runs it, so the program is judged here, and
            # where a policy places it the wrapper goes with it. One process
            # runs them all, so every route answering for them has to agree.
            if (
                admitted is not None
                and name in PROGRAM_WRAPPERS
                and context.frame.routing is not None
                and name in context.frame.routing.bindings
            ):
                verdict = await _wrapped_verdict(
                    [Word(w, w) for w in (name, *argv.args)],
                    session,
                    registry,
                    namespace,
                    given,
                    cancel,
                    claimant,
                )
                if isinstance(verdict, Refused):
                    return _refused(" ".join([name, *argv.args]), verdict)
                own = [] if admitted.route is None else [admitted.route]
                answer = agreed([*own, *verdict])
                if isinstance(answer, Deny):
                    err, code = render_deny(name, answer)
                    return _refused(
                        " ".join([name, *argv.args]),
                        Refused(err, code, decision_of(answer)),
                    )
                place(answer)
            routed_deps = with_opts(deps, {"sink": output})
            if entry is not deps.entry:
                routed_deps = dataclasses.replace(routed_deps, entry=entry)
            with command_records(own=True) as mine, ExitStack() as lifetime:
                command = await bind_command(
                    argv, routed_deps, context, given, lifetime
                )
                crossed = _pipe_crossing(
                    name,
                    argv,
                    _target_machine(command.target)
                    if command.target != "wrapper"
                    else machine,
                    context.frame.pipe_writer_of(given),
                    registry,
                    (admitted is not None and admitted.route is not None)
                    or (
                        unplaced is not None
                        and config_pins(
                            [name, *argv.args], session, registry, unplaced
                        )
                    ),
                )
                if crossed is not None:
                    return crossed
                result = await run_resolved(
                    routed_deps,
                    recurse,
                    command,
                    context,
                    given,
                    call_stack,
                    row,
                )
        finally:
            context.frame.routing = line_routing
            reset_caller(token)
        if not watched:
            return result
        stdout, io, node = result
        early = b"" if io.stderr is None else io.stderr
        saved = node.stderr

        # post_command judges the command once its result is final: a
        # streamed output settles its exit code and the stderr it adds as
        # it drains (unless the command saved that itself, as an external
        # one does), so the method is asked when the stream ends or its
        # reader stops, and at once for output already whole. A refusal
        # leaves what was sent as sent: exit 126, the refusal line on
        # stderr, the decision record.
        async def settle() -> None:
            # A function hands back its last command's node, which keeps
            # the records that command made.
            node.exit_code = io.exit_code
            node.records.extend(mine)
            late = b"" if io.stderr is None else io.stderr
            if (
                node.stderr is saved
                and isinstance(early, bytes)
                and isinstance(late, bytes)
                and late.startswith(early)
            ):
                said = b"".join(io.stderr_pieces or ())
                node.stderr += late[len(early) :] + said
            if not judging:
                return
            assert admitted is not None
            ctx = admitted.ctx
            stderr = await materialize(io.stderr)
            io.stderr = stderr
            facts = {
                f.name: getattr(ctx, f.name) for f in dataclasses.fields(ctx)
            }
            action = await post_command_gate(
                policies,
                CommandResultContext(
                    **facts,
                    exit_code=io.exit_code,
                    stderr=(stderr + b"".join(io.stderr_pieces or ())).decode(
                        errors="replace"
                    ),
                    records=tuple(r.to_dict() for r in mine),
                ),
                claimant,
                cancel,
            )
            if action is None:
                return
            err, code = render_deny(ctx.command, action)
            io.stderr = stderr + err
            node.stderr = node.stderr + err
            io.exit_code = node.exit_code = code
            io.decision = decision_of(action)
            if io.decision is not None:
                note_decision(io.decision)

        if stdout is None or isinstance(stdout, bytes):
            await settle()
            return result
        pulled = aiter(stdout)

        async def drained() -> AsyncIterator[bytes]:
            done = False
            try:
                while True:
                    # Each pull runs the command's lazy reads; they are
                    # its own, whoever is reading.
                    with command_records(own=True) as more:
                        try:
                            chunk = await anext(pulled, None)
                        finally:
                            mine.extend(more)
                    if chunk is None:
                        done = True
                        return
                    yield chunk
            finally:
                # A reader that stops early closes the producer too.
                close = getattr(pulled, "aclose", None)
                if not done and close is not None:
                    await close()
                await settle()

        return drained(), io, node

    # A name the command's redirects make lands on the machine its
    # program runs on (``python gen.py > /tmp/out``), the machine a
    # program named by its path runs on because the file is that
    # machine's (``/tmp/tool > /tmp/out``), or the machine that runs a
    # command of Mirage's own whole (``cat /srv/a/x > /tmp/out``), whose
    # output is that machine's bytes. That matters only over several
    # machines, so only then is it asked before the redirects open, once
    # the command is admitted: a refused one never reaches a machine.
    # Search order, the holder of a program file and the machine a
    # command prefers each ask the machines, so the command is admitted
    # once, before any of them.
    unplaced = context.frame.routing
    searched = _searched_program(
        name,
        argv.args,
        session,
        registry,
        unplaced,
        namespace.session_links(session),
    )
    placed_first = (runner is not None or redirects) and several_machines(
        registry
    )
    by_path = "/" in name and placed_first
    handed = (
        placed_first
        and "/" not in name
        and not _input_redirected(runner)
        and _may_run_on_machine(name, argv, session, registry, unplaced)
    )
    if (
        searched is not None
        or by_path
        or handed
        or asks_machines(
            session,
            registry,
            unplaced,
            context.frame.stdin_writer,
            context.frame.folder_holders,
        )
    ):
        denied = await guard((), stdin)
        if denied is not None:
            return denied
    try:
        fed_by = context.frame.stdin_writer
        if searched is not None and (
            admitted is None or admitted.route is None
        ):
            writer = (
                await pipe_writer_machine(
                    fed_by,
                    session,
                    registry,
                    unplaced,
                    deps.namespace,
                    deps.dispatch,
                )
                if fed_by is not None
                and unplaced is not None
                and unplaced.machine is None
                else None
            )
            context.frame.routing = await _searched_routing(
                searched,
                argv,
                session,
                registry,
                unplaced,
                prefix_path,
                writer,
            )
        machine = _running_machine(
            name, argv.args, session, registry, context.frame.routing
        )
        preferred = await preferred_machine(
            session,
            registry,
            context.frame.routing,
            fed_by,
            deps.namespace,
            deps.dispatch,
            context.frame.folder_holders,
        )
        caller = current_caller()
        if by_path or handed:
            asking = (
                bind_caller(caller.changed({"preferred_machine": preferred}))
                if preferred != caller.preferred_machine
                else None
            )
            try:
                held, _ = await _held_machine(argv, deps, context, stdin)
            finally:
                if asking is not None:
                    reset_caller(asking)
            machine = (
                machine
                if held is None or held.runtime is None
                else held.runtime.machine
            )
        staged = (
            bind_caller(
                caller.changed(
                    {"machine": machine, "preferred_machine": preferred}
                )
            )
            if (machine, preferred)
            != (caller.machine, caller.preferred_machine)
            else None
        )
        try:
            if runner is not None:
                return await runner(
                    run_redirected, guard, name, tuple(argv.args)
                )
            return await run_redirected(stdin, sink, redirects)
        finally:
            if staged is not None:
                reset_caller(staged)
    finally:
        context.frame.routing = unplaced


async def _matched(
    argv: Argv,
    session: SessionState,
    registry: MountRegistry,
    namespace: Namespace,
) -> Argv:
    """``argv`` with each glob pattern its matches, as bash hands a
    program its words: a mount command keeps patterns for its backend,
    and a program running it elsewhere gets none.

    Args:
        argv (Argv): the command.
        session (SessionState): the session.
        registry (MountRegistry): the mount registry.
        namespace (Namespace): the namespace, for the session's links.
    """
    if not any(isinstance(w, PathSpec) and w.pattern for w in argv.operands):
        return argv
    words = await resolve_globs(
        list(argv.operands),
        registry,
        links=namespace.session_links(session),
        options=glob_options(session),
    )
    return dataclasses.replace(
        argv,
        args=tuple(unmark_globs(word_text(w)) for w in words),
        operands=tuple(words),
    )


def _searched_program(
    name: str,
    args: Sequence[str],
    session: SessionState,
    registry: MountRegistry,
    routing: RouteDecision[RuntimeIdentity] | None,
    links: NamespaceReader,
) -> str | None:
    """The program a command runs that search order places
    (``is_searched``), through the wrappers Mirage runs (``nice gen``)
    and by the ``/usr/bin`` path a lookup prints for it (``bin_program``),
    which names the program past a function of its name;
    None for any other command. It is placed before the command's
    redirects open, since what they make lands on its machine, and once
    the command is admitted: a refused one never reaches a machine.

    Args:
        name (str): the command's name.
        args (Sequence[str]): its words.
        session (SessionState): the session.
        registry (MountRegistry): the mount registry.
        routing (RouteDecision | None): the line's placement.
        links (NamespaceReader): the session's link table.
    """
    if not name or routing is None or routing.machine is not None:
        return None
    typed = program_head(registry, [name, *args], session, routing)
    by_path = "/" in typed
    head = typed
    if by_path:
        head = bin_program(typed, session, registry, links, routing) or typed
    if not is_searched(head, session, registry, routing, by_path):
        return None
    return head


async def _searched_routing(
    program: str,
    argv: Argv,
    session: SessionState,
    registry: MountRegistry,
    routing: RouteDecision[RuntimeIdentity] | None,
    prefix_path: str | None = None,
    writer: str | None = None,
) -> RouteDecision[RuntimeIdentity] | None:
    """A line's placement with a program on the machine search order
    picks for it (``searched_machine``), for the command's run alone;
    the placement as it is where no machine has the program. The
    program is one ``_searched_program`` already found search order
    places, so a function of its name no longer counts.

    Args:
        program (str): the program search order places.
        argv (Argv): the command, whose paths its machine may hold.
        session (SessionState): the session.
        registry (MountRegistry): the mount registry.
        routing (RouteDecision | None): the line's placement.
        prefix_path (str | None): the PATH the command's prefix sets.
        writer (str | None): the machine the program writing the pipe
            it reads runs on; None for no pipe.
    """
    if routing is None:
        return routing
    paths = [
        unmark_globs(w.virtual)
        for w in argv.operands
        if isinstance(w, PathSpec)
    ]
    found = await searched_machine(
        program,
        paths,
        session,
        registry,
        routing,
        path=prefix_path,
        past_functions=True,
        writer=writer,
    )
    return routing if found is None else bound_to(routing, program, found)


def _input_redirected(runner: RedirectRunner | None) -> bool:
    """Whether the command's own redirects give it the input it reads
    (``< f``, a here-document, ``<&3``), which decides whether a machine
    may run it whole (``operand_machine`` keeps a command anything is
    piped into) only once the redirects open.

    Args:
        runner (RedirectRunner | None): the command's redirect runner.
    """
    bound = current_caller().redirects
    if runner is None or bound is None or bound[2] is not runner:
        return False
    return any(r.fd == 0 and r.kind in INPUT_REDIRECTS for r in bound[3])


def _may_run_on_machine(
    name: str,
    argv: Argv,
    session: SessionState,
    registry: MountRegistry,
    routing: RouteDecision[RuntimeIdentity] | None,
) -> bool:
    """Whether a command is one of Mirage's own that a machine may run
    whole (``_held_machine``): a mount command, or a namespace command a
    machine answers. Asked from its words alone, before any machine.

    Args:
        name (str): the command's name.
        argv (Argv): its words.
        session (SessionState): the session it runs in.
        registry (MountRegistry): the workspace's mounts and machines.
        routing (RouteDecision | None): the line's placement.
    """
    if routing is None:
        return False
    consumer = target_consumer(
        resolve_target(name, argv.args, session, registry, routing)
    )
    return consumer is Consumer.MOUNT or (
        consumer is Consumer.NAMESPACE and name in MACHINE_ANSWERED
    )


INPUT_REDIRECTS = frozenset(
    {
        RedirectKind.STDIN,
        RedirectKind.READWRITE,
        RedirectKind.HEREDOC,
        RedirectKind.HERESTRING,
        RedirectKind.DUP_INPUT,
    }
)


def _target_machine(target: ExecutionTarget) -> MachineName | None:
    """The machine a bound command's program runs on: its runtime's, or
    for a program named by a path no machine holds, its fallback's; None
    for a command Mirage runs itself.

    Args:
        target (ExecutionTarget): what ``bind_command`` chose.
    """
    external = target.fallback if isinstance(target, PathTarget) else target
    if not isinstance(external, ExternalTarget) or external.runtime is None:
        return None
    if getattr(external.runtime, "reach", "workspace") == "workspace":
        return None
    return external.runtime.machine


def _pipe_crossing(
    name: str,
    argv: Argv,
    machine: MachineName | None,
    fed_by: PipeWriter | None,
    registry: MountRegistry,
    pinned: bool,
) -> RedirectResult | None:
    """The refusal of a program that would read, on one machine, the
    pipe a program on another machine writes, where Mirage picked the
    machine of either (``gen | sink``, ``sink`` on another machine alone): bytes go
    between a machine and a store, never from one machine to another.
    bash's ``<name>: Permission denied`` at 126, the reason on the
    decision record. None for any other command: one Mirage runs itself,
    one on its writer's machine, a pipe Mirage writes, a writer not
    placed (the line names a machine), and a pipe between two programs
    whose machines the config names (``config_pins``), which streams.

    Args:
        name (str): the command's name.
        argv (Argv): its words.
        machine (MachineName | None): the machine its program runs on.
        fed_by (PipeWriter | None): the program writing the pipe it
            reads.
        registry (MountRegistry): the workspace's mounts and machines.
        pinned (bool): the config, or a policy's route, names the
            program's machine.
    """
    if machine is None or fed_by is None or fed_by.machine is None:
        return None
    if pinned and fed_by.pinned:
        return None
    if fed_by.machine == machine.name or machine.name not in machine_names(
        registry
    ):
        return None
    deny = Deny(crossing_reason(fed_by.machine, machine.name))
    err, code = render_deny(name, deny)
    return _refused(
        " ".join([name, *argv.args]), Refused(err, code, decision_of(deny))
    )


def _running_machine(
    name: str,
    args: Sequence[str],
    session: SessionState,
    registry: MountRegistry,
    routing: RouteDecision[RuntimeIdentity] | None,
) -> MachineName | None:
    """The machine a command's program runs on; None for a command Mirage
    runs itself.

    Args:
        name (str): the command's name.
        args (Sequence[str]): its words.
        session (SessionState): the session.
        registry (MountRegistry): the mount registry.
        routing (RouteDecision | None): the line's placement.
    """
    if not name or routing is None:
        return None
    runtime = program_runtime(registry, [name, *args], session, routing)
    if getattr(runtime, "reach", "workspace") == "workspace":
        return None
    return None if runtime is None else runtime.machine


async def _held_machine(
    argv: Argv,
    deps: ExecuteNodeDeps,
    context: EvaluationContext,
    stdin: ByteSource | None,
    consumer: Consumer | None = None,
) -> tuple[ExternalTarget | None, Argv]:
    """The machine holding the program path or every operand, including
    each glob match, and the folder it runs from there. Return its
    matched argv when it can run there whole.

    Args:
        argv (Argv): the command.
        deps (ExecuteNodeDeps): the registry, namespace and dispatcher.
        context (EvaluationContext): the session and current placement.
        stdin (ByteSource | None): input to the program.
        consumer (Consumer | None): the selected layer. Redirect staging
            precedes final binding and asks under its own placement.
    """
    name = argv.name
    placed = context.frame.routing
    session = context.session
    registry = deps.registry
    namespace = deps.namespace
    if placed is None:
        return None, argv
    if "/" in name:
        held = await program_machine(
            name,
            session,
            registry,
            namespace.session_links(session),
            deps.dispatch,
            stdin,
            placed.machine,
            [
                unmark_globs(w.virtual)
                for w in argv.operands
                if isinstance(w, PathSpec)
            ],
        )
        return (None if held is None else ExternalTarget(held)), argv
    if consumer is None:
        consumer = target_consumer(
            resolve_target(name, argv.args, session, registry, placed)
        )
    if not (
        consumer is Consumer.MOUNT
        or (consumer is Consumer.NAMESPACE and name in MACHINE_ANSWERED)
    ):
        return None, argv
    links = namespace.session_links(session)
    machine = await operand_machine(argv, session, registry, links, stdin)
    if machine is None:
        asked = await fact_machine(
            argv,
            session,
            registry,
            links,
            placed,
            stdin,
            context.frame.folder_holders,
        )
        return asked, argv
    matched = await _matched(argv, session, registry, namespace)
    if matched is not argv:
        machine = await operand_machine(
            matched, session, registry, links, stdin
        )
    return machine, matched


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


async def _run_namespace_program(
    program: NamespaceProgram,
    namespace: Namespace,
    made: DispatchFn,
    registry: MountRegistry,
    session: SessionState,
    operands: list[str | PathSpec],
    stdin: ByteSource | None,
    links_elsewhere: (
        Callable[[list[LinkPlan], LnFlags], Awaitable[RedirectResult | None]]
        | None
    ) = None,
) -> RedirectResult:
    """Run the selected program above the mounts.

    Args:
        program (NamespaceProgram): the selected operation.
        namespace (Namespace): the link table.
        made (DispatchFn): the dispatcher the program's ops go through.
        registry (MountRegistry): the mounts.
        session (SessionState): the session.
        operands (list[str | PathSpec]): its operands.
        stdin (ByteSource | None): its input.
        links_elsewhere (Callable | None): runs a whole ``ln`` where its
            links land, None to keep it here.
    """
    # ── symlinks (namespace-backed; not bash builtins, not mount
    #    commands: they mutate the addressing layer) ──
    if program is NamespaceProgram.LN:
        return await handle_ln(
            namespace, made, session, operands, links_elsewhere
        )

    if program is NamespaceProgram.READLINK:
        return await handle_readlink(namespace, made, session, operands)

    # ── extended attributes (the namespace's node table and the backend's
    #    own facts; they read -h themselves) ──
    if program is NamespaceProgram.GETFATTR:
        return await handle_getfattr(namespace, made, session, operands)
    if program is NamespaceProgram.SETFATTR:
        return await handle_setfattr(made, session, operands, stdin)

    # ── metadata commands (namespace-routed: resolve-then-setattr with
    #    overlay fallback; they run their own link follow) ──
    if program is NamespaceProgram.CHMOD:
        return await handle_chmod(namespace, made, session, operands)
    if program is NamespaceProgram.CHOWN:
        return await handle_chown(namespace, made, session, operands)
    if program is NamespaceProgram.CHGRP:
        return await handle_chgrp(namespace, made, session, operands)
    if program is NamespaceProgram.TOUCH:
        return await handle_touch(namespace, made, session, operands)

    # ── capacity (registry-routed: enumerates mounts, reports per-mount
    #    capacity; never fabricates numbers) ──
    if program is NamespaceProgram.DF:
        return await handle_df(registry, session, made, operands)
    if program is NamespaceProgram.MOUNT:
        return await handle_mount(registry, session, operands)
    assert_never(program)


async def _strip_links(
    name: str,
    argv: Argv,
    operands: list[str | PathSpec],
    dispatch: DispatchFn,
    namespace: Namespace,
    session: SessionState,
) -> tuple[list[str | PathSpec], list[str], RedirectResult | None]:
    """Act on the link operands ``rm``, ``unlink`` and ``mv`` name.

    Args:
        name (str): the command.
        argv (Argv): its words.
        operands (list[str | PathSpec]): its operands.
        dispatch (DispatchFn): the op dispatcher.
        namespace (Namespace): the link table.
        session (SessionState): the session.

    Returns:
        The operands left, the refused links' lines, and the answer when
        no operand is left for the command.
    """
    link_errors: list[str] = []
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
                name,
                dispatch,
                namespace.session_links(session),
                operands,
                argv.args,
                session.cwd,
            )
            if handled and not any(isinstance(a, PathSpec) for a in operands):
                if not link_errors:
                    return (
                        operands,
                        link_errors,
                        (
                            None,
                            IOResult(),
                            ExecutionNode(command=name, exit_code=0),
                        ),
                    )
                err = encode_text("".join(link_errors))
                return (
                    operands,
                    link_errors,
                    (
                        None,
                        IOResult(exit_code=1, stderr=err),
                        ExecutionNode(command=name, exit_code=1, stderr=err),
                    ),
                )
        elif name == "mv":
            operands, early = await prepare_mv(
                namespace.session_links(session),
                dispatch,
                operands,
                argv.args,
                session.cwd,
            )
            if early is not None:
                return operands, link_errors, early
    except CycleError as exc:
        err = encode_text(f"{name}: {exc.filename}: {exc.strerror}\n")
        return (
            operands,
            link_errors,
            (
                None,
                IOResult(exit_code=1, stderr=err),
                ExecutionNode(command=name, exit_code=1, stderr=err),
            ),
        )
    return operands, link_errors, None


async def _purge_removed(
    namespace: Namespace,
    operands: list[str | PathSpec],
    unseen: tuple[dict[str, frozenset[str]], frozenset[str]],
) -> None:
    """Drop the node meta of what ``rm`` removed.

    A removed path takes its node meta (overlay attrs) with it; a
    removed dir purges everything underneath. Glob operands reach here
    unexpanded (backend wrappers expand them), so the node table matches
    the pattern itself. A name the session cannot see was never removed:
    rm met it as absent (-f silenced that), so its node stays.

    Args:
        namespace (Namespace): the node table.
        operands (list[str | PathSpec]): rm's operands.
        unseen (tuple): what the session could not see of them.
    """
    kept, hidden = unseen
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
            pattern = glob_pattern(item.virtual)
            await namespace.unlink_glob(
                pattern, keep=kept.get(pattern, frozenset())
            )
        elif item.virtual not in hidden:
            await namespace.unlink(item.virtual)
            await namespace.purge_under(item.virtual)


def _refused(
    command: str, verdict: Refused
) -> tuple[None, IOResult, ExecutionNode]:
    """A command the gate refused, as its run answers it.

    Args:
        command (str): the command line as run.
        verdict (Refused): the gate's refusal.
    """
    return (
        None,
        IOResult(
            exit_code=verdict.exit_code,
            stderr=verdict.stderr,
            decision=verdict.decision,
        ),
        ExecutionNode(
            command=command,
            exit_code=verdict.exit_code,
            stderr=verdict.stderr,
            refused=True,
        ),
    )


def _unreadable(name: str, session: SessionState) -> Refused | None:
    """A closed profile's refusal of what only the machine can resolve (a
    path, a line run under the box): a tree that denies by default names
    only what the gate can read. None under any other profile.

    Args:
        name (str): the word refused.
        session (SessionState): the session running the line.
    """
    if not closed_by_default(session.commands):
        return None
    deny = Deny(UNREADABLE_LINES)
    err, code = render_deny(name, deny)
    return Refused(err, code, decision_of(deny))


async def _wrapped_verdict(
    words: Sequence[Word],
    session: SessionState,
    registry: MountRegistry,
    namespace: Namespace,
    stdin: ByteSource | None,
    cancel: asyncio.Event | None,
    claimant: Claimant | None,
) -> Refused | list[Route]:
    """The gate's answer on the programs a wrapper runs where Mirage
    cannot see them run (``nohup python3`` on a machine). What the words
    run is followed as the line's pass follows it (``program_lines``):
    each program is admitted as ``env`` and ``timeout`` have theirs
    admitted, at the place the pass judged it, and a line the gate
    cannot read (``nohup /opt/bin/env``) is refused under a closed tree.
    The machine runs the program itself, so a function of its name does
    not stand in for it. A program spelled by its ``/usr/bin`` path is
    admitted under its name too, as the plain path admits it.

    Args:
        words (Sequence[Word]): the command running the others, name
            first.
        session (SessionState): the session running the line.
        registry (MountRegistry): registry holding the policies.
        namespace (Namespace): the link table.
        stdin (ByteSource | None): the command's stdin.
        cancel (asyncio.Event | None): the run's kill channel.
        claimant (Claimant | None): the command and its line.

    Returns:
        The first refusal, else every route a policy answered for them.
    """
    routes: list[Route] = []
    links = namespace.session_links(session)
    for inner in program_lines(words, session, registry, links):
        if not inner.argv:
            # shortcut: a line run under the box (`time sh -c`) is not judged.
            unread = _unreadable(words[0].value, session)
            if unread is not None:
                return unread
            continue
        name, args = inner.argv[0].value, [w.value for w in inner.argv[1:]]
        place = (
            Claimant(
                claimant.line,
                whole_occurrence(
                    argv_frame([name, *args], claimant.occurrence)
                ),
            )
            if claimant is not None
            else None
        )
        view = session
        if name in session.functions:
            view = session.fork()
            view.functions.pop(name)
        operands = await classified_words(name, args, view, registry)
        verdict = await admit(
            name,
            args,
            operands[1:],
            session,
            registry,
            namespace,
            stdin,
            cancel=cancel,
            claimant=place,
            intrinsic=True,
        )
        if isinstance(verdict, Refused):
            return verdict
        if verdict.route is not None:
            routes.append(verdict.route)
        deeper = await _wrapped_verdict(
            inner.argv,
            session,
            registry,
            namespace,
            stdin,
            cancel,
            place,
        )
        if isinstance(deeper, Refused):
            return deeper
        routes.extend(deeper)
    return routes


async def bind_command(
    argv: Argv,
    deps: ExecuteNodeDeps,
    context: EvaluationContext,
    stdin: ByteSource | None,
    lifetime: ExitStack,
) -> ResolvedCommand[ExecutionTarget]:
    """Select this invocation's worker inside its admitted placement.

    Args:
        argv (Argv): the admitted words.
        deps (ExecuteNodeDeps): the registrations and file operations.
        context (EvaluationContext): the session and final placement.
        stdin (ByteSource | None): input for operand-dependent routing.
        lifetime (ExitStack): holds the selected CLI until dispatch returns.
    """
    session = context.session
    registry = deps.registry
    placed = context.frame.routing
    name = argv.name

    if "/" in name:
        held, _ = await _held_machine(argv, deps, context, stdin)
        if held is not None:
            return ResolvedCommand(argv, held)
        absent = None
        if placed is not None and name.startswith("/"):
            target = resolve_target(name, argv.args, session, registry, placed)
            if (
                isinstance(target, ExternalTarget)
                and target.runtime is not None
            ):
                absent = target
        return ResolvedCommand(argv, PathTarget(absent))

    # ── unsupported bash builtins ──────────────
    # Constructs the parser accepts but the executor cannot honor.
    # Returning a clear error lets LLMs detect a capability gap instead
    # of treating it as a missing binary or a silent no-op; `bg` and `fg`
    # say what bash -c says, which has no job control either.
    if name in UNSUPPORTED_BUILTINS:
        helped = flag_help(name) if argv.args[:1] == ("--help",) else None
        if helped is not None:
            return ResolvedCommand(argv, helped)
        return ResolvedCommand(argv, "unsupported")

    target = resolve_target(name, argv.args, session, registry, placed)
    consumer = target_consumer(target)
    if runs_wrapper(name, argv.args, session, registry, placed, consumer):
        return ResolvedCommand(argv, "wrapper")
    if isinstance(target, ExternalTarget):
        assert placed is not None
        return ResolvedCommand(argv, target)
    if isinstance(target, FunctionTarget):
        return ResolvedCommand(argv, target)

    # A CLI is selected and retained without yielding to its uninstaller.
    if not isinstance(target, CliTarget):
        held, matched = await _held_machine(
            argv, deps, context, stdin, consumer
        )
        if held is not None:
            return ResolvedCommand(matched, held)

    if argv.args[:1] == ("--help",) and not is_program_invocation(session):
        answered = flag_help(name)
        if answered is not None:
            return ResolvedCommand(argv, answered)
    builtin = BUILTINS.get(name)
    if builtin is not None:
        return ResolvedCommand(argv, builtin)
    program = NAMESPACE_PROGRAMS.get(name)
    if program is not None:
        return ResolvedCommand(argv, program)

    bindings = registry.runtime_bindings if placed is None else placed.bindings
    handler = command_worker(argv, bindings)
    if handler is not None:
        return ResolvedCommand(argv, WorkerTarget(handler))
    if isinstance(target, CliTarget):
        lifetime.callback(target.install.activity.acquire())
        return ResolvedCommand(argv, target)
    if target is Consumer.UNKNOWN:
        # A machine-only builtin known at install time still tries its mount
        # implementation when a workspace route removes the last machine.
        if name not in MACHINE_ONLY_BUILTINS or not runs_programs(
            registry.runtime_bindings
        ):
            return ResolvedCommand(argv, Consumer.UNKNOWN)
    wrapper = EXEC_WRAPPERS[name] if runs_as(name, registry) != name else None
    return ResolvedCommand(argv, MountTarget(wrapper))


async def run_resolved(
    deps: ExecuteNodeDeps,
    recurse: Callable[..., Awaitable[RedirectResult]],
    command: ResolvedCommand[ExecutionTarget],
    context: EvaluationContext,
    stdin: ByteSource | None,
    call_stack: CallStack | None,
    row: int,
) -> RedirectResult:
    """Run the bound action, following operands only at their execution stage."""
    argv = command.argv
    target = command.target
    dispatch = deps.dispatch
    registry = deps.registry
    namespace = deps.namespace
    execute_fn = deps.execute_fn
    sink = deps.sink
    session = context.session
    name = argv.name
    operands = list(argv.operands)
    routing = context.frame.routing

    if isinstance(target, tuple):
        return target
    if target == "unsupported":
        code = 1 if name in ("bg", "fg") else 2
        why = "no job control" if name in ("bg", "fg") else "not supported"
        err = encode_text(f"{shell_voice()}{name}: {why}\n")
        return (
            None,
            IOResult(exit_code=code, stderr=err),
            ExecutionNode(command=name, exit_code=code, stderr=err),
        )
    if isinstance(target, ExternalTarget):
        unread = _unreadable(name, session) if "/" in name else None
        if unread is not None:
            return _refused(" ".join([name, *argv.args]), unread)
        return await run_external(
            argv, stdin, session, registry, target.runtime, sink, target.cwd
        )
    if isinstance(target, PathTarget):
        absent = target.fallback

        async def on_the_runtime() -> RedirectResult:
            assert absent is not None and routing is not None
            unread = _unreadable(name, session)
            if unread is not None:
                return _refused(" ".join([name, *argv.args]), unread)
            program = bin_program(
                name,
                session,
                registry,
                namespace.session_links(session),
                routing,
            )
            if program is None:
                return await run_external(
                    argv, stdin, session, registry, absent.runtime, sink
                )
            marked = set_program_invocation(session, f"{shell_voice()}{name}")
            try:
                return await run_external(
                    dataclasses.replace(argv, name=program, prefix=()),
                    stdin,
                    session,
                    registry,
                    external_target(program, routing.bindings).runtime,
                    sink,
                )
            finally:
                reset_caller(marked)

        return await handle_exec_path(
            deps,
            name,
            list(argv.args),
            context,
            stdin,
            call_stack,
            on_the_runtime if absent is not None else None,
        )

    if target == "wrapper":
        return handle_wrapper(
            execute_fn,
            name,
            argv.args,
            session,
            registry,
            stdin,
            routing,
            sink,
        )

    if callable(target):
        try:
            return await target(
                BuiltinCall(
                    argv=argv,
                    context=context,
                    stdin=stdin,
                    call_stack=call_stack,
                    cancel=deps.cancel,
                    row=row,
                    dispatch=dispatch,
                    registry=registry,
                    namespace=namespace,
                    execute_fn=execute_fn,
                    sink=sink,
                    job_table=deps.job_table,
                )
            )
        except ArithError as exc:
            # A value a builtin stores into an `-i` name did not
            # evaluate: bash discards the line in that builtin's voice
            # (`bash: getopts: ?: syntax error: ...`).
            raise exc.signal(name, fatal=True) from exc

    # ── pathname resolution (POSIX, `operand_follow`), ahead of every
    #    handler below because the kernel resolves a path before the
    #    syscall, not inside it. An operand a link loop stands in comes
    #    back refused (`walk_error`) rather than failing the line: the
    #    command meets ELOOP at its op and words it per operand.
    if namespace.nodes and operands:
        operands = await operand_follow(
            namespace.session_links(session),
            dispatch,
            name,
            argv.words,
            session.cwd,
        )(operands)
        argv = argv.with_operands(operands)

    # The programs below run here rather than on a mount, and every op
    # one issues is the program's, as a mount command's is: a rule scoped
    # to it reaches what ``chmod -R`` walks into, not only its operands.
    if isinstance(target, NamespaceProgram):
        made = made_by_command(dispatch)

        async def ln_on_machine(
            plans: list[LinkPlan], flags: LnFlags
        ) -> RedirectResult | None:
            # Links landing in one machine's own folder are made there, so
            # its programs follow them.
            if routing is None:
                return None
            on_machine = await link_machine(
                [
                    (
                        plan.link_abs,
                        resolve_path(
                            word_text(plan.source),
                            parent(plan.link_abs)
                            if flags.symbolic
                            else session.cwd,
                        ),
                    )
                    for plan in plans
                ],
                flags.symbolic,
                session,
                registry,
                namespace.session_links(session),
                all(
                    plan.link_typed.startswith("/")
                    and (
                        flags.symbolic
                        or word_text(plan.source).startswith("/")
                    )
                    for plan in plans
                ),
            )
            if on_machine is None:
                return None
            return await run_external(
                argv,
                None,
                session,
                registry,
                on_machine.runtime,
                sink,
                on_machine.cwd,
            )

        return await _run_namespace_program(
            target,
            namespace,
            made,
            registry,
            session,
            operands,
            stdin,
            ln_on_machine,
        )

    # ── symlink-aware dispatch: reads follow links (open(2)); rm/mv act
    #    on the link entry itself (lstat semantics) ──
    link_errors: list[str] = []
    if namespace.nodes:
        operands, link_errors, early = await _strip_links(
            name, argv, operands, dispatch, namespace, session
        )
        if early is not None:
            return early
        argv = argv.with_operands(operands)

    # What rm's bookkeeping may drop is read before rm runs: removing a
    # directory can leave a hidden link dangling, which the session
    # would see afterwards, though rm met it as absent.
    unseen = (
        _rm_unseen(namespace, session, operands)
        if name == "rm" and namespace.nodes
        else ({}, frozenset())
    )

    # ── mount command (default) ─────────────────
    stdout, io, exec_node = await handle_command(
        deps,
        recurse,
        ResolvedCommand(argv, target),
        context,
        stdin,
        call_stack,
    )

    if link_errors:
        stdout = await materialize(stdout)

    if io.exit_code == 0 and namespace.nodes:
        if name == "rm":
            await _purge_removed(namespace, operands, unseen)
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

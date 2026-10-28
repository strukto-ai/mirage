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
from functools import partial
from itertools import accumulate
from typing import Any, TypeVar

from mirage.commands.builtin.utils.limit import (
    guard_io,
)
from mirage.context import (
    RedirectRunner,
    bind_caller,
    current_caller,
    note_refusal,
    program_invocation,
    redirect_paths_for,
    redirect_runner_for,
    reset_caller,
    reset_redirect_paths,
    set_redirect_paths,
)
from mirage.context.session_context import RedirectResult, redirect_syntax_for
from mirage.io import IOResult
from mirage.io.types import ByteSource, OutputState, materialize
from mirage.observe.context import command_records
from mirage.policy import (
    CommandResultContext,
    PolicyDenied,
    post_command_gate,
    refusal_of,
    render_deny,
    resolve_producer,
)
from mirage.policy.types import Claimant, HandOff, SessionContext
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import decode_text, encode_text
from mirage.shell.call_stack import CallStack
from mirage.shell.console import Channel, JobConsole
from mirage.shell.constants import CANNOT_EXECUTE_STATUS
from mirage.shell.errors import (
    ArithError,
    DiscardSignal,
    ExitSignal,
    TooManyMatches,
)
from mirage.shell.helpers import (
    ALIAS_WORD_TYPES,
    get_command_name,
    get_parts,
    get_text,
    read_row,
    split_env_prefix,
)
from mirage.shell.job_table import JobTable
from mirage.shell.parse.constants import WORD_BREAKS
from mirage.shell.parse.parse import syntax_refusal
from mirage.shell.parse.scope import ParseScope
from mirage.shell.types import AliasExpansion, TSNodeLike
from mirage.shell.types import NodeType as NT
from mirage.shell.variable import TempEnv, VarAttr
from mirage.shell.xtrace import trace_command
from mirage.types import PathSpec, Producer, word_text
from mirage.utils.glob_walk import glob_pattern
from mirage.utils.path import CycleError, glob_prefix_match
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
    operand_follow,
    prepare_mv,
    strip_link_operands,
)
from mirage.workspace.executor.builtins.alias import (
    alias_command_text,
    alias_mark,
    expanding_aliases,
)
from mirage.workspace.executor.builtins.table import BUILTINS
from mirage.workspace.executor.builtins.types import BuiltinCall
from mirage.workspace.executor.command import handle_command
from mirage.workspace.executor.command.command import (
    fill_tree_env,
    made_by_command,
)
from mirage.workspace.executor.command.external import run_external
from mirage.workspace.executor.command.handler import argument_list_too_long
from mirage.workspace.expand import expand_node
from mirage.workspace.expand.argv import Argv, expand_argv
from mirage.workspace.expand.globs import expand_boundary_globs
from mirage.workspace.expand.types import ExecuteFn
from mirage.workspace.lookup import (
    UNSUPPORTED_BUILTINS,
    Consumer,
    lookup,
    runtime_refused,
)
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.node.admission import (
    Admitted,
    Refused,
    admit,
    classified_words,
)
from mirage.workspace.node.occurrence import claimant_for, evaluated_from
from mirage.workspace.node.types import ExpandedWords
from mirage.workspace.session import SessionState
from mirage.workspace.session.state import (
    ensure_var_visible,
    gate_rendering,
    post_session_gate,
    pre_session_gate,
    seed_var,
    session_view,
    set_attr,
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


async def execute_command(
    recurse: Callable[..., Awaitable[RedirectResult]],
    dispatch: DispatchFn,
    registry: MountRegistry,
    namespace: Namespace,
    execute_fn: ExecuteFn,
    node: TSNodeLike,
    context: EvaluationContext,
    stdin: ByteSource | None,
    call_stack: CallStack | None,
    job_table: JobTable,
    cancel: asyncio.Event | None = None,
    handed: HandOff | None = None,
    sink: JobConsole | None = None,
    expanded: ExpandedWords | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Dispatch a command node by name.

    ``sink`` is where a command that runs statements of its own (a
    function body, a nested shell) writes them as they finish, and
    ``expanded`` is filled with the words the command expanded to, so
    its caller knows what the head ran as.
    """
    session = context.session
    name = get_command_name(node)
    assignment_nodes, parts = split_env_prefix(get_parts(node))

    # ── alias expansion ─────────────────────────
    # bash rewrites the head word of a simple command before any other
    # expansion, textually, and reads the result as a fresh line: an
    # alias holding a pipe is a pipe. Only an unquoted plain word
    # qualifies (`\x` and `'x'` are never aliases), and `alias_value`
    # applies the rest of bash's rules (the aliases and expand_aliases as
    # the command's read found them, the guards on inserted text). The
    # rewritten line runs through the same executor with the same call
    # stack, so `$1` inside a function still means the function's
    # argument. A line run as a program (`exec`, `env`, `find -exec`) is
    # an argv, which no alias rewrites.
    if (
        (session.aliases or session._alias_view or session._alias_marks)
        and not program_invocation(session)
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
                io = syntax_refusal(ast)
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
                session._alias_expansion = AliasExpansion(
                    ast.id,
                    tuple(mapped[i] for i in getattr(ast, "offsets", ())),
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
                    reset_redirect_paths(token)
                    session._alias_expansion = previous
                    if expansion is not None:
                        registry.decisions.hand_up(
                            session.session_id, expansion
                        )
            finally:
                scope.release()

    prefix_assignments: list[tuple[str, str]] = []
    view = session_view(
        session, registry.policies, diagnostics=context.frame.diagnostics
    )
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
        if name and view.is_readonly(key, False):
            refused += encode_text(f"bash: {key}: readonly variable\n")
            continue
        val_nodes = [c for c in p.named_children if c.type != NT.VARIABLE_NAME]
        if val_nodes:
            v = await _own_words(
                node,
                expand_node(
                    val_nodes[0], context, execute_fn, call_stack, view=view
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
            # entry point, so this loop is the only place the rule can be
            # asked.
            await pre_session_gate(
                registry.policies,
                SessionContext(
                    verb="set",
                    key=k,
                    value=v,
                    session_id=session.session_id,
                ),
            )
        except PolicyDenied as exc:
            return _write_refused(exc, name or k)
        if k in session.readonly_vars:
            raise DiscardSignal(encode_text(f"bash: {k}: readonly variable\n"))

    async def judge_landed(olds: Mapping[str, Any]) -> None:
        # `post_session` asks about each prefix write once it landed.
        for k, v in prefix_assignments:
            old = olds.get(k)
            await post_session_gate(
                registry.policies,
                SessionContext(
                    verb="set",
                    key=k,
                    value=v,
                    session_id=session.session_id,
                ),
                None if old is None else gate_rendering(old.value),
            )

    def restore(saved: Mapping[str, Any]) -> None:
        for k, prev in saved.items():
            if prev is None:
                session.vars.pop(k, None)
            else:
                session.vars[k] = prev

    if prefix_assignments and not name:
        olds = {k: session.vars.get(k) for k, _ in prefix_assignments}
        for k, v in prefix_assignments:
            seed_var(session, k, v)
        try:
            await judge_landed(olds)
        except PolicyDenied as exc:
            restore(olds)
            return _write_refused(exc, name)
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

    saved_env_overrides = TempEnv()

    async def seed_prefix(command: str) -> None:
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
        # Judged before the command reads them; on a refusal the
        # restore below puts the old values back.
        await judge_landed(saved_env_overrides)

    if refused and sink is not None:
        await sink.emit(Channel.STDERR, refused)
        refused = b""
    settling: OutputState | None = None
    try:
        stdout, io, exec_node = await _dispatch_command_body(
            recurse,
            dispatch,
            registry,
            namespace,
            execute_fn,
            node,
            parts,
            context,
            stdin,
            call_stack,
            job_table,
            seed_prefix,
            cancel,
            handed,
            sink,
            expanded,
            assigned=frozenset(k for k, _ in prefix_assignments),
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
        frames = session._local_frames
        if frames and frames[-1] is saved_env_overrides:
            frames.pop()
        if settling is not None:
            settling.callbacks.append(partial(restore, saved_env_overrides))
        else:
            restore(saved_env_overrides)


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
    """A prefix assignment a session policy refused: bash's line, exit 1.

    Args:
        exc (PolicyDenied): the refusal.
        command (str): the command the assignment prefixed.
    """
    err = encode_text(f"bash: {exc.strerror}\n")
    return (
        None,
        IOResult(exit_code=1, stderr=err),
        ExecutionNode(command=command, exit_code=1, stderr=err),
    )


async def _dispatch_command_body(
    recurse: Callable[..., Awaitable[RedirectResult]],
    dispatch: DispatchFn,
    registry: MountRegistry,
    namespace: Namespace,
    execute_fn: ExecuteFn,
    node: TSNodeLike,
    parts: list[TSNodeLike],
    context: EvaluationContext,
    stdin: ByteSource | None,
    call_stack: CallStack | None,
    job_table: JobTable,
    seed_prefix: Callable[[str], Awaitable[None]],
    cancel: asyncio.Event | None = None,
    handed: HandOff | None = None,
    sink: JobConsole | None = None,
    expanded: ExpandedWords | None = None,
    assigned: frozenset[str] = frozenset(),
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    # The command's place on the line, as the pass computed it, and
    # the entry point its nested evaluations re-enter through: a word that
    # runs a line (eval, source, xargs) is bound to this node, and a
    # substitution names its own node when it calls, so every nested
    # line stands under the node its text came from.
    session = context.session
    claimant = claimant_for(node, handed)
    execute_fn = partial(execute_fn, node=node)

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
        ),
    )
    if expanded is not None:
        expanded.words = (argv.name, *argv.args)

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
        row=read_row(node),
        redirects=redirect_paths_for(node.id),
        runner=redirect_runner_for(node.id),
        seed_prefix=seed_prefix,
        claimant=claimant,
        sink=sink,
        assigned=assigned,
    )
    # Capture xtrace before the body runs so `set -x` itself is not
    # traced (bash enables tracing only for the following commands).
    # A body that writes as it runs is traced before it starts.
    xtrace = bool(session.shell_options.get("xtrace")) and bool(argv.name)
    if xtrace and sink is not None:
        await sink.emit(Channel.STDERR, trace_command([argv.name, *argv.args]))
        xtrace = False
    stdout, io, exec_node = await body
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
    recurse: Callable[..., Awaitable[RedirectResult]],
    dispatch: DispatchFn,
    registry: MountRegistry,
    namespace: Namespace,
    execute_fn: ExecuteFn,
    argv: Argv,
    context: EvaluationContext,
    stdin: ByteSource | None,
    call_stack: CallStack | None,
    job_table: JobTable,
    cancel: asyncio.Event | None = None,
    row: int = 0,
    redirects: tuple[PathSpec, ...] = (),
    runner: RedirectRunner | None = None,
    seed_prefix: Callable[[str], Awaitable[None]] | None = None,
    claimant: Claimant | None = None,
    sink: JobConsole | None = None,
    assigned: frozenset[str] = frozenset(),
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Route one expanded command to its builtin or mount handler.

    ``row`` is the row the shell began reading the command on within its
    parse (``read_row``), which only ``alias``, ``unalias`` and ``shopt``
    read: the commands of one read keep the aliases it began with.
    ``redirects`` are the statement's expanded
    redirect targets, judged with the line because their I/O runs on
    the shell's own fds outside the admitted command's gate window, and
    ``runner`` applies redirects after word expansion, gating each open.
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
        words = classified_words(name, list(argv.args), session, registry)
        argv = dataclasses.replace(argv, operands=tuple(words[1:]))

    admitted: Admitted | None = None
    # What the last admission was asked about: the redirect layer admits
    # each target before it opens it, and then the run admits the whole
    # statement, so the policies are asked again only for a target they
    # have not seen.
    asked: tuple[bool | str, ...] | None = None

    async def guard(
        paths: tuple[PathSpec, ...], given: ByteSource | None
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
        return None

    async def run_redirected(
        given: ByteSource | None,
        output: JobConsole | None,
        paths: tuple[PathSpec, ...],
    ) -> RedirectResult:
        if seed_prefix is not None:
            try:
                await seed_prefix(name)
            except PolicyDenied as exc:
                return _write_refused(exc, name)
        refusal = await guard(paths, given)
        if refusal is not None:
            return refusal
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
            dataclasses.replace(
                outer,
                gate=admitted if admitted is not None else outer.gate,
                command=argv.name,
                declared=None,
            )
        )
        try:
            with command_records(own=True) as mine:
                result = await _route_argv(
                    recurse,
                    dispatch,
                    registry,
                    namespace,
                    execute_fn,
                    argv,
                    context,
                    given,
                    call_stack,
                    job_table,
                    cancel,
                    row,
                    claimant.line if claimant is not None else None,
                    output,
                )
        finally:
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
        # stderr, the refusal record.
        async def settle() -> None:
            # A function hands back its last command's node, which keeps
            # the records that command made.
            node.exit_code = io.exit_code
            node.records.extend(mine)
            late = io.stderr
            if (
                node.stderr is saved
                and isinstance(early, bytes)
                and isinstance(late, bytes)
                and late.startswith(early)
            ):
                node.stderr += late[len(early) :]
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
                    stderr=stderr.decode(errors="replace"),
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
            io.refusal = refusal_of(action)
            if io.refusal is not None:
                note_refusal(io.refusal)

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

    if runner is not None:
        return await runner(run_redirected, guard, name, tuple(argv.args))
    return await run_redirected(stdin, sink, redirects)


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
    recurse: Callable[..., Awaitable[RedirectResult]],
    dispatch: DispatchFn,
    registry: MountRegistry,
    namespace: Namespace,
    execute_fn: ExecuteFn,
    argv: Argv,
    context: EvaluationContext,
    stdin: ByteSource | None,
    call_stack: CallStack | None,
    job_table: JobTable,
    cancel: asyncio.Event | None,
    row: int,
    handed: HandOff | None = None,
    sink: JobConsole | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
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

    routing = context.frame.routing
    consumer = lookup(name, session, registry, routing)
    if consumer is Consumer.EXTERNAL:
        assert routing is not None
        return await run_external(
            argv, stdin, session, registry, routing, sink
        )

    # ── shell builtins ──────────────────────────
    # One lookup: every executor-run builtin word maps to a handler that
    # takes the whole invocation, so the arms live beside their workers
    # (builtins/<word>/) rather than here. Job builtins and the
    # interpreters are not in the table; they route below.
    builtin = BUILTINS.get(name)
    if builtin is not None:
        try:
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
            namespace.session_links(session), dispatch, name, argv.words
        )(operands)
        argv = argv.with_operands(operands)

    # The programs below run here rather than on a mount, and every op
    # one issues is the program's, as a mount command's is: a rule scoped
    # to it reaches what ``chmod -R`` walks into, not only its operands.
    made = made_by_command(dispatch)

    # ── symlinks (namespace-backed; not bash builtins, not mount
    #    commands: they mutate the addressing layer) ──
    if name == "ln":
        return await handle_ln(namespace, made, session, operands)

    if name == "readlink":
        return await handle_readlink(namespace, made, session, operands)

    # ── extended attributes (the namespace's node table and the backend's
    #    own facts; they read -h themselves) ──
    if name == "getfattr":
        return await handle_getfattr(namespace, made, session, operands)
    if name == "setfattr":
        return await handle_setfattr(made, session, operands)

    # ── metadata commands (namespace-routed: resolve-then-setattr with
    #    overlay fallback; they run their own link follow) ──
    if name == "chmod":
        return await handle_chmod(namespace, made, session, operands)
    if name == "chown":
        return await handle_chown(namespace, made, session, operands)
    if name == "chgrp":
        return await handle_chgrp(namespace, made, session, operands)
    if name == "touch":
        return await handle_touch(namespace, made, session, operands)

    # ── capacity (registry-routed: enumerates mounts, reports per-mount
    #    capacity; never fabricates numbers) ──
    if name == "df":
        return await handle_df(registry, session, made, operands)
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
                    name,
                    dispatch,
                    namespace.session_links(session),
                    operands,
                    argv.args,
                    session.cwd,
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
                    namespace.session_links(session),
                    dispatch,
                    operands,
                    argv.args,
                    session.cwd,
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
        recurse,
        dispatch,
        registry,
        argv.words,
        context,
        stdin,
        call_stack,
        job_table=job_table,
        namespace=namespace,
        execute_fn=execute_fn,
        handed=handed,
        sink=sink,
    )

    if link_errors:
        stdout = await materialize(stdout)

    if io.exit_code == 0 and namespace.nodes:
        if name == "rm":
            # A removed path takes its node meta (overlay attrs) with it;
            # a removed dir purges everything underneath. Glob operands
            # reach here unexpanded (backend wrappers expand them), so
            # the node table matches the pattern itself. A name the
            # session cannot see was never removed: rm met it as absent
            # (-f silenced that), so its node stays.
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

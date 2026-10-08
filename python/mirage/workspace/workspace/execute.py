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
import logging
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from functools import partial
from typing import Any

from mirage.commands.errors import CommandTimeoutError
from mirage.context import (
    get_current_evaluation,
    reset_refusal_sink,
    set_current_evaluation,
    set_refusal_sink,
)
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.observe.context import RecordingScope, active_records
from mirage.observe.observer import Observer
from mirage.observe.record import READ_FINGERPRINT_OPS, OpRecord
from mirage.policy import Deny, HandOff
from mirage.process.supervisor import ProcessSupervisor
from mirage.runtime.routing import RouteDecision, RouteError
from mirage.runtime.types import DispatchFn
from mirage.secrets.types import ResolvedSource
from mirage.shell.call_stack import CallStack
from mirage.shell.console import Channel, JobConsole, Terminal
from mirage.shell.constants import FORK_FAILED, FORK_FAILED_STATUS
from mirage.shell.errors import DiscardSignal, ExitSignal
from mirage.shell.helpers import input_substitution_redirect
from mirage.shell.job_table import JobTable, JobWaits
from mirage.shell.literal import literal_tree
from mirage.shell.parse import check_syntax, syntax_error_result
from mirage.shell.parse.scope import ParseScope
from mirage.shell.parse.syntax import find_syntax_issue
from mirage.shell.types import NodeType as NT
from mirage.shell.types import TSNodeLike
from mirage.types import PathSpec, Refusal
from mirage.workspace.abort import (
    MirageAbortError,
    StatusWriter,
    set_line_writer,
)
from mirage.workspace.dispatcher import Dispatcher
from mirage.workspace.evaluation import EvaluationContext, child_context
from mirage.workspace.execution import ExecutionScope
from mirage.workspace.executor.builtins.alias import expanding_aliases
from mirage.workspace.executor.control import UNWINDING, ended
from mirage.workspace.executor.statement import (
    StatusSnapshot,
    record_status,
    snapshot_status,
)
from mirage.workspace.executor.traps import finish_shell, inherit_exit_trap
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.mount.registry import MountRegistry
from mirage.workspace.node.admission import (
    admit_line,
    is_pending,
    is_pending_refusal,
)
from mirage.workspace.node.explain import (
    Judged,
    Walked,
    line_held,
    line_judgments,
    prejudge_line,
    unrefused_nodes,
)
from mirage.workspace.node.occurrence import evaluated_from
from mirage.workspace.node.run_tree import run_command_tree
from mirage.workspace.session import (
    SessionState,
    get_current_session_for,
    reset_current_session,
    set_current_session,
)
from mirage.workspace.session.manager import SessionManager
from mirage.workspace.snapshot import ContentDriftError
from mirage.workspace.snapshot.drift import DriftQueue
from mirage.workspace.workspace.failure import (
    failure_result,
    placement_refused,
)
from mirage.workspace.workspace.fill import (
    cli_env_names,
    fill_env,
    fill_names,
    guest_bound,
    line_nodes,
)
from mirage.workspace.workspace.line import run_whole_line
from mirage.workspace.workspace.meta import WorkspaceMeta
from mirage.workspace.workspace.routing import Router
from mirage.workspace.workspace.runtimes import Runtimes
from mirage.workspace.workspace.utils import fork_for_call

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class ExecuteEnv:
    """The workspace parts a line runs against, built per line by
    ``Workspace``.

    Attributes:
        meta (WorkspaceMeta): the discovery record, written before the
            first line.
        drift (DriftQueue): the checks a load queued, drained first.
        namespace (Namespace): the mount table, links and overlay.
        sessions (SessionManager): the sessions a line resolves.
        registry (MountRegistry): mounts, policies and decisions.
        dispatcher (Dispatcher): the op door.
        observer (Observer): records each typed line.
        records (list[OpRecord]): the workspace's op log.
        job_table (JobTable): the workspace's jobs.
        agent_id (str | None): the workspace's default agent.
        runtimes (Runtimes): the runtimes a whole line may run in.
        router (Router): places a line.
        processes (ProcessSupervisor): starts a session's process.
        dispatch (DispatchFn): ``Workspace.dispatch``.
        has_managed_env (Callable[[], bool]): any session may hold a
            managed variable.
        secret_sources (Callable[[], Awaitable[Mapping[str,
            ResolvedSource]]]): the declared sources, built once.
        execute (Callable[..., Awaitable[IOResult]]): ``Workspace.shell``,
            which a nested line re-enters.
    """

    meta: WorkspaceMeta
    drift: DriftQueue
    namespace: Namespace
    sessions: SessionManager
    registry: MountRegistry
    dispatcher: Dispatcher
    observer: Observer
    records: list[OpRecord]
    job_table: JobTable
    agent_id: str | None
    runtimes: Runtimes
    router: Router
    processes: ProcessSupervisor
    dispatch: DispatchFn
    has_managed_env: Callable[[], bool]
    secret_sources: Callable[[], Awaitable[Mapping[str, ResolvedSource]]]
    execute: Callable[..., Awaitable[IOResult]]


@dataclass(slots=True)
class NestedRefusal:
    """The record the line's nested evaluations earned, latest kept.

    Every nested line re-enters execute through ``recurse``, and a
    substitution keeps only the inner stdout, so that door is the one
    place its record survives. The typed line reports it when its own
    tree earned none: the rightmost rule ``IOResult.merge`` applies,
    with the inner line standing left of the command that consumed
    its output.

    Args:
        latest (Refusal | None): the last record a nested line carried.
    """

    latest: Refusal | None = None


async def recurse(
    ws: ExecuteEnv,
    cmd: str,
    node: Any = None,
    span: tuple[int, int] | None = None,
    handed: HandOff | None = None,
    *,
    cancel: asyncio.Event | None,
    routing_decision: RouteDecision | None,
    agent_id: str | None,
    nested: NestedRefusal,
    execution_scope: ExecutionScope,
    substitution: bool = False,
    **opts: Any,
) -> Any:
    """The executor's internal eval ($(), source, eval, xargs, ...).

    Never a typed line, so it must not record a history entry or open
    its own recording context (GNU: history is appended by the line
    reader, the evaluator can't touch it). It inherits the typed
    line's routing decision and agent: nested lines never re-route,
    and an approval they raise is the outer line's agent's. It runs on
    a hand-off of its own under the one the node that runs it runs on,
    standing at that node: the outer pass reads into the words a
    command runs and claims for them at that place, so the grants are
    the inner line's to run on and nobody else's, and what the inner
    line's gates claim goes back up when it ends
    (``Decisions.hand_up``), so the next evaluation from the same node
    (the next batch ``xargs`` hands on) runs on it and the end of the
    line or job holding it spends it.

    Args:
        ws (ExecuteEnv): the workspace the outer line runs in.
        cancel (asyncio.Event | None): the abort event of the line or
            job this evaluation runs in; the walker rebinds it at every
            node, so a background job's evaluations carry none.
        routing_decision (RouteDecision | None): the typed line's
            decision, inherited verbatim.
        agent_id (str | None): the typed line's agent, inherited.
        nested (NestedRefusal): where the record a nested line earned
            is kept for the typed line.
        substitution (bool): isolate a substitution's child shell, except
            for the single input redirect that expands in the parent.
        cmd (str): the nested command line.
        node (Any): the node whose text ``cmd`` is: the command running
            a line, or the substitution being expanded. None when the
            caller has none, which leaves the inner line's commands
            standing nowhere the pass could have placed them, so its
            gates ask afresh.
        span (tuple[int, int] | None): the span of ``cmd`` within the
            node's text when the node holds several lines (a backtick
            region, whose touching pairs tree-sitter lexes as one
            node), so each stands at its own place.
        handed (HandOff | None): the hand-off of the subtree that runs
            this evaluation, bound by the walker at its door
            (``execute_node``): the line's own for a command in the
            foreground, a job's own for a command inside a background
            job, which may reach this after the line has ended. Bound
            to the line instead, a line a job evaluated late stood
            under a hand-off already swept: its gate could not see the
            grant the job held and asked again, and what it claimed
            went back to a hand-off nothing revokes. None outside a
            walk, which makes the inner line a line of its own.
    """
    if handed is None:
        inner = None
    elif node is None:
        inner = HandOff(parent=handed)
    else:
        inner = evaluated_from(node, handed, span)
    session = get_current_session_for(ws.sessions)
    if session is None:
        session = ws.sessions.get(
            opts.get("session_id") or ws.sessions.default_id
        )
    context = get_current_evaluation()
    if context is None:
        context = EvaluationContext(session)
    elif context.session is not session:
        context = EvaluationContext(session, context.frame.fork(), context)
    if (
        substitution
        and node is not None
        and node.type == NT.COMMAND_SUBSTITUTION
    ):
        parser = ParseScope()
        try:
            tree = parser.parse(cmd)
            if input_substitution_redirect(tree) is not None:
                evaluate = partial(
                    recurse,
                    ws,
                    cancel=cancel,
                    routing_decision=routing_decision,
                    agent_id=agent_id,
                    nested=nested,
                    execution_scope=execution_scope,
                    handed=inner,
                )
                io, _ = await run_command_tree(
                    ws.dispatch,
                    ws.registry,
                    ws.namespace,
                    ws.job_table,
                    evaluate,
                    agent_id or "",
                    tree,
                    context,
                    None,
                    cancel,
                    routing_decision=routing_decision,
                    handed=inner,
                    command_substitution=True,
                    execution_scope=execution_scope,
                )
                record_status(session, io.exit_code, transparent=True)
                if io.refusal is not None:
                    nested.latest = io.refusal
                return io
        finally:
            parser.release()
    child_token = None
    if substitution:
        context = child_context(context)
        session = context.session
        child_token = set_current_evaluation(context, owner=ws.sessions)
    capture = Terminal()
    waits = JobWaits(capture.jobs)
    rest = session.job_output or session.tty.jobs
    if substitution:
        session.terminal_output = False
        inherit_exit_trap(session)
        # A substitution reads its pipe until every writer has closed
        # it, so what a job it started writes is part of its value,
        # and it ends when its jobs do. They are its own jobs.
        session.job_output = capture.jobs
        session.job_waits = waits
        caller = opts.get("job_table") or ws.job_table
        opts["job_table"] = caller.child(caller)
        opts["sink"] = capture
    try:
        try:
            io = await ws.execute(
                cmd,
                cancel=cancel,
                record=False,
                execution_scope=execution_scope,
                routing_decision=routing_decision,
                agent_id=agent_id,
                handed=inner,
                **opts,
            )
        except UNWINDING as sig:
            # A substitution runs on a copy of the caller's frames,
            # and it is a child shell: whatever unwinds out of it
            # ends it.
            if not substitution:
                raise
            io = ended(sig)
        if substitution:
            io = await finish_shell(
                partial(
                    recurse,
                    ws,
                    node=node,
                    handed=handed,
                    cancel=cancel,
                    routing_decision=routing_decision,
                    agent_id=agent_id,
                    nested=nested,
                    execution_scope=execution_scope,
                    job_table=opts["job_table"],
                ),
                session,
                io,
                opts.get("stdin"),
                opts.get("call_stack"),
            )
            for channel, data in (
                (Channel.STDOUT, await io.materialize_stdout()),
                (Channel.STDERR, await io.materialize_stderr()),
            ):
                await capture.emit(channel, data)
            await waits.join(rest)
            out, err = capture.take()
            io.stdout = out or None
            io.stderr = err or None
    finally:
        if substitution:
            if child_token is not None:
                reset_current_session(child_token)
    if io.refusal is not None:
        nested.latest = io.refusal
    return io


def session_cwd(
    sessions: SessionManager,
    session_id: str,
) -> str | None:
    """The session's cwd for history, None once the session is gone.

    Args:
        sessions (SessionManager): the workspace's sessions.
        session_id (str): session whose cwd the history entry records.
    """
    try:
        return sessions.get(session_id).cwd
    except KeyError:
        return None


@dataclass(slots=True)
class LineFrame:
    """What ``Workspace.shell`` needs from the line to answer an abort:
    the shell it ran on and the status that shell had before it, filled
    by ``execute_line`` as soon as it knows them and before anything
    stamps. Per call, never on the session, so two lines on one session
    each keep their own.

    Attributes:
        session (SessionState | None): the shell the line stamps on.
        status_before (StatusSnapshot | None): ``$?`` and
            ``${PIPESTATUS[@]}`` as the line found them.
        writer (StatusWriter): the line's identity, so a restore undoes
            only the stamps this line made.
    """

    session: SessionState | None = None
    status_before: StatusSnapshot | None = None
    writer: StatusWriter = field(default_factory=StatusWriter)


async def execute_line(
    ws: ExecuteEnv,
    command: str,
    session_id: str | None,
    stdin: ByteSource | None,
    agent_id: str | None,
    cwd: str | None,
    env: dict[str, str] | None,
    cancel: asyncio.Event | None,
    record: bool,
    runtime: str | None,
    routing_decision: RouteDecision | None,
    handed: HandOff | None = None,
    frame: LineFrame | None = None,
    argv: tuple[str, ...] | None = None,
    sink: JobConsole | None = None,
    call_stack: CallStack | None = None,
    execution_scope: ExecutionScope | None = None,
    job_table: JobTable | None = None,
) -> IOResult:
    """The body of ``Workspace.shell``; see its docstring for the
    argument contract.

    Order of gates: hydrate stores, drain any queued drift check,
    resolve the session, parse, syntax gate, policy, then one of two
    strategies (whole-line runtime, command tree).
    Failures fold into the line's ``IOResult`` via ``failure_result``,
    except the kinds that are the caller's problem (abort, drift,
    policy misconfiguration), which propagate.

    Args:
        ws (ExecuteEnv): the workspace the line runs in.
        handed (HandOff | None): the hand-off the line runs on, made by
            ``recurse`` for a nested evaluation; None for a typed line,
            which gets one of its own.
        frame (LineFrame | None): filled with the session and its
            status before the line, for ``Workspace.shell`` to restore
            ``$?`` from when the caller aborts.
    """
    if cancel is not None and cancel.is_set():
        raise MirageAbortError()
    await ws.namespace.ensure_loaded()
    await ws.meta.ensure()
    await ws.sessions.ensure_loaded()
    if ws.drift.pending:
        await ws.drift.drain(ws.registry.try_mount_for)

    # A re-entrant execute (the evaluator's $(), eval, source, xargs, or
    # an embedder callback fired mid-line) continues in the live ambient
    # session unless it names a different one. An id cannot say that: it
    # names a registered session, never the ephemeral per-call fork the
    # outer line actually runs in, and re-resolving through the manager
    # is how a nested line used to escape the fork and its confinement.
    # Only this workspace's own binding counts: a session carries one
    # workspace's cwd, env and mount grants, so a callback reaching a
    # second workspace must resolve that workspace's session instead.
    ambient = get_current_session_for(ws.sessions)
    tty = None
    if ambient is not None and session_id in (None, ambient.session_id):
        session = ambient
        session_id = ambient.session_id
    else:
        if session_id is None:
            session_id = ws.sessions.default_id
        session = ws.sessions.get(session_id)
        # A typed line writes to its session's terminal, and so do the
        # jobs it starts, as they write; the line answers with whatever
        # reached the terminal while it ran, a job's output from before
        # it first.
        tty = session.tty
    execution_scope = execution_scope or ExecutionScope()
    await execution_scope.start()
    run_line = partial(
        run_prepared_line,
        ws,
        command,
        session,
        stdin=stdin,
        agent_id=agent_id,
        cwd=cwd,
        env=env,
        cancel=cancel,
        record=record,
        runtime=runtime,
        routing_decision=routing_decision,
        handed=handed,
        frame=frame,
        argv=argv,
        sink=tty if tty is not None else sink,
        call_stack=call_stack,
        execution_scope=execution_scope,
        job_table=job_table,
    )
    if tty is None:
        return await _run_line(ws, command, session, cwd, run_line)
    try:
        await tty.attach(sink)
        io = await _run_line(ws, command, session, cwd, run_line)
        for channel, data in (
            (Channel.STDOUT, await io.materialize_stdout()),
            (Channel.STDERR, await io.materialize_stderr()),
        ):
            await tty.emit(channel, data)
    except BaseException:
        tty.drop_line()
        raise
    out, err = tty.take()
    io.stdout = out
    io.stderr = err or None
    return io


async def _run_line(
    ws: ExecuteEnv,
    command: str,
    session: SessionState,
    cwd: str | None,
    run_line: Callable[[], Awaitable[IOResult]],
) -> IOResult:
    """Run a line as the session's process, starting one if it has none.

    Args:
        ws (ExecuteEnv): the workspace.
        command (str): the line's text.
        session (SessionState): the session it runs on.
        cwd (str | None): the per-call directory, if any.
        run_line (Callable): the line.
    """
    if session.process_id is None:
        results: list[IOResult] = []

        async def run() -> int:
            token = set_current_session(session, owner=ws.sessions)
            try:
                result = await run_line()
                results.append(result)
                return result.exit_code
            finally:
                reset_current_session(token)

        try:
            process = ws.processes.start(
                session_id=session.session_id,
                command=command,
                cwd=PathSpec.from_str_path(cwd or session.cwd),
                run=run,
                limit=session.processes.max,
            )
        except BlockingIOError:
            record_status(session, FORK_FAILED_STATUS)
            return IOResult(exit_code=FORK_FAILED_STATUS, stderr=FORK_FAILED)
        session.process_id = process.info.pid
        if session.shell_pid is None:
            session.shell_pid = process.info.pid
        try:
            await process.task
            return results[0]
        finally:
            session.process_id = None
    return await run_line()


async def _shown(io: IOResult, sink: JobConsole | None) -> IOResult:
    """What a line showed, for its record: what waits on its terminal
    for it to take, then what it answers with besides.

    Args:
        io (IOResult): the line's result.
        sink (JobConsole | None): where the line wrote.
    """
    if not isinstance(sink, Terminal) or sink.reader is not None:
        return io
    out, err = sink.drain()
    sink.put_back(out, err)
    return IOResult(
        stdout=out + await io.materialize_stdout(), exit_code=io.exit_code
    )


async def run_prepared_line(
    ws: ExecuteEnv,
    command: str,
    session: SessionState,
    *,
    stdin: ByteSource | None,
    agent_id: str | None,
    cwd: str | None,
    env: dict[str, str] | None,
    cancel: asyncio.Event | None,
    record: bool,
    runtime: str | None,
    routing_decision: RouteDecision | None,
    handed: HandOff | None,
    frame: LineFrame | None,
    argv: tuple[str, ...] | None,
    sink: JobConsole | None,
    call_stack: CallStack | None,
    execution_scope: ExecutionScope,
    job_table: JobTable | None = None,
) -> IOResult:
    """Run a line on the session it acquired, after admission is published.

    Both paths of ``execute_line``, inside the managed process or not, end
    here; the other arguments are ``execute_line``'s.

    Args:
        ws (ExecuteEnv): the workspace the line runs in.
        command (str): the line's text.
        session (SessionState): the session the line acquired.
    """
    session_id = session.session_id
    cache_facts = ws.dispatcher.capture_cache_facts()
    effective_session = fork_for_call(session, cwd, env)
    parent = get_current_evaluation()
    if parent is not None and parent.session is not session:
        parent = None
    context = (
        parent
        if parent is not None and parent.session is effective_session
        else EvaluationContext(effective_session, parent=parent)
    )
    # The agent of this line, carried with the execution rather than
    # held on the workspace: a nested line inherits it through
    # `recurse`, a concurrent line keeps its own.
    agent = agent_id if agent_id is not None else ws.agent_id
    io = IOResult()
    # The line-reader decision (GNU: history is appended where the
    # typed line is read, never inside the evaluator). Internal
    # evaluations get an inert scope.
    is_line = record
    scope = RecordingScope(active=is_line)
    parse_scope = ParseScope()
    # A nested line applies against the records added to the enclosing
    # line's since it began, copied at apply, reads left out: a
    # concurrent sibling stage records into the same list, and its read
    # token would label bytes this line read before the change.
    outer = None if is_line else active_records()
    nested_start = len(outer) if outer is not None else 0

    session_token = set_current_evaluation(context, owner=ws.sessions)
    # Taken before any statement stamps, so a cancelled line can put
    # `$?` back to what it found. Restored at the seam in
    # ``Workspace.shell``, after the last await of the line, so an
    # abort that lands on the flush or the record is covered too.
    if frame is not None:
        frame.session = session
        frame.status_before = snapshot_status(session)
        # This coroutine is the line's whole task, so every statement
        # and every nested evaluation under it inherits the identity.
        set_line_writer(frame.writer)
    try:
        ast = (
            parse_scope.parse(command) if argv is None else literal_tree(argv)
        )
        # Syntax gates before policy, mirroring the TS order and
        # bash: an unparsable line exits 2 and the policy is never
        # consulted about it. bash's reading of the line decides; the
        # grammar's own errors only stop a line it cannot build.
        found = None
        if argv is None:
            found = check_syntax(
                command, expanding_aliases(effective_session)
            ) or find_syntax_issue(ast)
        if found is not None:
            io = syntax_error_result(found)
            if call_stack is not None and io.exit_code == 127:
                # A substitution bash cannot parse ends the shell, from
                # `eval` and `source` too: 127, or 1 out of a child.
                raise ExitSignal(
                    127, await io.materialize_stderr(), contained_code=1
                )
            if (
                call_stack is not None
                and call_stack.subshell
                and io.exit_code == 1
            ):
                # An array bash cannot read discards its line: `eval`
                # and `source` return 1, and a child shell ends there.
                raise DiscardSignal(await io.materialize_stderr())
            record_status(session, io.exit_code)
            return io
        nested = NestedRefusal()

        def note(refusal: Refusal) -> None:
            nested.latest = refusal

        # An op a policy refuses inside a command prints the command's
        # own GNU line, so the door notes the record here, for the line
        # to carry on its result. Bound before placement, so an op a
        # policy script makes while the line is judged is inside the
        # line, never a question of its own.
        sink_token = set_refusal_sink(note)
        # The line's hand-off: the grants its passes and gates claim
        # for its commands, which the gates run on and the line's end
        # spends. A nested evaluation runs on one made under the
        # hand-off of the node that runs it, which the walker binds
        # into the door (execute_node), not this line's: a background
        # job's subtree runs on a hand-off of the job's own.
        if handed is None:
            handed = HandOff()
        line_handed = handed
        judgments: list[list[tuple[Walked, list[Judged]]]] = []

        async def judged() -> list[tuple[Walked, list[Judged]]]:
            # The line's commands judged once, for placement and the
            # pass that refuses the line alike.
            if not judgments:
                judgments.append(
                    await line_judgments(
                        ast,
                        effective_session,
                        ws.registry,
                        ws.namespace,
                        line_handed,
                        agent or "",
                    )
                )
            return judgments[0]

        async def admission_holds() -> bool:
            return await line_held(
                await judged(), ws.registry, line_handed, cancel
            )

        held = False
        try:
            placed = await ws.router.decide(
                ast,
                command,
                runtime,
                effective_session,
                session_id,
                agent or "",
                routing_decision,
                admission_holds,
            )
            if isinstance(placed, Deny):
                io = placement_refused(placed, command)
                record_status(session, io.exit_code)
                return io
            decision = placed
            # Bound by keyword so the walker can rebind it per node: a
            # background job's nested lines run without the caller's
            # event, as the job itself does.
            exec_recursion = partial(
                recurse,
                ws,
                cancel=cancel,
                routing_decision=decision,
                agent_id=agent,
                nested=nested,
                execution_scope=execution_scope,
                job_table=job_table,
            )
            line_runtime = ws.runtimes.whole_line(decision)
            if line_runtime is not None:
                # A whole line is a command like any other: the same
                # visibility and admission gate as the tree, per parsed
                # command, before the runtime sees a byte of it. No gate
                # follows, so the pass claims on the hand-off and the
                # sweep below spends what it claimed, or keeps it for
                # the retry of a line held on a question.
                refused = await admit_line(
                    ast,
                    effective_session,
                    ws.registry,
                    ws.namespace,
                    agent or "",
                    cancel,
                    handed,
                )
                if refused is not None:
                    held = is_pending(refused)
                    io = IOResult(
                        exit_code=refused.exit_code,
                        stderr=refused.stderr,
                        refusal=refused.refusal,
                    )
                    record_status(session, io.exit_code)
                    return io
                if ws.has_managed_env():
                    # Filled only after the line is admitted (a refused
                    # line must never reach a secret store) and before the
                    # runtime snapshots the env; a whole-line program may
                    # read any name, so the walk is not consulted. A
                    # SecretsError raises through to the generic fold
                    # below: the line exits 1 and never runs.
                    whole_names = fill_names(
                        effective_session,
                        [ast],
                        whole=True,
                        cli_env_names=frozenset(),
                    )
                    # Names first, and the declarations only if there are
                    # any: both arguments would otherwise be evaluated, so
                    # a session with nothing pending (a profile hiding
                    # every managed name) still read a bootstrap source.
                    # The TypeScript twin shares one helper with the
                    # per-command path and skipped this by construction.
                    if whole_names:
                        await fill_env(
                            effective_session,
                            whole_names,
                            await ws.secret_sources(),
                        )
                io = await run_whole_line(
                    line_runtime,
                    command,
                    stdin,
                    effective_session,
                    ws.registry.mounts(),
                    ws.registry.policies,
                    ws.dispatcher.invalidate_all_after_remote,
                    ws.registry.command_limits,
                )
                if io.refusal is None:
                    io.refusal = nested.latest
                record_status(session, io.exit_code)
                return io
            # The line is the unit a rule judges, so every command in it is
            # judged before any of it runs. Nothing here replaces the
            # per-command gate below, which still binds each command's own
            # entry gate; this only stops a line a rule refuses from
            # running half-way. The grants the passes claim for the gates
            # ride the hand-off, swept in the finally however the line
            # ends: the sweep has to cover everything from the preflight
            # on, since a fetch that fails or a kill between it and the
            # run leaves a claimed grant just as unspent as a skipped gate
            # does.
            refused = await prejudge_line(
                ast,
                effective_session,
                ws.registry,
                ws.namespace,
                handed,
                agent or "",
                cancel,
                await judged(),
            )
            if refused is not None:
                # A question left waiting holds the line for its retry,
                # which has to find the grants standing, so they are
                # released rather than spent; any other refusal ends
                # the line.
                held = is_pending(refused)
                io = IOResult(
                    exit_code=refused.exit_code,
                    stderr=refused.stderr,
                    refusal=refused.refusal,
                )
                record_status(session, io.exit_code)
                return io
            if ws.has_managed_env():
                # Filled only after the line-tier admission and before the
                # tree's expansion reads the vars. The walked set carries
                # stored function bodies too, so a function invoked by bare
                # name still fills what its body reads. The prejudge pass
                # leaves single-command lines to the per-command gate, so
                # the fetch asks the same text-tier question itself, over
                # the same walked set the names came from: a node already
                # denied on its literal words never reaches a source, and a
                # rule that asks is answered before the fetch, with the
                # approval left for the gate to spend. A deny only the
                # value gate can see still follows the fetch, because
                # expansion is what consumes the values.
                nodes = line_nodes(ast, effective_session)
                policies = ws.registry.policies
                writes_gated = (
                    policies is not None
                    and await policies.wants_for(
                        "pre_session", effective_session.session_id
                    )
                )

                def plan_names(subset: Sequence[TSNodeLike]) -> frozenset[str]:
                    return fill_names(
                        effective_session,
                        subset,
                        whole=guest_bound(
                            subset, decision, ws.registry.runtime_bindings
                        ),
                        cli_env_names=cli_env_names(
                            subset, effective_session, ws.registry
                        ),
                        writes_gated=writes_gated,
                    )

                names = plan_names(nodes)
                if names:
                    served = await unrefused_nodes(
                        nodes,
                        effective_session,
                        ws.registry,
                        ws.namespace,
                        handed,
                        agent or "",
                        cancel,
                    )
                    if len(served) != len(nodes):
                        nodes = served
                        names = plan_names(served) if served else frozenset()
                    # A fetched value can name another managed variable
                    # (the arithmetic chase recurses through values), and
                    # what a value spells is unknowable before its fetch,
                    # so the plan reruns over the same admitted nodes until
                    # it reaches nothing new. fill_names returns pending
                    # names only, so every pass fetches names the last one
                    # could not see and the loop settles.
                    while names:
                        # Built here, not above the plan: the declarations
                        # are read only once an admitted node actually
                        # wants a value, so a line the per-command gate
                        # refuses never reaches a bootstrap source either.
                        # An unknown source name already fails at
                        # construction; what is left for this to discover
                        # is an unreadable dotenv or a config the source
                        # refuses, which is the same treatment an
                        # unreachable store gets. Memoized, so the loop's
                        # later passes cost one await.
                        sources = await ws.secret_sources()
                        await fill_env(effective_session, names, sources)
                        names = plan_names(nodes)
            # No seam of its own: the whole line is one task under
            # ``Workspace.shell``, and a cancel lands on whichever await
            # the tree is in.
            io, _ = await run_command_tree(
                ws.dispatch,
                ws.registry,
                ws.namespace,
                job_table or ws.job_table,
                exec_recursion,
                agent or "",
                ast,
                context,
                stdin,
                cancel,
                routing_decision=decision,
                handed=handed,
                sink=sink,
                call_stack=call_stack,
                execution_scope=execution_scope,
            )
            # A record a nested line earned is the line's to report when
            # its own tree earned none (see NestedRefusal).
            if io.refusal is None:
                io.refusal = nested.latest
            # A question a gate left waiting holds the line exactly as
            # one the pass left waiting does: the retry has to find the
            # grants the pass claimed for the other commands standing,
            # or it asks for them again, and the answer to this one
            # would be taken by the first spelling the pass reads.
            held = is_pending_refusal(io.refusal)
        finally:
            reset_refusal_sink(sink_token)
            if held:
                ws.registry.decisions.release(
                    effective_session.session_id, handed
                )
            elif handed.parent is not None:
                # A nested evaluation's claims are the outer line's to
                # keep for the next evaluation from the same node and
                # to spend at its own end.
                ws.registry.decisions.hand_up(
                    effective_session.session_id, handed
                )
            else:
                await ws.registry.decisions.revoke(
                    effective_session.session_id, handed
                )
        # The program loop stamped each statement; the line as a whole
        # is a wrapper around them, like a group.
        warnings = getattr(ast, "warnings", b"")
        if warnings:
            io.stderr = warnings + await io.materialize_stderr()
        record_status(session, io.exit_code, transparent=True)
        applied: list[OpRecord] | None = scope.records
        if not is_line:
            applied = (
                None
                if outer is None
                else [
                    r
                    for r in outer[nested_start:]
                    if r.op not in READ_FINGERPRINT_OPS
                ]
            )
        await ws.dispatcher.apply_io(
            io, records=applied, cache_facts=cache_facts
        )
        return io
    except CommandTimeoutError as exc:
        # The caller's event is read, never written: a timeout is this
        # line's answer (exit 124), not an abort of the invocation, and
        # nothing below is still running once the tree has raised.
        logger.debug(
            "command %r timed out after %ss", exc.command, exc.seconds
        )
        io = failure_result(exc, command)
        record_status(session, io.exit_code)
        return io
    except (MirageAbortError, asyncio.CancelledError):
        # An aborted invocation is the caller's outcome, not the shell's;
        # the record says so, and ``Workspace.shell`` restores `$?`.
        io = IOResult(exit_code=130, stderr=b"execute aborted\n")
        raise
    except (ContentDriftError, RouteError) as exc:
        io = failure_result(exc, command)
        # Drift and invalid routing remain the caller's errors.
        raise
    except Exception as exc:
        if call_stack is not None and isinstance(exc, UNWINDING):
            # A line run in its caller's frame unwinds into the caller.
            raise
        # The fold is a failed command like any other (a SecretsError
        # folds here), so $? must report it, mirroring the TS catch.
        io = failure_result(exc, command)
        record_status(session, io.exit_code)
        return io
    finally:
        # One rule on every path: an op that happened is always
        # accounted, in byte accounting (which feeds snapshot
        # fingerprints/drift) and as observer op events. The command
        # event's exit_code says whether the line that emitted them
        # succeeded.
        parse_scope.release()
        scope.close()
        reset_current_session(session_token)
        # The marks were only for this line's apply_io, so they go however
        # the save ends, with any a background job added during it; the
        # seal stops a background command that returns later from marking
        # a record persisted here, which nothing outside FUSE ever trims.
        try:
            await ws.sessions.flush(session.session_id)
        finally:
            for rec in scope.records:
                rec.claimed = None
                rec.sealed = True
        ws.records.extend(scope.records)
        # bash adds a line to history only when it is non-empty
        # (anything before its newline): a blank line is skipped, while a
        # whitespace-only or comment-only line is kept.
        if is_line and command.strip("\n"):
            await ws.observer.log_execution(
                command,
                await _shown(io, sink),
                scope.records,
                agent or "",
                session_id,
                session_cwd(ws.sessions, session_id),
            )

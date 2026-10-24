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

from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod
from collections.abc import (
    AsyncIterator,
    Awaitable,
    Callable,
    Mapping,
    Sequence,
)
from contextvars import ContextVar
from dataclasses import dataclass, fields, replace
from typing import TYPE_CHECKING, Any, TypeVar

from mirage.errors.fs import eacces, enoent, erofs
from mirage.types import (
    MOUNT_MODE_RANK,
    MountMode,
    PathSpec,
    Refusal,
    Visibility,
    WalkProbe,
    weaker_mode,
)
from mirage.utils.hidden import (
    anchor_depth,
    is_glob,
    leads_hidden,
    path_visible,
    show_head,
    shown_mode,
)
from mirage.utils.path import norm, parent
from mirage.view.types import SessionAccess

if TYPE_CHECKING:
    from mirage.cache.types import CacheInvalidator, OwnRead, WriteContext
    from mirage.io.types import ByteSource, IOResult
    from mirage.observe.record import OpRecord, Recorder
    from mirage.policy.types import (
        DecisionOwner,
        DryRun,
        EntryGate,
        HandOff,
        VfsExplanation,
    )
    from mirage.process.handle import ProcessHandle
    from mirage.shell.console import JobConsole
    from mirage.shell.types import Redirect
    from mirage.workspace.evaluation import EvaluationContext
    from mirage.workspace.session.session import SessionState
    from mirage.workspace.types import ExecutionNode, StatusWriter


T = TypeVar("T")


class SessionOwner(ABC):
    """Whoever binds sessions: one per workspace, compared by identity."""

    @abstractmethod
    def get(self, session_id: str) -> SessionState:
        """The session this owner holds under ``session_id``.

        Args:
            session_id (str): the session's id.
        """


# Where a refusal an entry point raises is noted for the line running it.
RefusalSink = Callable[[Refusal], None]

# Runs a prepared command under ordered redirects, with a gate for
# each target and the command identity for the single-output fast path.
RedirectResult = tuple["ByteSource | None", "IOResult", "ExecutionNode"]
RedirectRun = Callable[
    ["ByteSource | None", "JobConsole | None", tuple[PathSpec, ...]],
    Awaitable[RedirectResult],
]
RedirectGuard = Callable[
    [tuple[PathSpec, ...], "ByteSource | None"],
    Awaitable[RedirectResult | None],
]
RedirectRunner = Callable[
    [RedirectRun, RedirectGuard | None, str, tuple[str, ...]],
    Awaitable[RedirectResult],
]


@dataclass(frozen=True, slots=True, eq=False)
class Caller:
    """Who makes a call, and what every check on it needs to know: the
    session, and the line, job, command and file call it runs in.

    One record per call, never shared. Each layer is a copy of the one
    above with its own fields set, so two calls running at once each
    hold their own, and work that runs after its command returned (a
    stream pulled later, a runtime's callback) keeps the record it was
    made with.

    Args:
        session (SessionState | None): the session the call acts as.
        owner (SessionOwner | None): the session manager the session
            belongs to, one per workspace; None when the binder did not
            name one.
        evaluation (EvaluationContext | None): the evaluation running on
            the session, None outside one; a layer bound to another
            session never carries it.
        gate (EntryGate | None): the running command's admission gate.
        rule_gate (EntryGate | None): the gate the dispatcher judges the
            paths of this call by: the command's own calls carry it, the
            shell's own I/O around them does not.
        mount (tuple[str, MountMode] | None): the prefix and configured
            mode of the mount a command runs on.
        refusals (RefusalSink | None): where the running line notes a
            policy's refusal; None outside a line.
        explaining (list[VfsExplanation] | DryRun | None): a dry run's
            trace, DECIDING while its policies decide, None to run.
        walk_probe (WalkProbe | None): what a command's dot walks read.
        redirects (tuple | None): a statement's expanded redirect
            targets, keyed by its command node.
        program (SessionState | None): the session a program line (find
            -exec) runs in.
        call (tuple[DecisionOwner, HandOff, str] | None): the call an
            op-level answer covers: its ledger, hand-off and session.
        policy_read (bool): whether the call is a policy program's own
            read.
        stop (asyncio.Event | None): the running line's stop signal.
        write_held (bool): whether the call already holds the
            workspace's write admission.
        line_writer (StatusWriter | None): the identity of the line
            running on this task.
        recorder (Recorder | None): where the running line records its
            calls, with the mount serving them.
        command_sink (tuple | None): the running command's own records,
            and those of the command it runs in.
        revisions (dict[str, str] | None): the revision pins reads honor.
        cache_manager (CacheInvalidator | None): the cache a backend's
            writes report to.
        read_facts (tuple | None): the tokens a fetch's bytes carried.
        write_context (WriteContext | None): what a conditional write is
            checked against.
        own_version (tuple | None): the version a write's own read
            stamped.
        command_started (int | None): when the running command started.
        enclosing (JobConsole | None): the recorder of the innermost
            level running a command, for a level whose output is a value
            (a substitution's) to send another level's stream bytes
            toward it.
        execution (str | None): the execution (a line, a job, a spawned
            process) the call runs in, which its records name.
        process (ProcessHandle | None): the managed runner the call runs
            in, whose kill signal a native program it started receives.
    """

    session: SessionState | None = None
    owner: SessionOwner | None = None
    evaluation: EvaluationContext | None = None
    gate: EntryGate | None = None
    rule_gate: EntryGate | None = None
    mount: tuple[str, MountMode] | None = None
    refusals: RefusalSink | None = None
    explaining: list[VfsExplanation] | DryRun | None = None
    walk_probe: WalkProbe | None = None
    redirects: (
        tuple[
            int,
            tuple[PathSpec, ...],
            RedirectRunner | None,
            tuple[Redirect, ...],
        ]
        | None
    ) = None
    program: SessionState | None = None
    call: tuple[DecisionOwner, HandOff, str] | None = None
    policy_read: bool = False
    stop: asyncio.Event | None = None
    write_held: bool = False
    line_writer: StatusWriter | None = None
    recorder: Recorder | None = None
    command_sink: tuple[list[OpRecord] | None, list[OpRecord]] | None = None
    revisions: dict[str, str] | None = None
    cache_manager: CacheInvalidator | None = None
    read_facts: tuple[str, list[tuple[bytes, str | None]]] | None = None
    write_context: WriteContext | None = None
    own_version: tuple[str, str | OwnRead | None] | None = None
    command_started: int | None = None
    enclosing: JobConsole | None = None
    execution: str | None = None
    process: ProcessHandle | None = None

    @property
    def visibility(self) -> Visibility | None:
        """What the caller's session sees, None when unrestricted."""
        return self.session.visibility if self.session is not None else None


@dataclass(frozen=True, slots=True)
class CallerToken:
    """What one binding changed, for its reset to put back.

    A reset restores only the fields its binding set, so bindings undone
    out of order leave each other's fields alone.

    Args:
        names (tuple[str, ...]): the fields the binding set.
        before (Caller): the caller the binding replaced.
    """

    names: tuple[str, ...]
    before: Caller


_caller: ContextVar[Caller] = ContextVar("mirage_caller", default=Caller())


def current_caller() -> Caller:
    """The caller bound to the current async context."""
    return _caller.get()


def bind_caller(caller: Caller) -> CallerToken:
    """Bind a caller to the current async context: a layer's own copy,
    or the record a stream pulled or a callback run after its command
    returned was made with.

    Args:
        caller (Caller): the caller to bind.
    """
    before = _caller.get()
    _caller.set(caller)
    names = tuple(
        f.name
        for f in fields(Caller)
        if getattr(caller, f.name) is not getattr(before, f.name)
    )
    return CallerToken(names, before)


def _bind(**changes: Any) -> CallerToken:
    return bind_caller(replace(_caller.get(), **changes))


def reset_caller(token: CallerToken) -> None:
    """Put back the fields a binding set.

    Args:
        token (CallerToken): the binding's token.
    """
    restored = {name: getattr(token.before, name) for name in token.names}
    _caller.set(replace(_caller.get(), **restored))


def current_execution_id() -> str | None:
    """The execution the current call runs in, which its records name."""
    return _caller.get().execution


async def run_with_execution(
    execution_id: str,
    run: Callable[[], Awaitable[T]],
    process: ProcessHandle | None = None,
) -> T:
    """Run ``run`` as part of the execution ``execution_id``.

    Args:
        execution_id (str): the execution (a line, a job, a spawned
            process).
        run (Callable[[], Awaitable[T]]): what runs in it.
        process (ProcessHandle | None): the managed runner it is, when it
            is one.
    """
    token = _bind(execution=execution_id, process=process)
    try:
        return await run()
    finally:
        reset_caller(token)


def calls_as(caller: Caller, fn: Callable[..., T]) -> Callable[..., T]:
    """``fn`` run as ``caller`` wherever it is called from: a runtime's
    guest asks its questions from a thread of its own, which carries no
    caller.

    Args:
        caller (Caller): who the calls are made as.
        fn (Callable[..., T]): a synchronous function.
    """

    def call(*args: Any, **kwargs: Any) -> T:
        before = _caller.get()
        _caller.set(caller)
        try:
            return fn(*args, **kwargs)
        finally:
            _caller.set(before)

    return call


def awaits_as(
    caller: Caller, fn: Callable[..., Awaitable[T]]
) -> Callable[..., Awaitable[T]]:
    """``fn`` run as ``caller`` whoever awaits it.

    Args:
        caller (Caller): who the calls are made as.
        fn (Callable[..., Awaitable[T]]): an asynchronous function.
    """

    async def call(*args: Any, **kwargs: Any) -> T:
        before = _caller.get()
        _caller.set(caller)
        try:
            return await fn(*args, **kwargs)
        finally:
            _caller.set(before)

    return call


async def with_caller(
    it: AsyncIterator[T], caller: Caller
) -> AsyncIterator[T]:
    """``it`` pulled and closed as ``caller``.

    A stream keeps the caller it was made with: whoever pulls it and
    however late (a reader further down a pipeline, a host draining a
    line's output), what each pull runs (a backend's lazy read, the
    record it makes, the pins and cache scope it reads) is that caller's,
    and so is the close a reader that stops early sends. What a pull
    binds stays the stream's for its next pull and never reaches the
    reader.

    Args:
        it (AsyncIterator[T]): the stream.
        caller (Caller): the caller it was made with.
    """
    iterator = it.__aiter__()
    own = caller
    try:
        while True:
            before = _caller.get()
            _caller.set(own)
            try:
                item = await iterator.__anext__()
            except StopAsyncIteration:
                return
            finally:
                own = _caller.get()
                _caller.set(before)
            yield item
    finally:
        close = getattr(iterator, "aclose", None)
        if close is not None:
            before = _caller.get()
            _caller.set(own)
            try:
                await close()
            finally:
                _caller.set(before)


def set_current_session(
    session: SessionState | None,
    owner: SessionOwner | None = None,
    *,
    evaluation: EvaluationContext | None = None,
) -> CallerToken:
    """Bind ``session`` to the current async context.

    Args:
        session (SessionState | None): the session to bind.
        owner (SessionOwner | None): the manager the session belongs
            to. None keeps the owner already bound, so a nested bind
            inside a line (a background job's fork) stays attributed to
            the workspace running it.
        evaluation (EvaluationContext | None): the evaluation running
            on the session. None keeps the one already bound when it
            runs on this same session; another session's is dropped.
    """
    current = _caller.get()
    if owner is None:
        owner = current.owner
    if evaluation is None and current.session is session:
        evaluation = current.evaluation
    return _bind(session=session, owner=owner, evaluation=evaluation)


def reset_current_session(token: CallerToken) -> None:
    """Restore the previous session binding."""
    reset_caller(token)


def get_current_session() -> SessionState | None:
    """Return the session bound to the current async context, if any."""
    return _caller.get().session


def set_current_evaluation(
    context: EvaluationContext, owner: SessionOwner | None = None
) -> CallerToken:
    """Bind an evaluation with its session, as one binding; undone by
    :func:`reset_current_session`.

    Args:
        context (EvaluationContext): the evaluator entering this task.
        owner (SessionOwner | None): the workspace owner; inherited if
            omitted.
    """
    return set_current_session(context.session, owner, evaluation=context)


def get_current_evaluation() -> EvaluationContext | None:
    """Return the evaluation bound with the current session, if any."""
    return _caller.get().evaluation


def get_current_session_for(owner: SessionOwner) -> SessionState | None:
    """Return the bound session only when ``owner`` published it.

    A session carries one workspace's cwd, env and mount grants, so a
    second workspace re-entered mid-line must resolve its own session
    rather than adopt this one.

    Args:
        owner (SessionOwner): the asking workspace's session manager.
    """
    caller = _caller.get()
    if caller.owner is not owner:
        return None
    return caller.session


def get_current_session_unless_foreign(
    owner: SessionOwner,
) -> SessionState | None:
    """The bound session, unless another owner published it.

    An entry point keeps the session it is reached under, so it never
    widens a caller's view: a command's runtime, a kernel mount and a
    guest runtime all bind before they call. A binding that names an
    owner other than ``owner`` is another workspace's, and its session
    describes that workspace's hides and grants, so the entry point must not
    adopt it. A binding that names no owner is a deliberate placement
    (a kernel mount, a guest runtime, an embedder binding by hand) and
    is kept.

    Args:
        owner (SessionOwner): the asking workspace's session manager.
    """
    caller = _caller.get()
    if caller.owner is not None and caller.owner is not owner:
        return None
    return caller.session


def _session_mode(mount_prefix: str) -> MountMode:
    """The current session's mode cap for this mount.

    ``MountMode.EXEC`` (no narrowing) when no session is bound, when the
    profile names no mount, or when it names none for this one: a profile's
    mount sections narrow what the mount already offers and never
    decide whether it exists. A profile that must not reach a mount hides
    it, which answers ENOENT rather than a permission error naming
    something the profile cannot see.

    Args:
        mount_prefix (str): the mount's prefix, e.g. ``/s3``.
    """
    sess = get_current_session()
    if sess is None or sess.mount_modes is None:
        return MountMode.EXEC
    return sess.mount_modes.get(norm(mount_prefix), MountMode.EXEC)


DEFAULT_UMASK = 0o022


def session_umask(access: SessionAccess | None = None) -> int:
    """The owner's creation mask, or the current session's; bash's default if absent.

    Args:
        access (SessionAccess | None): explicit owner, else the current context.
    """
    if access is not None:
        return access.umask
    sess = get_current_session()
    return DEFAULT_UMASK if sess is None else sess.umask


def dotglob_active(access: SessionAccess | None = None) -> bool:
    """Whether the owner's pathname expansion includes leading dots; off if absent.

    Args:
        access (SessionAccess | None): explicit owner, else the current context.
    """
    if access is not None:
        return access.shopts.get("dotglob", False)
    sess = get_current_session()
    return sess is not None and bool(sess.shopts.get("dotglob"))


def extglob_active(access: SessionAccess | None = None) -> bool:
    """Whether the owner's patterns use extglob grammar; off if absent.

    Args:
        access (SessionAccess | None): explicit owner, else the current context.
    """
    if access is not None:
        return access.shopts.get("extglob", False)
    sess = get_current_session()
    return sess is not None and bool(sess.shopts.get("extglob"))


def session_visibility(
    access: SessionAccess | None = None,
) -> Visibility | None:
    """The owner's visibility, or the current session's; None if unrestricted.

    Args:
        access (SessionAccess | None): explicit owner, else the current context.
    """
    if access is not None:
        return access.visibility
    sess = get_current_session()
    return sess.visibility if sess is not None else None


def hidden_refusal(
    vis: Visibility | None,
    virtual: str,
    create: bool,
    links: Mapping[str, str] | None = None,
) -> OSError:
    """The error a hidden path answers, in POSIX's own terms.

    ENOENT names a component that does not exist and EACCES an entry
    the caller may not write, so a create is EACCES only when the
    directory it lands in is visible: a hidden name under a visible
    parent reads as an existing file the session cannot write, which
    is the one answer that neither reveals the content nor invites a
    create that would clobber it. A create under a hidden directory is
    ENOENT, the same answer every read gives for that directory, so a
    write cannot detect a hide a read could not. Everything that is
    not a create is ENOENT.

    Args:
        vis (Visibility | None): the session's visibility.
        virtual (str): the hidden virtual path.
        create (bool): whether the op creates the path it names; a
            rename or copy destination is one.
        links (Mapping[str, str] | None): the namespace's links, so a
            directory reached through a link into hidden space counts
            as hidden; None when no link is in question.
    """
    above = parent(virtual.rstrip("/") or "/")
    if (
        create
        and path_visible(vis, above)
        and not leads_hidden(vis, above, links or {})
    ):
        return eacces(virtual)
    return enoent(virtual)


def set_admission(gate: EntryGate) -> CallerToken:
    """Bind the admitted command's entry gate to the current async
    context, for the run of that one command.

    Set by the dispatcher once the gate let the command through and
    reset when the command returns, so a nested line (``xargs``,
    ``find -exec``, ``eval``) binds its own and the outer command gets
    its gate back, and a pipeline stage in its own task never sees a
    sibling's.

    Args:
        gate (EntryGate): the admitted command's gate.
    """
    return _bind(gate=gate)


def reset_admission(token: CallerToken) -> None:
    """Restore the previous admission binding."""
    reset_caller(token)


def get_admission() -> EntryGate | None:
    """The entry gate of the command running in this context, None
    when no admitted command is bound (a command constructed outside
    the dispatcher, or a line no gate judged)."""
    return _caller.get().gate


def set_mount_gate(prefix: str, mode: MountMode) -> CallerToken:
    """Bind the executing mount's prefix and configured mode to the
    current async context, for the run of one command.

    ``Mount.run_command`` binds the same around the handler: its files'
    calls read it (``get_mount_gate``) to tell a run on one mount from a
    line that spans mounts, and to ask that mount's facts.

    Args:
        prefix (str): the mount's prefix.
        mode (MountMode): the mount's configured mode.
    """
    return _bind(mount=(prefix, mode))


def reset_mount_gate(token: CallerToken) -> None:
    """Restore the previous mount binding."""
    reset_caller(token)


def get_mount_gate() -> tuple[str, MountMode] | None:
    """The executing mount's (prefix, configured mode), None outside a
    mount's command: a line that spans mounts, run through the dispatcher
    alone, or the scratch tier."""
    return _caller.get().mount


def set_refusal_sink(sink: RefusalSink) -> CallerToken:
    """Bind where the entry points note a policy's refusal, for one line's run.

    Set by the workspace around a typed line: a command renders an op
    refusal in its own GNU words, which say nothing of the policy, so
    the entry point notes the record here and the line carries it on its
    result. Every task and nested line the line starts inherits the
    binding, so a stream drained after its command returned still
    reaches it.

    Args:
        sink (RefusalSink): takes each record as an entry point raises it.
    """
    return _bind(refusals=sink)


def reset_refusal_sink(token: CallerToken) -> None:
    """Restore the previous refusal-sink binding."""
    reset_caller(token)


def line_running() -> bool:
    """Whether a typed line is running in this context: the entry point it
    reaches is inside a command, not a file tool's or the host's own
    call."""
    return _caller.get().refusals is not None


def set_explaining(
    trace: list[VfsExplanation] | DryRun | None,
) -> CallerToken:
    """Make the calls in this context a dry run: the op gate notes on
    ``trace`` what it would answer and stops the op before any backend
    or cache is touched. ``DryRun.DECIDING`` is what a policy does while
    it decides the op explained: its reads run, nothing changes.

    Args:
        trace (list[VfsExplanation] | DryRun | None): where the gate notes
            its answers, DECIDING for a deciding policy's ops, None to
            run.
    """
    return _bind(explaining=trace)


def reset_explaining(token: CallerToken) -> None:
    """Restore the previous dry-run binding."""
    reset_caller(token)


def explaining() -> list[VfsExplanation] | DryRun | None:
    """The dry run's trace when the calls in this context only explain,
    DECIDING while its policies decide, None when they run."""
    return _caller.get().explaining


def note_refusal(refusal: Refusal) -> None:
    """Hand an entry point's refusal to the line running in this context; an
    entry point reached outside any line (a programmatic op) has no line to
    tell, and the record rides the raised error alone.

    Args:
        refusal (Refusal): the policy's record.
    """
    sink = _caller.get().refusals
    if sink is not None:
        sink(refusal)


def get_walk_probe() -> WalkProbe | None:
    """The walk probe bound to the running command, None outside a
    mount's command (a generic invoked directly in a test)."""
    return _caller.get().walk_probe


def set_redirect_paths(
    node_id: int,
    paths: tuple[PathSpec, ...],
    runner: RedirectRunner | None = None,
    syntax: tuple[Redirect, ...] = (),
) -> CallerToken:
    """Bind a statement's expanded redirect targets to the command node
    they belong to, for that node's run.

    The redirect layer expands the targets before the command executes
    (a ``$()`` in one runs exactly once there), so the admission gate
    deep in command dispatch cannot re-derive them; it reads them here
    instead. Keyed by the tree-sitter node id so a nested line expanded
    on the way to the command (a ``$()`` operand, an ``eval``) never
    inherits the outer statement's targets.

    The runner applies redirects after command words expand, admitting
    each resolved target before opening it. Nested expansions retain
    their own command identity and never inherit this runner.

    Args:
        node_id (int): the command node the targets belong to.
        paths (tuple[PathSpec, ...]): the expanded targets.
        runner (RedirectRunner | None): runs the command under its redirects.
        syntax (tuple[Redirect, ...]): pending redirects to carry through a rewrite.
    """
    return _bind(redirects=(node_id, paths, runner, syntax))


def reset_redirect_paths(token: CallerToken) -> None:
    """Restore the previous redirect-target binding."""
    reset_caller(token)


def redirect_paths_for(node_id: int) -> tuple[PathSpec, ...]:
    """The redirect targets bound to this command node, empty for any
    other node or when none are bound.

    Args:
        node_id (int): the command node about to be admitted.
    """
    bound = _caller.get().redirects
    if bound is None or bound[0] != node_id:
        return ()
    return bound[1]


def redirect_syntax_for(node_id: int) -> tuple[Redirect, ...]:
    """Pending redirects, before a rewritten command reaches admission.

    Args:
        node_id (int): the command or rewritten program holding the redirects.
    """
    bound = _caller.get().redirects
    return bound[3] if bound is not None and bound[0] == node_id else ()


def redirect_runner_for(node_id: int) -> RedirectRunner | None:
    """The runner bound with this command node's redirect targets, None
    for any other node or when none is bound.

    Args:
        node_id (int): the command node just admitted.
    """
    bound = _caller.get().redirects
    if bound is None or bound[0] != node_id:
        return None
    return bound[2]


def set_program_invocation(session: SessionState) -> CallerToken:
    """Mark the line about to run in a session as a program run.

    ``find -exec`` hands its words to ``execvp``, so the head it runs is
    the coreutils program, not the shell's builtin of the same name:
    ``printf -v`` is a format string there, not an assignment. Keyed
    by the session object, which the child shells it starts inherit,
    and cleared again by a nested shell the line starts (``-exec sh -c
    ...``), so that shell's builtins are its own.

    Args:
        session (SessionState): the session the program line runs in.
    """
    return _bind(program=session)


def clear_program_invocation() -> CallerToken:
    """Mark the line about to run as a shell's own again: a nested shell
    (``-exec sh -c ...``) is a program, and the builtins it runs are its
    builtins, ``printf -v`` included."""
    return _bind(program=None)


def reset_program_invocation(token: CallerToken) -> None:
    """Restore the previous program-run marking."""
    reset_caller(token)


def program_invocation(session: SessionState) -> bool:
    """Whether the line running in this session is a program run.

    Args:
        session (SessionState): the session a builtin is answering in.
    """
    caller = _caller.get()
    marked = caller.program
    if marked is None:
        return False
    if session is marked:
        return True
    if caller.session is not session:
        return False
    evaluation = caller.evaluation
    parent = evaluation.parent if evaluation is not None else None
    while parent is not None:
        if parent.session is marked:
            return True
        parent = parent.parent
    return False


def redirect_target_judged(virtual: str) -> bool:
    """Whether a path is a redirect target command admission already
    judged for the statement writing it now.

    The dispatcher asks this, and unlike :func:`redirect_paths_for` it
    takes no node id, because by the time the shell writes the file the
    node has returned and the dispatcher sees only a path. The binding is what
    keeps that honest: it exists only while one statement's targets are
    being written, and a statement whose targets a rule refused never
    reaches the write at all. So a bound target is one the line was
    admitted with, and re-deriving a verdict for it from the dispatcher, which
    knows neither the line nor the nod it holds, can only get it wrong.

    Args:
        virtual (str): absolute virtual path of the op.
    """
    bound = _caller.get().redirects
    return bound is not None and any(p.virtual == virtual for p in bound[1])


def effective_mount_mode(
    mount_prefix: str, mount_mode: MountMode
) -> MountMode:
    """The mount mode after narrowing by the current session's cap.

    The mount's own mode is the strongest one available; a profile's mode
    can only weaken it (a READ mount stays read-only whatever the profile
    says). A mount the profile does not name keeps its own mode.

    Args:
        mount_prefix (str): the mount's prefix, e.g. ``/s3``.
        mount_mode (MountMode): the mount's configured mode.
    """
    return weaker_mode(mount_mode, _session_mode(mount_prefix))


def effective_path_mode(
    virtual: str,
    mount_prefix: str,
    mount_mode: MountMode,
    access: SessionAccess | None = None,
) -> MountMode:
    """The mode in force at one path: the whole VFS axis on the one
    anchor-depth rule.

    The mount's configured mode is narrowed by the deepest session
    statement covering the path, where a statement is the profile's
    per-mount mode (scored at the mount prefix's own depth) or a
    mode-carrying show entry (scored at its anchor depth). Deeper wins,
    so ``mounts: {/repo: r}`` with ``show: {"/repo/build": rw}`` reads
    the repo and writes only the build tree; an equal-depth pair takes
    the weaker, failing toward refusal. The configured mode stays the
    strongest answer possible: the document never grants past it.

    Args:
        virtual (str): absolute virtual path the op touches.
        mount_prefix (str): the owning mount's prefix.
        mount_mode (MountMode): the mount's configured mode.
        access (SessionAccess | None): explicit owner, else the current context.
    """
    return _path_mode_under(
        access if access is not None else get_current_session(),
        virtual,
        mount_prefix,
        mount_mode,
    )


def _path_mode_under(
    sess: SessionState | SessionAccess | None,
    virtual: str,
    mount_prefix: str,
    mount_mode: MountMode,
) -> MountMode:
    if sess is None:
        return mount_mode
    prefix = norm(mount_prefix)
    cap = (
        sess.mount_modes.get(prefix) if sess.mount_modes is not None else None
    )
    best_depth = anchor_depth(prefix) if cap is not None else None
    best_mode = cap
    deepest = shown_mode(
        sess.visibility.shown if sess.visibility is not None else None, virtual
    )
    if deepest is not None:
        depth, mode = deepest
        if best_depth is None or depth > best_depth:
            best_depth, best_mode = depth, mode
        elif depth == best_depth and best_mode is not None:
            best_mode = weaker_mode(best_mode, mode)
    if best_mode is None:
        return mount_mode
    return weaker_mode(mount_mode, best_mode)


def _reaches_under(head: str, prefix: str) -> bool:
    """Whether a show anchor could cover any path under a mount prefix:
    the anchor lies at or under the prefix, or the prefix inside the
    anchor's subtree.

    Args:
        head (str): the show entry's anchor, normalized.
        prefix (str): the mount prefix, normalized.
    """
    return (
        head == "/"
        or prefix == "/"
        or head == prefix
        or head.startswith(prefix + "/")
        or prefix.startswith(head + "/")
    )


def strongest_under_session(
    sess: SessionState | SessionAccess,
    mount_prefix: str,
    mount_mode: MountMode,
) -> MountMode:
    """The strongest mode one session reaches anywhere under a mount:
    its mount-wide mode, or a deeper show grant, still capped by the
    mount's configured mode.

    Args:
        sess (SessionState | SessionAccess): the session.
        mount_prefix (str): the mount's prefix.
        mount_mode (MountMode): the mount's configured mode.
    """
    cap = (
        sess.mount_modes.get(norm(mount_prefix), MountMode.EXEC)
        if sess.mount_modes is not None
        else MountMode.EXEC
    )
    best = weaker_mode(mount_mode, cap)
    shown = sess.visibility.shown if sess.visibility is not None else None
    if shown is None:
        return best
    prefix = norm(mount_prefix)
    for entry in shown.entries:
        if entry.mode is None:
            continue
        if _reaches_under(show_head(entry.path), prefix):
            reached = weaker_mode(mount_mode, entry.mode)
            if MOUNT_MODE_RANK[reached] > MOUNT_MODE_RANK[best]:
                best = reached
    return best


def strongest_mode_under(
    mount_prefix: str,
    mount_mode: MountMode,
    access: SessionAccess | None = None,
) -> MountMode:
    """The strongest mode the current session reaches anywhere under a
    mount (:func:`strongest_under_session`), the mount's own mode when no
    session is bound.

    What the whole-mount gates read: a write command stays runnable on
    a mount whose only writable region is a show entry (the dispatcher
    then refuses per path), and the interpreters' any-``x`` rule counts
    a show grant the way it counts a whole mount.

    Args:
        mount_prefix (str): the mount's prefix.
        mount_mode (MountMode): the mount's configured mode.
    """
    if access is not None:
        return strongest_under_session(access, mount_prefix, mount_mode)
    sess = get_current_session()
    if sess is None:
        return mount_mode
    return strongest_under_session(sess, mount_prefix, mount_mode)


def readonly_below(
    virtual: str,
    mount_prefix: str,
    mount_mode: MountMode,
    access: SessionAccess | None = None,
) -> str | None:
    """The path to blame when a subtree mutation reaches into a
    read-only region below its operand, None when nothing below is
    weaker.

    The dual of the per-path check, for the ops that mutate a whole
    subtree in one backend call (``rm -r``, a directory rename, a
    native ``cp -r``): the operand's own region may grant writes while
    a mode-carrying show entry holds a deeper subtree to ``r``, and the
    backend cannot honor that boundary mid-call, so the caller refuses
    the operand up front. An exact entry is blamed by its anchor, the
    row GNU would report the refusal on; a pattern names no single
    anchor, so the operand itself is blamed whenever the pattern's
    match space could reach below it, failing toward refusal.

    Args:
        virtual (str): absolute virtual path the mutation covers.
        mount_prefix (str): the owning mount's prefix.
        mount_mode (MountMode): the mount's configured mode.
        access (SessionAccess | None): explicit owner, else the current context.
    """
    return _readonly_below_under(
        access if access is not None else get_current_session(),
        virtual,
        mount_prefix,
        mount_mode,
    )


def _readonly_below_under(
    sess: SessionState | SessionAccess | None,
    virtual: str,
    mount_prefix: str,
    mount_mode: MountMode,
) -> str | None:
    shown = (
        sess.visibility.shown
        if sess is not None and sess.visibility is not None
        else None
    )
    if shown is None:
        return None
    v = "/" + virtual.strip("/")
    for entry in shown.entries:
        if entry.mode is None:
            continue
        if is_glob(entry.path):
            if entry.mode == MountMode.READ and _reaches_under(
                show_head(entry.path), v
            ):
                return virtual
            continue
        anchor = "/" + entry.path.strip("/")
        below = anchor != "/" if v == "/" else anchor.startswith(v + "/")
        if not below:
            continue
        if (
            _path_mode_under(sess, anchor, mount_prefix, mount_mode)
            == MountMode.READ
        ):
            return anchor
    return None


def require_paths_writable(
    paths: Sequence[PathSpec],
    mount_prefix: str,
    mount_mode: MountMode,
    *,
    subtree: bool = False,
    access: SessionAccess | None = None,
) -> None:
    """Apply the same mode ceiling to command, dispatcher and namespace writes.

    Args:
        paths (Sequence[PathSpec]): written endpoints, excluding copy sources.
        mount_prefix (str): the governing mount prefix.
        mount_mode (MountMode): the configured authorization ceiling.
        subtree (bool): whether each endpoint's descendants are mutated.
        access (SessionAccess | None): explicit owner, else the current context.
    """
    for path in paths:
        if (
            effective_path_mode(path.virtual, mount_prefix, mount_mode, access)
            == MountMode.READ
        ):
            raise erofs(path.virtual)
    if subtree:
        for path in paths:
            blame = readonly_below(
                path.virtual, mount_prefix, mount_mode, access
            )
            if blame is not None:
                raise erofs(blame)


def session_access(session: SessionState | None) -> SessionAccess:
    """Bind access to its owner before an asynchronous operation suspends.

    Args:
        session (SessionState | None): the owner; None answers as an
            unrestricted session with bash's default mask.
    """
    return SessionAccess(
        session_id=session.session_id if session is not None else "",
        visibility=session.visibility if session is not None else None,
        umask=session.umask if session is not None else DEFAULT_UMASK,
        shopts=session.shopts if session is not None else {},
        mount_modes=session.mount_modes if session is not None else None,
    )

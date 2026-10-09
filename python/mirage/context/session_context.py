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

from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from contextvars import ContextVar, Token
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from mirage.errors.fs import eacces, enoent, erofs
from mirage.policy.types import DryRun, EntryGate, VfsExplanation
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
    path_visible,
    show_head,
    shown_mode,
)
from mirage.utils.path import parent
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.session.session import SessionState

if TYPE_CHECKING:
    from mirage.io.types import ByteSource, IOResult
    from mirage.shell.console import JobConsole
    from mirage.shell.types import Redirect
    from mirage.workspace.types import ExecutionNode


class SessionOwner(ABC):
    """Whoever binds sessions: one per workspace, compared by identity."""

    @abstractmethod
    def get(self, session_id: str) -> SessionState:
        """The session this owner holds under ``session_id``.

        Args:
            session_id (str): the session's id.
        """


@dataclass(frozen=True, slots=True)
class SessionBinding:
    """The session bound to one async context, whose it is, and the
    evaluation running on it.

    Args:
        session (SessionState | None): the live session.
        owner (SessionOwner | None): the session manager the session
            belongs to, which is one per workspace. None when the
            binder did not name one.
        evaluation (EvaluationContext | None): the evaluation running
            on the session, None outside one. It is part of the
            binding, so a scope bound to another session never carries
            this one's evaluation, with its frame and cancellation.
    """

    session: SessionState | None
    owner: SessionOwner | None
    evaluation: EvaluationContext | None = None


_current_session: ContextVar[SessionBinding | None] = ContextVar(
    "mirage_current_session",
    default=None,
)


def set_current_session(
    session: SessionState | None,
    owner: SessionOwner | None = None,
    *,
    evaluation: EvaluationContext | None = None,
) -> Token[Any]:
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
    current = _current_session.get()
    if owner is None:
        owner = current.owner if current is not None else None
    if (
        evaluation is None
        and current is not None
        and current.session is session
    ):
        evaluation = current.evaluation
    return _current_session.set(
        SessionBinding(session=session, owner=owner, evaluation=evaluation)
    )


def reset_current_session(token: Token[Any]) -> None:
    """Restore the previous session binding."""
    _current_session.reset(token)


def get_current_session() -> SessionState | None:
    """Return the session bound to the current async context, if any."""
    binding = _current_session.get()
    return binding.session if binding is not None else None


def set_current_evaluation(
    context: EvaluationContext, owner: SessionOwner | None = None
) -> Token[Any]:
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
    binding = _current_session.get()
    return binding.evaluation if binding is not None else None


def get_current_session_for(owner: SessionOwner) -> SessionState | None:
    """Return the bound session only when ``owner`` published it.

    A session carries one workspace's cwd, env and mount grants, so a
    second workspace re-entered mid-line must resolve its own session
    rather than adopt this one.

    Args:
        owner (SessionOwner): the asking workspace's session manager.
    """
    binding = _current_session.get()
    if binding is None or binding.owner is not owner:
        return None
    return binding.session


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
    binding = _current_session.get()
    if binding is None or (
        binding.owner is not None and binding.owner is not owner
    ):
        return None
    return binding.session


def _norm_prefix(mount_prefix: str) -> str:
    stripped = mount_prefix.strip("/")
    return "/" + stripped if stripped else "/"


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
    return sess.mount_modes.get(_norm_prefix(mount_prefix), MountMode.EXEC)


DEFAULT_UMASK = 0o022


def session_umask() -> int:
    """The file-creation mask of the session bound to this context.

    Read by the creators that run inside a command handler (`mkdir`,
    which cannot be handed the session) the way `dotglob_active` reads
    the shell options: bash's default when no session is bound,
    which is also what mirage's own 644/755 defaults for a new entry
    already assume.

    Args:
        None
    """
    sess = get_current_session()
    return DEFAULT_UMASK if sess is None else sess.umask


def dotglob_active() -> bool:
    """Whether the bound session's `shopt -s dotglob` is on.

    Read inside pathname expansion, which runs in every backend's
    `resolve_glob` and so cannot be handed the session: bash's rule is
    that a name starting with `.` is matched only by a pattern that
    starts with `.`, and `dotglob` is the one thing that relaxes it.
    False when no session is bound, which is bash's default.

    Args:
        None
    """
    sess = get_current_session()
    return sess is not None and bool(sess.shopts.get("dotglob"))


def session_visibility() -> Visibility | None:
    """The bound session's visibility, None when no session is bound.

    For the op boundary, which runs under the session it serves and
    answers a hidden path as absent. A command reads the visibility off
    its namespace view (``opts.ns.visibility``) instead, so nothing past
    the boundary consults the session about what exists.

    Args:
        None
    """
    sess = get_current_session()
    return sess.visibility if sess is not None else None


def hidden_refusal(
    vis: Visibility | None, virtual: str, create: bool
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
    """
    if create and path_visible(vis, parent(virtual.rstrip("/") or "/")):
        return eacces(virtual)
    return enoent(virtual)


_current_admission: ContextVar[EntryGate | None] = ContextVar(
    "mirage_current_admission",
    default=None,
)


def set_admission(gate: EntryGate) -> Token[Any]:
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
    return _current_admission.set(gate)


def reset_admission(token: Token[Any]) -> None:
    """Restore the previous admission binding."""
    _current_admission.reset(token)


def get_admission() -> EntryGate | None:
    """The entry gate of the command running in this context, None
    when no admitted command is bound (a command constructed outside
    the dispatcher, or a line no gate judged)."""
    return _current_admission.get()


_current_mount_gate: ContextVar[tuple[str, MountMode] | None] = ContextVar(
    "mirage_current_mount_gate",
    default=None,
)


def set_mount_gate(prefix: str, mode: MountMode) -> Token[Any]:
    """Bind the executing mount's prefix and configured mode to the
    current async context, for the run of one command.

    Set by ``Mount.run_command`` around the handler, so the mode guard
    on the command tier's I/O can resolve ``effective_path_mode`` for
    every path a handler mutates: a path-guarded command is refused only
    at its writes, the write-command gate admits any other when a shown
    subtree grants writes, and this binding is how each individual write
    is then held to its own region's mode.

    Args:
        prefix (str): the mount's prefix.
        mode (MountMode): the mount's configured mode.
    """
    return _current_mount_gate.set((prefix, mode))


def reset_mount_gate(token: Token[Any]) -> None:
    """Restore the previous mount binding."""
    _current_mount_gate.reset(token)


def get_mount_gate() -> tuple[str, MountMode] | None:
    """The executing mount's (prefix, configured mode), None outside a
    mount's command (a generic invoked directly in a test, or the
    scratch tier)."""
    return _current_mount_gate.get()


# Where a refusal an entry point raises is noted for the line running it.
RefusalSink = Callable[[Refusal], None]

_refusal_sink: ContextVar[RefusalSink | None] = ContextVar(
    "mirage_refusal_sink",
    default=None,
)


def set_refusal_sink(sink: RefusalSink) -> Token[Any]:
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
    return _refusal_sink.set(sink)


def reset_refusal_sink(token: Token[Any]) -> None:
    """Restore the previous refusal-sink binding."""
    _refusal_sink.reset(token)


def line_running() -> bool:
    """Whether a typed line is running in this context: the entry point it
    reaches is inside a command, not a file tool's or the host's own
    call."""
    return _refusal_sink.get() is not None


_explaining: ContextVar[list[VfsExplanation] | DryRun | None] = ContextVar(
    "mirage_explaining",
    default=None,
)


def set_explaining(
    trace: list[VfsExplanation] | DryRun | None,
) -> Token[Any]:
    """Make the calls in this context a dry run: the op gate notes on
    ``trace`` what it would answer and stops the op before any backend
    or cache is touched. ``DryRun.DECIDING`` is what a policy does while
    it decides the op explained: its reads run, nothing changes.

    Args:
        trace (list[VfsExplanation] | DryRun | None): where the gate notes
            its answers, DECIDING for a deciding policy's ops, None to
            run.
    """
    return _explaining.set(trace)


def reset_explaining(token: Token[Any]) -> None:
    """Restore the previous dry-run binding."""
    _explaining.reset(token)


def explaining() -> list[VfsExplanation] | DryRun | None:
    """The dry run's trace when the calls in this context only explain,
    DECIDING while its policies decide, None when they run."""
    return _explaining.get()


def note_refusal(refusal: Refusal) -> None:
    """Hand an entry point's refusal to the line running in this context; an
    entry point reached outside any line (a programmatic op) has no line to
    tell, and the record rides the raised error alone.

    Args:
        refusal (Refusal): the policy's record.
    """
    sink = _refusal_sink.get()
    if sink is not None:
        sink(refusal)


_current_walk_probe: ContextVar[WalkProbe | None] = ContextVar(
    "mirage_current_walk_probe",
    default=None,
)


def set_walk_probe(probe: WalkProbe) -> Token[Any]:
    """Bind what a command's dot walks read, for the run of one command.

    Set by ``Mount.run_command`` around the handler, beside the mount
    gate: the command tier reaches its backend without passing the
    dispatcher, so the walk guard on its I/O proves an operand's
    ``.`` and ``..`` with the dispatcher's stat and link follow through this
    binding.

    Args:
        probe (WalkProbe): the dispatcher's stat and the namespace's follow.
    """
    return _current_walk_probe.set(probe)


def reset_walk_probe(token: Token[Any]) -> None:
    """Restore the previous walk-probe binding."""
    _current_walk_probe.reset(token)


def get_walk_probe() -> WalkProbe | None:
    """The walk probe bound to the running command, None outside a
    mount's command (a generic invoked directly in a test)."""
    return _current_walk_probe.get()


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

_redirect_paths: ContextVar[
    tuple[
        int,
        tuple[PathSpec, ...],
        RedirectRunner | None,
        tuple["Redirect", ...],
    ]
    | None
] = ContextVar("mirage_redirect_paths", default=None)


def set_redirect_paths(
    node_id: int,
    paths: tuple[PathSpec, ...],
    runner: RedirectRunner | None = None,
    syntax: tuple["Redirect", ...] = (),
) -> Token[Any]:
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
    return _redirect_paths.set((node_id, paths, runner, syntax))


def reset_redirect_paths(token: Token[Any]) -> None:
    """Restore the previous redirect-target binding."""
    _redirect_paths.reset(token)


def redirect_paths_for(node_id: int) -> tuple[PathSpec, ...]:
    """The redirect targets bound to this command node, empty for any
    other node or when none are bound.

    Args:
        node_id (int): the command node about to be admitted.
    """
    bound = _redirect_paths.get()
    if bound is None or bound[0] != node_id:
        return ()
    return bound[1]


def redirect_syntax_for(node_id: int) -> tuple["Redirect", ...]:
    """Pending redirects, before a rewritten command reaches admission.

    Args:
        node_id (int): the command or rewritten program holding the redirects.
    """
    bound = _redirect_paths.get()
    return bound[3] if bound is not None and bound[0] == node_id else ()


def redirect_runner_for(node_id: int) -> RedirectRunner | None:
    """The runner bound with this command node's redirect targets, None
    for any other node or when none is bound.

    Args:
        node_id (int): the command node just admitted.
    """
    bound = _redirect_paths.get()
    if bound is None or bound[0] != node_id:
        return None
    return bound[2]


_program_invocation: ContextVar[SessionState | None] = ContextVar(
    "mirage_program_invocation", default=None
)


def set_program_invocation(session: SessionState) -> Token[Any]:
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
    return _program_invocation.set(session)


def clear_program_invocation() -> Token[Any]:
    """Mark the line about to run as a shell's own again: a nested shell
    (``-exec sh -c ...``) is a program, and the builtins it runs are its
    builtins, ``printf -v`` included."""
    return _program_invocation.set(None)


def reset_program_invocation(token: Token[Any]) -> None:
    """Restore the previous program-run marking."""
    _program_invocation.reset(token)


def program_invocation(session: SessionState) -> bool:
    """Whether the line running in this session is a program run.

    Args:
        session (SessionState): the session a builtin is answering in.
    """
    marked = _program_invocation.get()
    if marked is None:
        return False
    if session is marked:
        return True
    binding = _current_session.get()
    if binding is None or binding.session is not session:
        return False
    evaluation = binding.evaluation
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
    bound = _redirect_paths.get()
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
    virtual: str, mount_prefix: str, mount_mode: MountMode
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
    """
    sess = get_current_session()
    if sess is None:
        return mount_mode
    prefix = _norm_prefix(mount_prefix)
    cap = (
        sess.mount_modes.get(prefix) if sess.mount_modes is not None else None
    )
    best_depth = anchor_depth(prefix) if cap is not None else None
    best_mode = cap
    deepest = shown_mode(sess.visibility.shown, virtual)
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
    sess: SessionState, mount_prefix: str, mount_mode: MountMode
) -> MountMode:
    """The strongest mode one session reaches anywhere under a mount:
    its mount-wide mode, or a deeper show grant, still capped by the
    mount's configured mode.

    Args:
        sess (SessionState): the session.
        mount_prefix (str): the mount's prefix.
        mount_mode (MountMode): the mount's configured mode.
    """
    cap = (
        sess.mount_modes.get(_norm_prefix(mount_prefix), MountMode.EXEC)
        if sess.mount_modes is not None
        else MountMode.EXEC
    )
    best = weaker_mode(mount_mode, cap)
    shown = sess.visibility.shown
    if shown is None:
        return best
    prefix = _norm_prefix(mount_prefix)
    for entry in shown.entries:
        if entry.mode is None:
            continue
        if _reaches_under(show_head(entry.path), prefix):
            reached = weaker_mode(mount_mode, entry.mode)
            if MOUNT_MODE_RANK[reached] > MOUNT_MODE_RANK[best]:
                best = reached
    return best


def strongest_mode_under(
    mount_prefix: str, mount_mode: MountMode
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
    sess = get_current_session()
    if sess is None:
        return mount_mode
    return strongest_under_session(sess, mount_prefix, mount_mode)


def readonly_below(
    virtual: str, mount_prefix: str, mount_mode: MountMode
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
    """
    sess = get_current_session()
    shown = sess.visibility.shown if sess is not None else None
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
            effective_path_mode(anchor, mount_prefix, mount_mode)
            == MountMode.READ
        ):
            return anchor
    return None


def require_paths_writable(
    paths: list[PathSpec],
    mount_prefix: str,
    mount_mode: MountMode,
    *,
    subtree: bool = False,
) -> None:
    """Apply the same mode ceiling to command, dispatcher and namespace writes.

    Args:
        paths (list[PathSpec]): written endpoints, excluding copy sources.
        mount_prefix (str): the governing mount prefix.
        mount_mode (MountMode): the configured authorization ceiling.
        subtree (bool): whether each endpoint's descendants are mutated.
    """
    for path in paths:
        if (
            effective_path_mode(path.virtual, mount_prefix, mount_mode)
            == MountMode.READ
        ):
            raise erofs(path.virtual)
    if subtree:
        for path in paths:
            blame = readonly_below(path.virtual, mount_prefix, mount_mode)
            if blame is not None:
                raise erofs(blame)


def require_mount_writable() -> None:
    """Refuse a service-addressed write unless the whole mount's
    effective mode grants writes.

    For bespoke commands whose write is addressed by a service id
    rather than a path (trello's card writes): the admission gate lets
    them run while any shown subtree grants writes, but an id names no
    path a per-path check could judge, so only the mount-wide grant
    counts and a write-granting carve-out alone refuses, failing
    toward refusal. Inert outside a mount's command.

    Args:
        None
    """
    gate = get_mount_gate()
    if gate is None:
        return
    prefix, mode = gate
    if effective_mount_mode(prefix, mode) == MountMode.READ:
        raise erofs(prefix)

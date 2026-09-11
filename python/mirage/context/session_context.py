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

import errno
from contextvars import ContextVar, Token
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from mirage.types import (MOUNT_MODE_RANK, EntryGate, MountMode, PathSpec,
                          weaker_mode)
from mirage.utils.errors import ReadOnlyError
from mirage.utils.hidden import (anchor_depth, hides_intersect, is_glob,
                                 path_visible, show_head, shown_mode)

if TYPE_CHECKING:
    from mirage.policy.policies import Policies
    from mirage.workspace.session.manager import SessionManager
    from mirage.workspace.session.session import Session


@dataclass(frozen=True, slots=True)
class SessionBinding:
    """The session bound to one async context, and whose it is.

    Args:
        session (Session | None): the live session.
        owner (SessionManager | None): the session manager the session
            belongs to, which is one per workspace. None when the
            binder did not name one.
    """
    session: "Session | None"
    owner: "SessionManager | None"


_current_session: ContextVar[SessionBinding | None] = ContextVar(
    "mirage_current_session",
    default=None,
)


def set_current_session(session: "Session | None",
                        owner: "SessionManager | None" = None) -> Token[Any]:
    """Bind ``session`` to the current async context.

    Args:
        session (Session | None): the session to bind.
        owner (SessionManager | None): the manager the session belongs
            to. None keeps the owner already bound, so a nested bind
            inside a line (a background job's fork) stays attributed to
            the workspace running it.
    """
    if owner is None:
        current = _current_session.get()
        owner = current.owner if current is not None else None
    return _current_session.set(SessionBinding(session=session, owner=owner))


def reset_current_session(token: Token[Any]) -> None:
    """Restore the previous session binding."""
    _current_session.reset(token)


def get_current_session() -> "Session | None":
    """Return the session bound to the current async context, if any."""
    binding = _current_session.get()
    return binding.session if binding is not None else None


def get_current_session_for(owner: "SessionManager") -> "Session | None":
    """Return the bound session only when ``owner`` published it.

    A session carries one workspace's cwd, env and mount grants, so a
    second workspace re-entered mid-line must resolve its own session
    rather than adopt this one.

    Args:
        owner (SessionManager): the asking workspace's session manager.
    """
    binding = _current_session.get()
    if binding is None or binding.owner is not owner:
        return None
    return binding.session


def _norm_prefix(mount_prefix: str) -> str:
    stripped = mount_prefix.strip("/")
    return "/" + stripped if stripped else "/"


def _session_mode(mount_prefix: str) -> "MountMode":
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


def hidden_paths_active() -> bool:
    """Whether the current session hides any paths at all.

    For a summarizing fast path (du -s asks the backend for one total)
    that must not be trusted when hidden leaves could be inside it.
    Show entries do not trip it: a show without a covering hide
    restricts nothing, and modes never change what a walk enumerates.

    Args:
        None
    """
    sess = get_current_session()
    return sess is not None and sess.hidden_paths is not None


def hidden_paths_intersect(virtual: str) -> bool:
    """Whether the current session hides anything at or under this
    path: the per-operand form of :func:`hidden_paths_active`.

    The native fast paths (find's native op, du's summarize total)
    classify the raw backend tree, so they fork to the guarded walk
    when a hide could cover an entry inside the subtree they answer
    for, and stay on when none can: one hidden ``.env`` under ``/repo``
    must not force ``find`` on ``/s3`` off its native op.

    Args:
        virtual (str): absolute virtual path of the walk's start point.
    """
    sess = get_current_session()
    return sess is not None and hides_intersect(sess.hidden_paths, virtual)


DEFAULT_UMASK = 0o022


def session_umask() -> int:
    """The file-creation mask of the session bound to this context.

    Read by the creators that run inside a command handler (`mkdir`,
    which cannot be handed the session) the way `path_allowed` reads
    the hidden-paths spec: bash's default when no session is bound,
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


def session_path_allowed(sess: "Session", virtual: str) -> bool:
    """Whether a session's path axis leaves this path visible: its
    hides, re-opened where a deeper show entry says so.

    The explicit-session form of ``path_allowed``, for a door that
    holds the session rather than running under it: the admission
    gate drops a hidden operand before any policy reads it, so a rule
    or an ask never names a path the session cannot see.

    Args:
        sess (Session): the session asking.
        virtual (str): absolute virtual path.
    """
    return path_visible(sess.hidden_paths, sess.shown_paths, virtual)


def path_allowed(virtual: str) -> bool:
    """Whether the current session's hidden-paths specs, its own and
    the workspace-bound one, leave this path visible.

    Enumeration surfaces filter
    names through it and the doors answer ENOENT (EACCES for creates)
    when it says no, so hiding reads as nonexistence, never as a
    denial that leaks the name. True when no session is bound or the
    session hides nothing.

    Args:
        virtual (str): absolute virtual path.
    """
    sess = get_current_session()
    return sess is None or session_path_allowed(sess, virtual)


_current_admission: ContextVar["EntryGate | None"] = ContextVar(
    "mirage_current_admission",
    default=None,
)


def set_admission(gate: "EntryGate") -> Token[Any]:
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


def get_admission() -> "EntryGate | None":
    """The entry gate of the command running in this context, None
    when no admitted command is bound (a command constructed outside
    the dispatcher, or a line no gate judged)."""
    return _current_admission.get()


_op_policies: ContextVar["Policies | None"] = ContextVar(
    "mirage_op_policies",
    default=None,
)


def set_op_policies(policies: "Policies") -> Token[Any]:
    """Bind the workspace's admission policies to the current async
    context, for the run of one command.

    Set by command dispatch around routing, the same window the
    admission gate binds in, so the command tier's policy guard can
    fire ``pre_ops`` for the backend I/O a handler performs. Read at
    call time by ``with_policy_guard``; unset outside a dispatched
    command (a generic invoked directly in a test), where the guard
    is inert.

    Args:
        policies (Policies): the workspace's admission policies.
    """
    return _op_policies.set(policies)


def suspend_op_policies() -> Token[Any]:
    """Unbind the op policies for a delegated sub-command whose door
    the caller has already cleared.

    find's ``-delete`` admits each removal itself, in find's own
    refusal voice, and then delegates the mutation to ``rm``; without
    the suspension the delegated slot would admit the same deletion a
    second time, so a counting or budget policy would see one removal
    twice.
    """
    return _op_policies.set(None)


def reset_op_policies(token: Token[Any]) -> None:
    """Restore the previous policies binding."""
    _op_policies.reset(token)


def get_op_policies() -> "Policies | None":
    """The policies bound to the running command, None outside one."""
    return _op_policies.get()


_current_mount_gate: ContextVar[tuple[str, MountMode] | None] = ContextVar(
    "mirage_current_mount_gate",
    default=None,
)


def set_mount_gate(prefix: str, mode: MountMode) -> Token[Any]:
    """Bind the executing mount's prefix and configured mode to the
    current async context, for the run of one command.

    Set by ``Mount.execute_cmd`` around the handler, so the mode guard
    on the command tier's I/O can resolve ``effective_path_mode`` for
    every path a handler mutates: the write-command gate admits a
    command when any shown subtree grants writes, and this binding is
    how each individual write is then held to its own region's mode.

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


def path_rules_active() -> bool:
    """Whether a path rule in force reads the running command's paths.

    The twin of ``hidden_paths_active`` for the deny rules: a backend's
    native find or du classifies the raw tree, so an entry a rule
    refuses would be listed or summed past the gate; the readdir walk
    passes every entry through it instead. False when no admitted
    command is bound.

    Args:
        None
    """
    gate = get_admission()
    return gate is not None and gate.scoped


_redirect_paths: ContextVar[tuple[int, tuple[PathSpec, ...]]
                            | None] = (ContextVar("mirage_redirect_paths",
                                                  default=None))


def set_redirect_paths(node_id: int, paths: tuple[PathSpec,
                                                  ...]) -> Token[Any]:
    """Bind a statement's expanded redirect targets to the command node
    they belong to, for that node's run.

    The redirect layer expands the targets before the command executes
    (a ``$()`` in one runs exactly once there), so the admission gate
    deep in command dispatch cannot re-derive them; it reads them here
    instead. Keyed by the tree-sitter node id so a nested line expanded
    on the way to the command (a ``$()`` operand, an ``eval``) never
    inherits the outer statement's targets.

    Args:
        node_id (int): the command node the targets belong to.
        paths (tuple[PathSpec, ...]): the expanded targets.
    """
    return _redirect_paths.set((node_id, paths))


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


_program_invocation: ContextVar[int | None] = ContextVar(
    "mirage_program_invocation", default=None)


def set_program_invocation(session: "Session") -> Token[Any]:
    """Mark the line about to run in a session as a program run.

    ``find -exec`` hands its words to ``execvp``, so the head it runs is
    the coreutils program, not the shell's builtin of the same name:
    ``printf -v`` is a format string there, not an assignment. Keyed
    by the session object, and cleared again by a nested shell the
    line starts (``-exec sh -c ...``, which snapshots the same
    session), so that shell's builtins are its own.

    Args:
        session (Session): the session the program line runs in.
    """
    return _program_invocation.set(id(session))


def clear_program_invocation() -> Token[Any]:
    """Mark the line about to run as a shell's own again: a nested shell
    (``-exec sh -c ...``) is a program, and the builtins it runs are its
    builtins, ``printf -v`` included."""
    return _program_invocation.set(None)


def reset_program_invocation(token: Token[Any]) -> None:
    """Restore the previous program-run marking."""
    _program_invocation.reset(token)


def program_invocation(session: "Session") -> bool:
    """Whether the line running in this session is a program run.

    Args:
        session (Session): the session a builtin is answering in.
    """
    return _program_invocation.get() == id(session)


def redirect_target_judged(virtual: str) -> bool:
    """Whether a path is a redirect target the command door already
    judged for the statement writing it now.

    The op doors ask this, and unlike :func:`redirect_paths_for` it
    takes no node id, because by the time the shell writes the file the
    node has returned and a door sees only a path. The binding is what
    keeps that honest: it exists only while one statement's targets are
    being written, and a statement whose targets a rule refused never
    reaches the write at all. So a bound target is one the line was
    admitted with, and re-deriving a verdict for it from a door that
    knows neither the line nor the nod it holds can only get it wrong.

    Args:
        virtual (str): absolute virtual path of the op.
    """
    bound = _redirect_paths.get()
    return bound is not None and any(p.virtual == virtual for p in bound[1])


def effective_mount_mode(mount_prefix: str,
                         mount_mode: MountMode) -> MountMode:
    """The mount mode after narrowing by the current session's cap.

    The mount's own mode is the strongest one available; a profile's mode
    can only weaken it (a READ mount stays read-only whatever the profile
    says). A mount the profile does not name keeps its own mode.

    Args:
        mount_prefix (str): the mount's prefix, e.g. ``/s3``.
        mount_mode (MountMode): the mount's configured mode.
    """
    return weaker_mode(mount_mode, _session_mode(mount_prefix))


def effective_path_mode(virtual: str, mount_prefix: str,
                        mount_mode: MountMode) -> MountMode:
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
    cap = (sess.mount_modes.get(prefix)
           if sess.mount_modes is not None else None)
    best_depth = anchor_depth(prefix) if cap is not None else None
    best_mode = cap
    deepest = shown_mode(sess.shown_paths, virtual)
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
    return (head == "/" or prefix == "/" or head == prefix
            or head.startswith(prefix + "/") or prefix.startswith(head + "/"))


def strongest_mode_under(mount_prefix: str,
                         mount_mode: MountMode) -> MountMode:
    """The strongest mode the current session reaches anywhere under a
    mount: its mount-wide effective mode, or a deeper show grant, still
    capped by the mount's configured mode.

    What the whole-mount gates read: a write command stays runnable on
    a mount whose only writable region is a show entry (the op door
    then refuses per path), and the interpreters' any-``x`` rule counts
    a show grant the way it counts a whole mount.

    Args:
        mount_prefix (str): the mount's prefix.
        mount_mode (MountMode): the mount's configured mode.
    """
    best = effective_mount_mode(mount_prefix, mount_mode)
    sess = get_current_session()
    if sess is None or sess.shown_paths is None:
        return best
    prefix = _norm_prefix(mount_prefix)
    for entry in sess.shown_paths.entries:
        if entry.mode is None:
            continue
        if _reaches_under(show_head(entry.path), prefix):
            reached = weaker_mode(mount_mode, entry.mode)
            if MOUNT_MODE_RANK[reached] > MOUNT_MODE_RANK[best]:
                best = reached
    return best


def readonly_below(virtual: str, mount_prefix: str,
                   mount_mode: MountMode) -> str | None:
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
    if sess is None or sess.shown_paths is None:
        return None
    v = "/" + virtual.strip("/")
    for entry in sess.shown_paths.entries:
        if entry.mode is None:
            continue
        if is_glob(entry.path):
            if entry.mode == MountMode.READ and _reaches_under(
                    show_head(entry.path), v):
                return virtual
            continue
        anchor = "/" + entry.path.strip("/")
        below = anchor != "/" if v == "/" else anchor.startswith(v + "/")
        if not below:
            continue
        if effective_path_mode(anchor, mount_prefix,
                               mount_mode) == MountMode.READ:
            return anchor
    return None


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
        raise ReadOnlyError(errno.EROFS, "Read-only file system", prefix)

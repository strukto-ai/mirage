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
import inspect
import logging
import os
from dataclasses import replace
from typing import TYPE_CHECKING, Any

from mirage.commands.spec.usage import operand_exit_code
from mirage.context import (
    explaining,
    line_running,
    note_refusal,
    reset_explaining,
    set_explaining,
)
from mirage.policy.base import Policy
from mirage.policy.builtin.hidden_paths import HiddenPathsPolicy
from mirage.policy.builtin.mount_mode import MountModePolicy
from mirage.policy.constants import POLICY_DENIED_EXIT
from mirage.policy.errors import Explained, PolicyDenied, PolicyError
from mirage.policy.match.decide import source_of
from mirage.policy.mixin import SessionScopedMixin
from mirage.policy.types import (
    VALIDITY,
    Ask,
    CommandContext,
    Deny,
    DenyScope,
    DryRun,
    ExecuteResultContext,
    Hide,
    OpsContext,
    OpsResultContext,
    Outcome,
    Pending,
    Route,
    SessionContext,
    VfsExplanation,
)
from mirage.runtime.routing.types import RouteContext
from mirage.types import Limit, MountMode, PathSpec, Refusal
from mirage.utils.errors import ReadOnlyError, eacces, fs_error_line

if TYPE_CHECKING:
    from mirage.policy.decisions import Decisions

logger = logging.getLogger(__name__)

HookContext = (
    CommandContext
    | RouteContext
    | OpsContext
    | OpsResultContext
    | ExecuteResultContext
    | SessionContext
)


def render_deny(subject: str, deny: Deny) -> tuple[bytes, int]:
    """The command plane's rendering of a refusal: stderr and exit code.

    The one place the outcome table for that plane is written down, so
    a document rule and a coded policy print alike, and the policy's
    reason is never mixed into what the terminal says: a whole-command
    Deny is bash's own ``<subject>: Permission denied`` at 126; an
    operand Deny about a path is the command's own GNU line for that
    operand and EACCES; both leave the reason on the result's
    ``refusal`` record. An operand Deny that names no path keeps
    ``<subject>: <reason>``, because there the reason is the diagnostic
    a built-in worded in POSIX's terms. Operand refusals exit at the
    command's operand-refusal code (1, tar 2).

    Args:
        subject (str): the command name (or ``line`` at the boundary).
        deny (Deny): the action.
    """
    if deny.scope is DenyScope.OPERAND:
        line = (
            fs_error_line(subject, deny.path, eacces(deny.path))
            if deny.path is not None
            else f"{subject}: {deny.reason}\n"
        )
        return line.encode(), operand_exit_code(subject)
    return f"{subject}: Permission denied\n".encode(), POLICY_DENIED_EXIT


def render_pending(subject: str, pending: Pending) -> tuple[bytes, int]:
    """The command plane's rendering of an unanswered ask: refused for
    now at 126 in the same words as a deny, so stderr never tells an
    agent whether a retry might pass; the ask id it should quote rides
    the ``refusal`` record.

    Args:
        subject (str): the command name.
        pending (Pending): the door's answer.
    """
    return f"{subject}: Permission denied\n".encode(), POLICY_DENIED_EXIT


def refusal_of(action: Deny | Pending) -> Refusal:
    """The record a refused result carries beside its bash-voiced stderr.

    Args:
        action (Deny | Pending): what the command plane refused with.
    """
    if isinstance(action, Pending):
        return Refusal(kind="pending", reason=action.reason, ask_id=action.id)
    return Refusal(
        kind="failed" if action.failed else "deny",
        reason=action.reason,
        policy=action.policy,
        scope=("operand" if action.scope is DenyScope.OPERAND else "command"),
    )


def describe_refusal(refusal: Refusal) -> str:
    """One line saying why, for a surface that hands the agent text
    rather than a record; the agent adapters append it after stderr.

    Args:
        refusal (Refusal): the record off a refused result.
    """
    if refusal.kind == "pending":
        return f"requires approval: {refusal.reason} (ask {refusal.ask_id})"
    if refusal.kind == "failed":
        return f"policy {refusal.policy} failed"
    return f"policy denied: {refusal.reason}"


def says_why(text: str, refusal: Refusal) -> bool:
    """Whether ``text`` already carries the line that says why the
    command was refused.

    Only an operand-scoped denial that names no path has one: its
    diagnostic ``<command>: <reason>`` is the reason, wherever a redirect landed
    it, so a surface that describes the record after the text looks
    for that line rather than for the scope (``2>/dev/null`` takes the
    line away and the record is the only reason left, ``2>&1`` moves it
    onto stdout and nothing needs repeating) and rather than for the
    reason as a substring, since output that happens to quote the words
    has refused nothing. A command-scoped refusal's stderr is bash's
    bare ``Permission denied``, which never says why. An empty reason
    says nothing, so no text can already have said it.

    Args:
        text (str): what the surface is about to hand over.
        refusal (Refusal): the record off the result.
    """
    if refusal.scope != "operand" or not refusal.reason:
        return False
    tail = f": {refusal.reason}"
    return any(line.endswith(tail) for line in text.split("\n"))


def policy_denied(
    deny: Deny, filename: str, strerror: str = os.strerror(errno.EACCES)
) -> PolicyDenied:
    """The error a door raises for a policy's Deny, its record noted for
    the line running it.

    The error says what the terminal would, EACCES and ``strerror``;
    the reason rides the record, on the error for a caller that catches
    it and on the line's result for one that only reads what a command
    printed.

    Args:
        deny (Deny): the policy's refusal.
        filename (str): the path or name refused.
        strerror (str): the terminal's words, ``Permission denied``
            unless the door words its own.
    """
    refusal = refusal_of(deny)
    note_refusal(refusal)
    return PolicyDenied(errno.EACCES, strerror, filename, refusal=refusal)


def policy_pending(pending: Pending, filename: str) -> PolicyDenied:
    """The error a door raises for a question the host has not answered:
    a plain EACCES, as the terminal would print it, with the ask id the
    agent quotes on the record.

    Args:
        pending (Pending): the ledger's answer.
        filename (str): the path asked about.
    """
    refusal = refusal_of(pending)
    note_refusal(refusal)
    return PolicyDenied(
        errno.EACCES, os.strerror(errno.EACCES), filename, refusal=refusal
    )


async def pre_ops_gate(
    policies: "Policies",
    op: str,
    path: PathSpec,
    write: bool,
    prefix: str,
    session_id: str = "",
    *,
    mode: MountMode | None = None,
    create: bool = False,
    subtree: bool = False,
    check_hidden: bool = True,
    decisions: "Decisions | None" = None,
    final: bool = True,
) -> None:
    """Fire pre_ops at an op door; a Deny becomes EACCES.

    The one seam helper both doors (the ops facade and the dispatcher)
    call, so a refusal is byte-identical however the mount is reached:
    PermissionError with errno EACCES and the virtual path as filename,
    which the shell renders as "<cmd>: <path>: Permission denied" and
    FUSE translates to -EACCES. An Ask is a question only where no line
    is running and the door holds the ledger (a file tool, the host's
    facade): the ledger answers it from a standing grant or records it,
    and an unanswered one refuses with the ask id on the record. Inside
    a line an Ask refuses like a deny, since the line was admitted
    without it.

    Args:
        policies (Policies): the workspace's admission policies.
        op (str): operation name.
        path (PathSpec): the resolved virtual path.
        write (bool): whether the op mutates the mount.
        prefix (str): the owning mount's prefix.
        session_id (str): the session the door serves, empty for the
            unbound host view.
        mode (MountMode | None): the owning mount's mode, judged by the
            mount-mode built-in; None at a door that judges it itself.
        create (bool): the op creates the path.
        subtree (bool): the op mutates the path's descendants too.
        check_hidden (bool): False only for a door that has already
            answered the hides itself.
        decisions (Decisions | None): the approval ledger, None at a
            door that cannot ask.
        final (bool): the op's last gate; False for a rename's source,
            whose destination is gated next.

    Raises:
        Explained: in a dry run (``explaining``), once the gate's answer
            is noted and the op would refuse or has no gate left: the
            door stops before any backend or cache is touched.
        ReadOnlyError: a write a policy makes while it decides a dry
            run's op, which the dry run may not let change anything (an
            ask its read meets reads the ledger and records nothing).
    """
    ctx = OpsContext(
        op=op,
        path=path,
        write=write,
        prefix=prefix,
        session_id=session_id,
        mode=mode,
        create=create,
        subtree=subtree,
    )
    trace = explaining()
    if isinstance(trace, list):
        token = set_explaining(DryRun.DECIDING)
        try:
            hidden = check_hidden and await policies.hides(ctx)
            noted = (
                None
                if hidden
                else await _explained_op(policies, ctx, decisions)
            )
        finally:
            reset_explaining(token)
        if noted is None:
            raise Explained()
        trace.append(noted)
        if final or noted.error:
            raise Explained()
        return
    deciding = trace is DryRun.DECIDING
    if deciding and write:
        raise ReadOnlyError(errno.EROFS, "Read-only file system", path.virtual)
    if not (
        policies.wants("pre_ops")
        or check_hidden
        or (write and mode is not None)
    ):
        return
    answer = await policies.pre_ops(ctx, check_hidden=check_hidden)
    if isinstance(answer, Hide):
        raise answer.error
    if isinstance(answer, Ask):
        if decisions is None or line_running():
            raise policy_denied(Deny(answer.reason), path.virtual)
        settled = (
            decisions.held_op(ctx, answer)
            if deciding
            else await decisions.resolve_op(ctx, answer)
        )
        if settled is None:
            return
        if isinstance(settled, Pending):
            raise policy_pending(settled, path.virtual)
        answer = settled
    if answer is not None:
        if answer.error is not None:
            raise answer.error
        raise policy_denied(answer, path.virtual)


async def _explained_op(
    policies: "Policies", ctx: OpsContext, decisions: "Decisions | None"
) -> VfsExplanation:
    """What the gate would answer one VFS call, as ``pre_ops_gate``
    decides it and without its consequences: every policy's answer, the
    one that wins, and the error the door would raise. A question reads
    the ledger's settled records and records nothing.

    Args:
        policies (Policies): the workspace's admission policies.
        ctx (OpsContext): the call the gate sees.
        decisions (Decisions | None): the approval ledger, None at a
            door that cannot ask.
    """
    said = await policies.answers("pre_ops", ctx)
    answers = tuple(a for a in said if isinstance(a, (Deny, Ask)))
    first = answers[0] if answers else None
    winner = next((a for a in answers if isinstance(a, Deny)), first)
    base = VfsExplanation(
        call=ctx.op, paths=(ctx.path.virtual,), answers=answers
    )
    if winner is None:
        return base
    action: Deny | Pending | None = (
        winner if isinstance(winner, Deny) else None
    )
    if isinstance(winner, Ask):
        action = (
            Deny(winner.reason, policy=winner.policy)
            if decisions is None or line_running()
            else decisions.held_op(ctx, winner)
        )
    decided = replace(
        base,
        outcome=Outcome.ASK if isinstance(winner, Ask) else Outcome.DENY,
        reason=winner.reason,
        source="" if winner.rule is None else source_of(winner.rule),
    )
    if action is None:
        return decided
    error = action.error if isinstance(action, Deny) else None
    return replace(
        decided,
        refusal=None if error is not None else refusal_of(action),
        error=errno.errorcode.get(
            error.errno if error is not None and error.errno else errno.EACCES,
            "EACCES",
        ),
    )


async def post_ops_gate(
    policies: "Policies",
    op: str,
    path: PathSpec,
    write: bool,
    prefix: str,
    result: Any,
) -> Limit | None:
    """Fire post_ops at an op door; a Deny suppresses the result.

    Returns the merged Limit bound (tightest per field across every
    opining policy) for the door to apply to a byte-producing result,
    or None when no policy bounds this op.

    Args:
        policies (Policies): the workspace's admission policies.
        op (str): operation name.
        path (PathSpec): the resolved virtual path.
        write (bool): whether the op mutated the mount.
        prefix (str): the owning mount's prefix.
        result (Any): the op's raw result, offered to the hooks.
    """
    if not policies.wants("post_ops"):
        return None
    deny, bound = await policies.post_ops(
        OpsResultContext(
            op=op, path=path, write=write, prefix=prefix, result=result
        )
    )
    if deny is not None:
        if deny.error is not None:
            raise deny.error
        raise policy_denied(deny, path.virtual)
    return bound


async def pre_session_gate(
    policies: "Policies | None", ctx: SessionContext
) -> None:
    """Fire pre_session on the session plane; a Deny becomes EACCES.

    The one seam helper the session plane's door calls, so a refusal
    is identical however the state is reached: shell builtin, command
    view, or a later tier. None policies (a view constructed outside a
    workspace) gate nothing.

    Args:
        policies (Policies | None): the workspace's admission policies.
        ctx (SessionContext): the mutation, built by the door so the
            plane, verb, rendering and session identity are stated in
            exactly one place.
    """
    if policies is None or not policies.wants("pre_session"):
        return
    deny = await policies.pre_session(ctx)
    if deny is not None:
        raise policy_denied(deny, ctx.key, f"{ctx.key}: permission denied")


async def post_execute_gate(
    policies: "Policies", ctx: ExecuteResultContext
) -> tuple[Deny | None, Limit | None]:
    """Fire post_execute at the workspace boundary.

    Returns the fail-closed Deny (a raising policy) if any, and the
    merged Limit bound for the boundary to enforce on the line's
    output stream.

    Args:
        policies (Policies): the workspace's policies.
        ctx (ExecuteResultContext): the finished line's facts.
    """
    if not policies.wants("post_execute"):
        return None, None
    return await policies.post_execute(ctx)


def agreed(routes: list[Route]) -> Deny | Route | None:
    """The placement the policies agree on: their one runtime, None
    when none placed the line, and a Deny when two disagree.

    Args:
        routes (list[Route]): every Route the stage answered, in order.
    """
    runtimes = dict.fromkeys(route.runtime for route in routes)
    if len(runtimes) < 2:
        return routes[0] if routes else None
    said = ", ".join(f"{r.policy} on {r.runtime}" for r in routes)
    return Deny(
        f"policies place the line on different runtimes: {said}",
        policy=", ".join(dict.fromkeys(r.policy for r in routes)),
    )


def settled(
    answers: tuple[Deny | Ask | Route, ...],
) -> Deny | Ask | Route | None:
    """What a stage's answers come to, by kind: the first Deny, else the
    first Ask, else the Route every placing answer agrees on.

    Args:
        answers (tuple[Deny | Ask | Route, ...]): every answer, in order.
    """
    deny = next((a for a in answers if isinstance(a, Deny)), None)
    if deny is not None:
        return deny
    ask = next((a for a in answers if isinstance(a, Ask)), None)
    if ask is not None:
        return ask
    return agreed([a for a in answers if isinstance(a, Route)])


def _deny_only(hook: str, action: Deny | Ask | None) -> Deny | None:
    """Narrow a hook's answer where VALIDITY admits no Ask.

    Args:
        hook (str): the hook name, for the message.
        action (Deny | Ask | None): what the loop returned.

    Raises:
        PolicyError: an Ask reached a hook that cannot carry one, which
            VALIDITY already refuses inside the loop.
    """
    if isinstance(action, Ask):
        raise PolicyError(f"{hook} cannot answer with an Ask: {action!r}")
    return action


class Policies:
    """Ordered policies; on a pre hook the first Deny wins.

    Built-ins are seeded first (MountRegistry registers
    MountRootPolicy), then the document's deny rules compiled by the
    workspace, then user policies in registration order
    (``Workspace(policies=...)``, then anything added later through
    ``add``). There is no allow arm, so adding a policy can only
    tighten the workspace, never loosen it; order decides which refusal
    message is shown, never whether a refusal holds.

    A policy that raises fails closed: the command is refused with a
    whole-command Deny naming the policy, and the error is logged. A
    policy that returns something the hook may not return (VALIDITY)
    raises PolicyError: that is a programming error, not a refusal.

    A hook may be ``async def`` or a plain ``def``; the seam awaits
    whatever it returns, the way the TypeScript seam accepts a value
    or a promise. Without that a plain ``def`` raised inside the
    fail-closed arm and every command read ``policy X failed``.

    Args:
        policies (list[Policy] | None): initial policies, consulted in
            order before anything registered later through add().
    """

    def __init__(self, policies: list[Policy] | None = None) -> None:
        self._policies: list[Policy] = list(policies or [])
        self._placement: Policy | None = None
        self._wanted: frozenset[str] = frozenset()
        self._rescan()
        self._hidden = HiddenPathsPolicy()
        self._mode = MountModePolicy()

    def place(self, placement: Policy | None) -> None:
        """Install the built-in placement, the workspace's ``route_policy``
        compiled as a policy, which answers ``pre_execute`` ahead of every
        registered one.

        It sits outside the fail-closed fold: a misconfigured route
        policy raises ``RouteError`` to the caller rather than refusing
        the line, since the mistake is the deployment's to fix.

        Args:
            placement (Policy | None): the built-in, None for none.
        """
        self._placement = placement
        self._rescan()

    def add(self, policy: Policy) -> None:
        """Register a policy after the existing ones.

        Code only: a declarative rule belongs in the permissions
        document (``commands.deny``), which the workspace compiles.

        Args:
            policy (Policy): the policy to consult after the rest.
        """
        self._policies.append(policy)
        self._rescan()

    def remove(self, policy: Policy) -> bool:
        """Remove one registration by identity; return whether it existed.

        Host-side only, like add(). Other policies keep their order.

        Args:
            policy (Policy): the exact instance passed to add().
        """
        for index, entry in enumerate(self._policies):
            if entry is policy:
                del self._policies[index]
                self._rescan()
                return True
        return False

    def wants(self, hook: str) -> bool:
        """True when any policy overrides ``hook``.

        O(1); the op seams gate on it so a workspace with no op
        policies pays nothing per VFS op.

        Args:
            hook (str): hook name (pre_command, pre_ops, post_ops).
        """
        return hook in self._wanted

    async def wants_for(self, hook: str, session_id: str) -> bool:
        """True when some policy will speak at ``hook`` for this session.

        The per-session refinement of ``wants``: a policy that overrides
        the hook counts, unless it speaks per session
        (``SessionScopedMixin``) and says this is not one of its. For
        a seam that pays ahead for a hook rather than gating on it: the
        secret fill drops its masks under a session-write gate, and a
        profile's policy at that door is one profile's, not every
        session's.

        Args:
            hook (str): hook name (pre_command, pre_ops, pre_session).
            session_id (str): the session, empty when none is bound.
        """
        base = getattr(Policy, hook)
        for policy in tuple(self._policies):
            if getattr(type(policy), hook) is base:
                continue
            if not isinstance(policy, SessionScopedMixin):
                return True
            if await policy.wants_for(hook, session_id):
                return True
        return False

    def _rescan(self) -> None:
        wanted = set()
        policies = [*self._policies, *filter(None, [self._placement])]
        for hook in VALIDITY:
            base = getattr(Policy, hook)
            for policy in policies:
                if getattr(type(policy), hook) is not base:
                    wanted.add(hook)
                    break
        self._wanted = frozenset(wanted)

    def _chain(self, hook: str, placed: bool) -> tuple[Policy, ...]:
        """The policies a stage asks, in order: the built-in placement
        first at ``pre_execute`` (unless the caller placed the line),
        the registered ones, and the built-in mount mode last at
        ``pre_ops``, after every policy that could explain the refusal
        in its own words.

        Args:
            hook (str): the hook in python spelling.
            placed (bool): the caller placed the line itself.
        """
        # A snapshot, so the order holds if the host edits registrations
        # while a hook awaits. Changes take effect at the next gate.
        chain: tuple[Policy, ...] = tuple(self._policies)
        if hook == "pre_execute" and self._placement and not placed:
            chain = (self._placement, *chain)
        if hook == "pre_ops":
            chain = (*chain, self._mode)
        return chain

    async def _said(
        self, hook: str, ctx: HookContext, every: bool, placed: bool = False
    ) -> tuple[list[Deny | Ask | Route], list[Limit]]:
        """The one loop every stage runs: each policy's answer, named and
        checked against what the hook may carry.

        The door stops at the first Deny, since nothing after it can
        change the outcome; ``every`` goes on, so ``explain`` shows the
        answers a Deny would hide. A policy that raises answers with a
        Deny naming it (fail closed), except the built-in placement,
        which raises to the caller. A kind the hook cannot carry
        (VALIDITY) raises PolicyError: a programming error, not a
        refusal, and as loud in a dry run as at the door.

        Args:
            hook (str): the hook in python spelling.
            ctx (HookContext): the context the stage sees.
            every (bool): ask every policy, past a Deny.
            placed (bool): the caller placed the line itself, so the
                built-in placement is not asked.
        """
        base = getattr(Policy, hook)
        legal = VALIDITY[hook]
        said: list[Deny | Ask | Route] = []
        limits: list[Limit] = []
        for policy in self._chain(hook, placed):
            if getattr(type(policy), hook) is base:
                continue
            name = type(policy).__name__
            try:
                action = getattr(policy, hook)(ctx)
                if inspect.isawaitable(action):
                    action = await action
            except Exception as exc:
                if policy is self._placement:
                    raise
                # The agent reads which policy broke, never what it
                # raised: the exception text is the deployment's to
                # debug, in the log.
                logger.error("%s policy %s raised: %s", hook, name, exc)
                said.append(Deny(f"{name} failed", policy=name, failed=True))
                if not every:
                    return said, []
                continue
            if action is None:
                continue
            if not isinstance(action, (Deny, Ask, Route, Limit)) or (
                action.kind not in legal
            ):
                raise PolicyError(
                    f"{hook} of {name} returned {action!r}; "
                    f"legal kinds here: {sorted(legal)}"
                )
            if isinstance(action, Limit):
                limits.append(action)
                continue
            said.append(
                action if action.policy else replace(action, policy=name)
            )
            if isinstance(action, Deny) and not every:
                return said, []
        return said, limits

    async def _fire(
        self, hook: str, ctx: HookContext, placed: bool = False
    ) -> tuple[Deny | Ask | None, Limit | None, tuple[Route, ...]]:
        """One stage at a door: the first Deny wins, Limits merge.

        A refusal short-circuits (limits are moot once the result is
        suppressed); Limit actions aggregate to the tightest value per
        field, and Routes are collected for the caller to reconcile. An
        Ask is remembered and the loop goes on looking for a Deny, so a
        later policy's refusal outranks an earlier policy's question and
        an approval can never re-open a deny; the first Ask is returned
        when nothing refused.

        Args:
            hook (str): the hook in python spelling.
            ctx (HookContext): the context the stage sees.
            placed (bool): the caller placed the line itself.
        """
        said, limits = await self._said(hook, ctx, False, placed)
        deny = next((a for a in said if isinstance(a, Deny)), None)
        if deny is not None:
            return deny, None, ()
        asked = next((a for a in said if isinstance(a, Ask)), None)
        routes = tuple(a for a in said if isinstance(a, Route))
        return asked, Limit.aggr(limits), routes

    async def answers(
        self, hook: str, ctx: HookContext, every: bool = True
    ) -> tuple[Deny | Ask | Route, ...]:
        """The policies' answers at one stage, in the order the stage
        asks them, each naming its policy: what ``explain`` shows, from
        the same loop the door runs.

        With ``every`` no answer stops the loop, so a Deny does not hide
        the answers after it; without it the answers end at the first
        Deny, as the door's do. The built-in hides never answer here,
        since a hide never surfaces; the built-in placement answers first
        at ``pre_execute`` and the built-in mount mode last at
        ``pre_ops``, as they do at the door.

        Args:
            hook (str): the hook in python spelling.
            ctx (HookContext): the context the stage would see.
            every (bool): ask every policy, past a Deny.
        """
        said, _ = await self._said(hook, ctx, every)
        return tuple(said)

    async def pre_command(self, ctx: CommandContext) -> Deny | Ask | None:
        """Fire pre_command across the policies; first Deny wins, else
        the first Ask.

        Args:
            ctx (CommandContext): the classified command.
        """
        action, _, _ = await self._fire("pre_command", ctx)
        return action

    async def pre_execute(
        self, ctx: RouteContext, placed: bool = False
    ) -> Deny | Route | None:
        """Fire pre_execute: a Deny wins, else the Route every placing
        policy agrees on; two placing the line on different runtimes
        refuse it.

        Args:
            ctx (RouteContext): the line about to run.
            placed (bool): the caller placed the line (the runtime
                argument), so the built-in placement is not asked and a
                Route is moot; a Deny still refuses the line.
        """
        action, _, routes = await self._fire("pre_execute", ctx, placed)
        if isinstance(action, Deny):
            return action
        return None if placed else agreed(list(routes))

    async def hides(self, ctx: OpsContext) -> bool:
        """Whether the built-in hides answer the op as absent, before any
        policy is asked.

        Args:
            ctx (OpsContext): the op about to run.
        """
        return await self._hidden.pre_ops(ctx) is not None

    async def pre_ops(
        self, ctx: OpsContext, *, check_hidden: bool = True
    ) -> Hide | Deny | Ask | None:
        """Fire pre_ops across the policies; first Deny wins, else the
        first Ask, which the door decides how to put.

        The built-in hides answer before every policy, with a Hide that
        outranks whatever a policy would say, so a refusal never tells a
        session a hidden name exists; the built-in mount mode answers
        after them. Both hold whether or not any policy overrides the
        hook.

        Args:
            ctx (OpsContext): the op about to run.
            check_hidden (bool): False only for a door that has already
                answered the hides itself.
        """
        if check_hidden:
            hidden = await self._hidden.pre_ops(ctx)
            if hidden is not None:
                return hidden
        action, _, _ = await self._fire("pre_ops", ctx)
        return action

    async def pre_session(self, ctx: SessionContext) -> Deny | None:
        """Fire pre_session across the policies; first Deny wins.

        Args:
            ctx (SessionContext): the mutation about to land.
        """
        action, _, _ = await self._fire("pre_session", ctx)
        return _deny_only("pre_session", action)

    async def post_ops(
        self, ctx: OpsResultContext
    ) -> tuple[Deny | None, Limit | None]:
        """Fire post_ops; a Deny suppresses the result, Limits merge.

        Args:
            ctx (OpsResultContext): the op and its raw result.
        """
        action, limit, _ = await self._fire("post_ops", ctx)
        return _deny_only("post_ops", action), limit

    async def post_execute(
        self, ctx: ExecuteResultContext
    ) -> tuple[Deny | None, Limit | None]:
        """Fire post_execute; Limits merge to the boundary bound.

        Args:
            ctx (ExecuteResultContext): the finished line's facts.
        """
        action, limit, _ = await self._fire("post_execute", ctx)
        return _deny_only("post_execute", action), limit

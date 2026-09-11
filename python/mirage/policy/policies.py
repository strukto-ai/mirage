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
from dataclasses import replace
from typing import Any

from mirage.commands.spec.usage import operand_exit_code
from mirage.policy.base import Policy
from mirage.policy.constants import POLICY_DENIED_EXIT
from mirage.policy.errors import PolicyDenied, PolicyError
from mirage.policy.mixin import SessionScopedMixin
from mirage.policy.types import (VALIDITY, Ask, CommandContext, Deny,
                                 DenyScope, ExecuteResultContext, OpsContext,
                                 OpsResultContext, Pending, SessionContext)
from mirage.types import Limit, PathSpec, Refusal

logger = logging.getLogger(__name__)

HookContext = (CommandContext | OpsContext | OpsResultContext
               | ExecuteResultContext | SessionContext)


def render_deny(subject: str, deny: Deny) -> tuple[bytes, int]:
    """The command plane's rendering of a refusal: stderr and exit code.

    The one place the outcome table for that plane is written down, so
    a document rule and a coded policy print alike: a whole-command
    Deny is bash's own ``<subject>: Permission denied`` at 126, with
    the reason on the result's ``refusal`` record rather than on
    stderr; an operand Deny keeps the GNU voice ``<subject>: <reason>``
    at the command's operand-refusal code (1, tar 2), because there
    the reason is the diagnostic.

    Args:
        subject (str): the command name (or ``line`` at the boundary).
        deny (Deny): the action.
    """
    if deny.scope is DenyScope.OPERAND:
        return (f"{subject}: {deny.reason}\n".encode(),
                operand_exit_code(subject))
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
        scope=("operand" if action.scope is DenyScope.OPERAND else "command"))


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

    Only an operand-scoped denial has one: its GNU diagnostic
    ``<command>: <reason>`` is the reason, wherever a redirect landed
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


async def pre_ops_gate(policies: "Policies",
                       op: str,
                       path: PathSpec,
                       write: bool,
                       prefix: str,
                       session_id: str = "") -> None:
    """Fire pre_ops at an op door; a Deny becomes EACCES.

    The one seam helper both doors (the ops facade and the dispatcher)
    call, so a refusal is byte-identical however the mount is reached:
    PermissionError with errno EACCES and the virtual path as filename,
    which the shell renders as "<cmd>: <path>: Permission denied" and
    FUSE translates to -EACCES.

    Args:
        policies (Policies): the workspace's admission policies.
        op (str): operation name.
        path (PathSpec): the resolved virtual path.
        write (bool): whether the op mutates the mount.
        prefix (str): the owning mount's prefix.
        session_id (str): the session the door serves, empty for the
            unbound host view.
    """
    if not policies.wants("pre_ops"):
        return
    deny = await policies.pre_ops(
        OpsContext(op=op,
                   path=path,
                   write=write,
                   prefix=prefix,
                   session_id=session_id))
    if deny is not None:
        raise PolicyDenied(errno.EACCES, deny.reason, path.virtual)


async def post_ops_gate(policies: "Policies", op: str, path: PathSpec,
                        write: bool, prefix: str, result: Any) -> Limit | None:
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
        OpsResultContext(op=op,
                         path=path,
                         write=write,
                         prefix=prefix,
                         result=result))
    if deny is not None:
        raise PolicyDenied(errno.EACCES, deny.reason, path.virtual)
    return bound


async def pre_session_gate(policies: "Policies | None",
                           ctx: SessionContext) -> None:
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
        raise PolicyDenied(errno.EACCES, deny.reason, ctx.key)


async def post_execute_gate(
        policies: "Policies",
        ctx: ExecuteResultContext) -> tuple[Deny | None, Limit | None]:
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
        self._wanted: frozenset[str] = frozenset()
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
        for hook in VALIDITY:
            base = getattr(Policy, hook)
            for policy in self._policies:
                if getattr(type(policy), hook) is not base:
                    wanted.add(hook)
                    break
        self._wanted = frozenset(wanted)

    async def _fire(
            self, hook: str,
            ctx: HookContext) -> tuple[Deny | Ask | None, Limit | None]:
        """One loop for every hook: first Deny wins, Limits merge.

        A refusal short-circuits (limits are moot once the result is
        suppressed); Limit actions accumulate and aggregate to the
        tightest value per field. An Ask is remembered and the loop
        goes on looking for a Deny, so a later policy's refusal
        outranks an earlier policy's question and an approval can never
        re-open a deny; the first Ask is returned when nothing refused.
        """
        base = getattr(Policy, hook)
        limits: list[Limit] = []
        asked: Ask | None = None
        # Keep this gate's order stable if the host edits registrations
        # while a hook awaits. Changes take effect at the next gate.
        for policy in tuple(self._policies):
            if getattr(type(policy), hook) is base:
                continue
            name = type(policy).__name__
            try:
                action = getattr(policy, hook)(ctx)
                if inspect.isawaitable(action):
                    action = await action
            except Exception as exc:
                # The agent reads which policy broke, never what it
                # raised: the exception text is the deployment's to
                # debug, in the log.
                logger.error("%s policy %s raised: %s", hook, name, exc)
                return Deny(f"{name} failed", policy=name, failed=True), None
            if action is None:
                continue
            legal = VALIDITY[hook]
            if isinstance(action, Deny) and Deny.kind in legal:
                if action.policy == "":
                    action = replace(action, policy=name)
                return action, None
            if isinstance(action, Ask) and Ask.kind in legal:
                if asked is None:
                    asked = action
                continue
            if isinstance(action, Limit) and Limit.kind in legal:
                limits.append(action)
                continue
            raise PolicyError(f"{hook} of {name} returned {action!r}; "
                              f"legal kinds here: {sorted(legal)}")
        return asked, Limit.aggr(limits)

    async def pre_command(self, ctx: CommandContext) -> Deny | Ask | None:
        """Fire pre_command across the policies; first Deny wins, else
        the first Ask.

        Args:
            ctx (CommandContext): the classified command.
        """
        action, _ = await self._fire("pre_command", ctx)
        return action

    async def pre_ops(self, ctx: OpsContext) -> Deny | None:
        """Fire pre_ops across the policies; first Deny wins.

        Args:
            ctx (OpsContext): the op about to run.
        """
        action, _ = await self._fire("pre_ops", ctx)
        return _deny_only("pre_ops", action)

    async def pre_session(self, ctx: SessionContext) -> Deny | None:
        """Fire pre_session across the policies; first Deny wins.

        Args:
            ctx (SessionContext): the mutation about to land.
        """
        action, _ = await self._fire("pre_session", ctx)
        return _deny_only("pre_session", action)

    async def post_ops(
            self, ctx: OpsResultContext) -> tuple[Deny | None, Limit | None]:
        """Fire post_ops; a Deny suppresses the result, Limits merge.

        Args:
            ctx (OpsResultContext): the op and its raw result.
        """
        action, limit = await self._fire("post_ops", ctx)
        return _deny_only("post_ops", action), limit

    async def post_execute(
            self,
            ctx: ExecuteResultContext) -> tuple[Deny | None, Limit | None]:
        """Fire post_execute; Limits merge to the boundary bound.

        Args:
            ctx (ExecuteResultContext): the finished line's facts.
        """
        action, limit = await self._fire("post_execute", ctx)
        return _deny_only("post_execute", action), limit

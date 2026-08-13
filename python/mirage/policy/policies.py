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
import logging
from typing import Any

from mirage.policy.base import Policy
from mirage.policy.errors import PolicyDenied, PolicyError
from mirage.policy.spec import SpecPolicy
from mirage.policy.types import (VALIDITY, CommandContext, Deny,
                                 ExecuteResultContext, GuardSpec, OpsContext,
                                 OpsResultContext, SessionContext)
from mirage.types import Limit, PathSpec

logger = logging.getLogger(__name__)

HookContext = (CommandContext | OpsContext | OpsResultContext
               | ExecuteResultContext | SessionContext)


async def pre_ops_gate(policies: "Policies", op: str, path: PathSpec,
                       write: bool, prefix: str) -> None:
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
    """
    if not policies.wants("pre_ops"):
        return
    deny = await policies.pre_ops(
        OpsContext(op=op, path=path, write=write, prefix=prefix))
    if deny is not None:
        raise PolicyDenied(errno.EACCES, deny.message.rstrip("\n"),
                           path.virtual)


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
        raise PolicyDenied(errno.EACCES, deny.message.rstrip("\n"),
                           path.virtual)
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
        raise PolicyDenied(errno.EACCES, deny.message.rstrip("\n"), ctx.key)


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


class Policies:
    """Ordered policies; on a pre hook the first Deny wins.

    Built-ins are seeded first (MountRegistry registers
    MountRootPolicy), then user policies in registration order:
    ``Workspace(guards=..., policies=...)``, then anything added later
    through ``add``. There is no allow arm, so adding a policy can only
    tighten the workspace, never loosen it; order decides which refusal
    message is shown, never whether a refusal holds.

    A policy that raises fails closed: the command is refused with a
    Deny naming the policy, and the error is logged. A policy that
    returns something the hook may not return (VALIDITY) raises
    PolicyError: that is a programming error, not a refusal.

    Args:
        policies (list[Policy] | None): initial policies, consulted in
            order before anything registered later through add().
    """

    def __init__(self, policies: list[Policy] | None = None) -> None:
        self._policies: list[Policy] = list(policies or [])
        self._wanted: frozenset[str] = frozenset()
        self._rescan()

    def add(self, policy: Policy | GuardSpec) -> None:
        """Register a policy after the existing ones.

        Args:
            policy (Policy | GuardSpec): a Policy instance, or a
                declarative spec compiled on registration.
        """
        self._policies.append(
            SpecPolicy(policy) if isinstance(policy, GuardSpec) else policy)
        self._rescan()

    def wants(self, hook: str) -> bool:
        """True when any policy overrides ``hook``.

        O(1); the op seams gate on it so a workspace with no op
        policies pays nothing per VFS op.

        Args:
            hook (str): hook name (pre_command, pre_ops, post_ops).
        """
        return hook in self._wanted

    def _rescan(self) -> None:
        wanted = set()
        for hook in VALIDITY:
            base = getattr(Policy, hook)
            for policy in self._policies:
                if getattr(type(policy), hook) is not base:
                    wanted.add(hook)
                    break
        self._wanted = frozenset(wanted)

    async def _fire(self, hook: str, ctx: HookContext,
                    subject: str) -> tuple[Deny | None, Limit | None]:
        """One loop for every hook: first Deny wins, Limits merge.

        A refusal short-circuits (limits are moot once the result is
        suppressed); Limit actions accumulate and aggregate to the
        tightest value per field.
        """
        base = getattr(Policy, hook)
        limits: list[Limit] = []
        for policy in self._policies:
            if getattr(type(policy), hook) is base:
                continue
            name = type(policy).__name__
            try:
                action = await getattr(policy, hook)(ctx)
            except Exception as exc:
                logger.error("%s policy %s raised: %s", hook, name, exc)
                return Deny(f"{subject}: policy {name} failed: {exc}\n"), None
            if action is None:
                continue
            legal = VALIDITY[hook]
            if isinstance(action, Deny) and Deny.kind in legal:
                return action, None
            if isinstance(action, Limit) and Limit.kind in legal:
                limits.append(action)
                continue
            raise PolicyError(f"{hook} of {name} returned {action!r}; "
                              f"legal kinds here: {sorted(legal)}")
        return None, Limit.aggr(limits)

    async def pre_command(self, ctx: CommandContext) -> Deny | None:
        """Fire pre_command across the policies; first Deny wins.

        Args:
            ctx (CommandContext): the classified command.
        """
        deny, _ = await self._fire("pre_command", ctx, ctx.command)
        return deny

    async def pre_ops(self, ctx: OpsContext) -> Deny | None:
        """Fire pre_ops across the policies; first Deny wins.

        Args:
            ctx (OpsContext): the op about to run.
        """
        deny, _ = await self._fire("pre_ops", ctx, ctx.op)
        return deny

    async def pre_session(self, ctx: SessionContext) -> Deny | None:
        """Fire pre_session across the policies; first Deny wins.

        Args:
            ctx (SessionContext): the mutation about to land.
        """
        deny, _ = await self._fire("pre_session", ctx, ctx.key)
        return deny

    async def post_ops(
            self, ctx: OpsResultContext) -> tuple[Deny | None, Limit | None]:
        """Fire post_ops; a Deny suppresses the result, Limits merge.

        Args:
            ctx (OpsResultContext): the op and its raw result.
        """
        return await self._fire("post_ops", ctx, ctx.op)

    async def post_execute(
            self,
            ctx: ExecuteResultContext) -> tuple[Deny | None, Limit | None]:
        """Fire post_execute; Limits merge to the boundary bound.

        Args:
            ctx (ExecuteResultContext): the finished line's facts.
        """
        return await self._fire("post_execute", ctx, ctx.producer.command
                                or "line")

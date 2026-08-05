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

import logging

from mirage.policy.base import Policy
from mirage.policy.errors import PolicyError
from mirage.policy.spec import SpecPolicy
from mirage.policy.types import (VALIDITY, CommandContext, Deny,
                                 ExecuteContext, ExecuteResultContext,
                                 GuardSpec, OpsContext, OpsResultContext,
                                 Route)
from mirage.types import Limit

logger = logging.getLogger(__name__)

HookContext = (CommandContext | ExecuteContext | OpsContext | OpsResultContext
               | ExecuteResultContext)


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

    async def _fire(
            self, hook: str, ctx: HookContext,
            subject: str) -> tuple[Deny | None, Limit | None, Route | None]:
        """One loop for every hook: first Deny wins, Limits merge.

        A refusal short-circuits (limits and routes are moot once the
        line is refused); Limit actions accumulate and aggregate to the
        tightest value per field; the first Route is kept and later
        Routes ignored, but a later policy can still Deny over it.

        A raising policy fails closed into a Deny naming it, except a
        PolicyError, which is a programming error reporting a
        caller-fixable mistake and propagates instead.
        """
        base = getattr(Policy, hook)
        limits: list[Limit] = []
        route: Route | None = None
        for policy in self._policies:
            if getattr(type(policy), hook) is base:
                continue
            name = type(policy).__name__
            try:
                action = await getattr(policy, hook)(ctx)
            except PolicyError:
                raise
            except Exception as exc:
                logger.error("%s policy %s raised: %s", hook, name, exc)
                return (Deny(f"{subject}: policy {name} failed: {exc}\n"),
                        None, None)
            if action is None:
                continue
            legal = VALIDITY[hook]
            if isinstance(action, Deny) and Deny.kind in legal:
                return action, None, None
            if isinstance(action, Limit) and Limit.kind in legal:
                limits.append(action)
                continue
            if isinstance(action, Route) and Route.kind in legal:
                if route is None:
                    route = action
                continue
            raise PolicyError(f"{hook} of {name} returned {action!r}; "
                              f"legal kinds here: {sorted(legal)}")
        return None, Limit.aggr(limits), route

    async def pre_command(self, ctx: CommandContext) -> Deny | None:
        """Fire pre_command across the policies; first Deny wins.

        Args:
            ctx (CommandContext): the classified command.
        """
        deny, _, _ = await self._fire("pre_command", ctx, ctx.command)
        return deny

    async def pre_execute(
            self, ctx: ExecuteContext) -> tuple[Deny | None, Route | None]:
        """Fire pre_execute; first Deny wins, first Route places the line.

        Args:
            ctx (ExecuteContext): the parsed line's facts.
        """
        deny, _, route = await self._fire("pre_execute", ctx, ctx.command
                                          or "line")
        return deny, route

    async def pre_ops(self, ctx: OpsContext) -> Deny | None:
        """Fire pre_ops across the policies; first Deny wins.

        Args:
            ctx (OpsContext): the op about to run.
        """
        deny, _, _ = await self._fire("pre_ops", ctx, ctx.op)
        return deny

    async def post_ops(
            self, ctx: OpsResultContext) -> tuple[Deny | None, Limit | None]:
        """Fire post_ops; a Deny suppresses the result, Limits merge.

        Args:
            ctx (OpsResultContext): the op and its raw result.
        """
        deny, bound, _ = await self._fire("post_ops", ctx, ctx.op)
        return deny, bound

    async def post_execute(
            self,
            ctx: ExecuteResultContext) -> tuple[Deny | None, Limit | None]:
        """Fire post_execute; Limits merge to the boundary bound.

        Args:
            ctx (ExecuteResultContext): the finished line's facts.
        """
        deny, bound, _ = await self._fire("post_execute", ctx,
                                          ctx.producer.command or "line")
        return deny, bound

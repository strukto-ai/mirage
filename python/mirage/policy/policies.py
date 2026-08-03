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
from mirage.policy.spec import GuardSpec, SpecPolicy
from mirage.policy.types import VALIDITY, CommandContext, Deny

logger = logging.getLogger(__name__)


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

    def add(self, policy: Policy | GuardSpec) -> None:
        """Register a policy after the existing ones.

        Args:
            policy (Policy | GuardSpec): a Policy instance, or a
                declarative spec compiled on registration.
        """
        self._policies.append(
            SpecPolicy(policy) if isinstance(policy, GuardSpec) else policy)

    async def pre_command(self, ctx: CommandContext) -> Deny | None:
        """Fire pre_command across the policies; first Deny wins.

        Args:
            ctx (CommandContext): the classified command.
        """
        for policy in self._policies:
            if type(policy).pre_command is Policy.pre_command:
                continue
            name = type(policy).__name__
            try:
                action = await policy.pre_command(ctx)
            except Exception as exc:
                logger.error("pre_command policy %s raised: %s", name, exc)
                return Deny(f"{ctx.command}: policy {name} failed: {exc}\n")
            if action is None:
                continue
            if not isinstance(
                    action,
                    Deny) or action.kind not in VALIDITY["pre_command"]:
                raise PolicyError(
                    f"pre_command of {name} returned {action!r}; "
                    f"legal kinds here: {sorted(VALIDITY['pre_command'])}")
            return action
        return None

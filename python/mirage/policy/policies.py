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
from mirage.policy.types import (VALIDITY, CommandContext, Deny, GuardSpec,
                                 OpsContext, OpsResultContext)
from mirage.types import PathSpec

logger = logging.getLogger(__name__)


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
                        write: bool, prefix: str, result: Any) -> None:
    """Fire post_ops at an op door; a Deny suppresses the result.

    Args:
        policies (Policies): the workspace's admission policies.
        op (str): operation name.
        path (PathSpec): the resolved virtual path.
        write (bool): whether the op mutated the mount.
        prefix (str): the owning mount's prefix.
        result (Any): the op's raw result, offered to the hooks.
    """
    if not policies.wants("post_ops"):
        return
    deny = await policies.post_ops(
        OpsResultContext(op=op,
                         path=path,
                         write=write,
                         prefix=prefix,
                         result=result))
    if deny is not None:
        raise PolicyDenied(errno.EACCES, deny.message.rstrip("\n"),
                           path.virtual)


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

    async def _fire(self, hook: str, ctx: CommandContext | OpsContext
                    | OpsResultContext, subject: str) -> Deny | None:
        base = getattr(Policy, hook)
        for policy in self._policies:
            if getattr(type(policy), hook) is base:
                continue
            name = type(policy).__name__
            try:
                action = await getattr(policy, hook)(ctx)
            except Exception as exc:
                logger.error("%s policy %s raised: %s", hook, name, exc)
                return Deny(f"{subject}: policy {name} failed: {exc}\n")
            if action is None:
                continue
            if not isinstance(action,
                              Deny) or action.kind not in VALIDITY[hook]:
                raise PolicyError(
                    f"{hook} of {name} returned {action!r}; "
                    f"legal kinds here: {sorted(VALIDITY[hook])}")
            return action
        return None

    async def pre_command(self, ctx: CommandContext) -> Deny | None:
        """Fire pre_command across the policies; first Deny wins.

        Args:
            ctx (CommandContext): the classified command.
        """
        return await self._fire("pre_command", ctx, ctx.command)

    async def pre_ops(self, ctx: OpsContext) -> Deny | None:
        """Fire pre_ops across the policies; first Deny wins.

        Args:
            ctx (OpsContext): the op about to run.
        """
        return await self._fire("pre_ops", ctx, ctx.op)

    async def post_ops(self, ctx: OpsResultContext) -> Deny | None:
        """Fire post_ops across the policies; a Deny suppresses the
        result.

        Args:
            ctx (OpsResultContext): the op and its raw result.
        """
        return await self._fire("post_ops", ctx, ctx.op)

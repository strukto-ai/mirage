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

import pytest

from mirage.policy import (Action, CommandContext, Deny, GuardSpec,
                           MountRootPolicy, Policies, Policy, PolicyError)
from mirage.resource.ram import RAMResource
from mirage.types import MountMode, PathSpec
from mirage.workspace.mount import MountRegistry


class DenyWeird(Policy):

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        if ctx.command == "weird":
            return Deny("nope\n", 3)
        return None


class Raising(Policy):

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        raise RuntimeError("boom")


class IllegalReturn(Policy):

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        return "not an action"  # type: ignore[return-value]


class Silent(Policy):
    pass


def _registry() -> MountRegistry:
    registry = MountRegistry()
    registry.mount("/data", RAMResource(), MountMode.WRITE)
    return registry


def _path(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual,
                    resource_path="",
                    raw_path=virtual,
                    resolved=True)


def _ctx(command: str,
         paths: list[PathSpec] | None = None,
         registry: MountRegistry | None = None) -> CommandContext:
    return CommandContext(command=command,
                          paths=tuple(paths or []),
                          argv=(),
                          cwd="/",
                          registry=registry or _registry())


@pytest.mark.asyncio
async def test_policies_carry_no_rules_by_default():
    assert await Policies().pre_command(_ctx("rm", [_path("/data")])) is None


@pytest.mark.asyncio
async def test_registry_seeds_the_mount_root_policy():
    registry = _registry()
    deny = await registry.policies.pre_command(
        _ctx("rm", [_path("/data")], registry))
    assert deny is not None
    assert "Device or resource busy" in deny.message


@pytest.mark.asyncio
async def test_builtin_runs_first_then_user_policies_in_order():
    policies = Policies([MountRootPolicy()])
    policies.add(GuardSpec(reason="user rule", commands=("rm", )))
    # Both match `rm /data`; the built-in GNU message wins by order.
    deny = await policies.pre_command(_ctx("rm", [_path("/data")]))
    assert deny is not None
    assert "Device or resource busy" in deny.message
    # Only the user rule matches `rm /data/x`.
    deny = await policies.pre_command(_ctx("rm", [_path("/data/x")]))
    assert deny is not None
    assert deny.message == "rm: user rule\n"


@pytest.mark.asyncio
async def test_policy_instances_and_unoverridden_hooks():
    policies = Policies()
    policies.add(Silent())
    policies.add(DenyWeird())
    deny = await policies.pre_command(_ctx("weird"))
    assert deny is not None
    assert deny.exit_code == 3
    assert await policies.pre_command(_ctx("normal")) is None


@pytest.mark.asyncio
async def test_a_raising_policy_fails_closed():
    policies = Policies()
    policies.add(Raising())
    deny = await policies.pre_command(_ctx("ls"))
    assert deny is not None
    assert deny.exit_code == 1
    assert "Raising" in deny.message
    assert "boom" in deny.message


@pytest.mark.asyncio
async def test_an_illegal_return_raises_policy_error():
    policies = Policies()
    policies.add(IllegalReturn())
    with pytest.raises(PolicyError, match="IllegalReturn"):
        await policies.pre_command(_ctx("ls"))

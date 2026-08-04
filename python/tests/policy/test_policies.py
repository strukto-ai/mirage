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

from mirage.policy import (Action, CommandContext, Deny, ExecuteContext,
                           ExecuteResultContext, GuardSpec, MountRootPolicy,
                           OpsContext, OpsResultContext, ParsedCommand,
                           Policies, Policy, PolicyError, Route)
from mirage.resource.ram import RAMResource
from mirage.types import Limit, MountMode, PathSpec, Producer
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


class DenyReadOps(Policy):

    async def pre_ops(self, ctx: OpsContext) -> Action | None:
        if ctx.op == "read":
            return Deny("no reads\n")
        return None


@pytest.mark.asyncio
async def test_pre_ops_first_deny_wins_and_wants_gates():
    policies = Policies()
    assert not policies.wants("pre_ops")
    policies.add(DenyReadOps())
    assert policies.wants("pre_ops")
    assert not policies.wants("post_ops")
    ctx = OpsContext(op="read",
                     path=_path("/data/x"),
                     write=False,
                     prefix="/data/")
    deny = await policies.pre_ops(ctx)
    assert deny is not None
    assert deny.message == "no reads\n"
    write_ctx = OpsContext(op="write",
                           path=_path("/data/x"),
                           write=True,
                           prefix="/data/")
    assert await policies.pre_ops(write_ctx) is None


class CapFour(Policy):

    async def post_ops(self, ctx: OpsResultContext) -> Action | None:
        return Limit(max_bytes=4)


class CapTwo(Policy):

    async def post_ops(self, ctx: OpsResultContext) -> Action | None:
        return Limit(max_bytes=2)


class LimitOnPre(Policy):

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        return Limit(max_bytes=1)


class CapLines(Policy):

    async def post_execute(self, ctx: ExecuteResultContext) -> Action | None:
        return Limit(max_lines=2)


def _ops_result_ctx() -> OpsResultContext:
    return OpsResultContext(op="read",
                            path=_path("/data/x"),
                            write=False,
                            prefix="/data/",
                            result=b"payload")


@pytest.mark.asyncio
async def test_post_ops_limits_merge_to_the_tightest():
    policies = Policies()
    policies.add(CapFour())
    policies.add(CapTwo())
    deny, bound = await policies.post_ops(_ops_result_ctx())
    assert deny is None
    assert bound is not None
    assert bound.max_bytes == 2


@pytest.mark.asyncio
async def test_a_limit_is_illegal_on_pre_command():
    policies = Policies()
    policies.add(LimitOnPre())
    with pytest.raises(PolicyError, match="LimitOnPre"):
        await policies.pre_command(_ctx("ls"))


@pytest.mark.asyncio
async def test_post_execute_limits_merge_to_the_boundary_bound():
    policies = Policies()
    policies.add(CapLines())
    deny, bound = await policies.post_execute(
        ExecuteResultContext(producer=Producer(command="echo"), exit_code=0))
    assert deny is None
    assert bound is not None
    assert bound.max_lines == 2


class RouteAll(Policy):

    def __init__(self, runtime: str) -> None:
        self._runtime = runtime

    async def pre_execute(self, ctx: ExecuteContext) -> Action | None:
        return Route(self._runtime)


class DenyExecute(Policy):

    async def pre_execute(self, ctx: ExecuteContext) -> Action | None:
        return Deny("no lines\n", 126)


class RouteOnPre(Policy):

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        return Route("monty")


class RaisingPolicyError(Policy):

    async def pre_execute(self, ctx: ExecuteContext) -> Action | None:
        raise PolicyError("policy script does not parse")


def _exec_ctx(command: str) -> ExecuteContext:
    return ExecuteContext(line=command,
                          commands=(ParsedCommand(command=command,
                                                  words=(command, ),
                                                  builtin=True,
                                                  paths=()), ),
                          command=command,
                          builtin=True,
                          cwd="/",
                          env={},
                          session_id="s",
                          agent_id="a",
                          mounts=("/data/", ))


@pytest.mark.asyncio
async def test_pre_execute_first_route_wins():
    policies = Policies()
    policies.add(RouteAll("monty"))
    policies.add(RouteAll("local"))
    deny, route = await policies.pre_execute(_exec_ctx("python3"))
    assert deny is None
    assert route == Route("monty")


@pytest.mark.asyncio
async def test_pre_execute_a_later_deny_beats_an_earlier_route():
    policies = Policies()
    policies.add(RouteAll("monty"))
    policies.add(DenyExecute())
    deny, route = await policies.pre_execute(_exec_ctx("python3"))
    assert deny is not None
    assert deny.exit_code == 126
    assert route is None


@pytest.mark.asyncio
async def test_a_route_is_illegal_on_pre_command():
    policies = Policies()
    policies.add(RouteOnPre())
    with pytest.raises(PolicyError, match="RouteOnPre"):
        await policies.pre_command(_ctx("ls"))


@pytest.mark.asyncio
async def test_a_policy_error_propagates_instead_of_failing_closed():
    policies = Policies()
    policies.add(RaisingPolicyError())
    with pytest.raises(PolicyError, match="does not parse"):
        await policies.pre_execute(_exec_ctx("ls"))

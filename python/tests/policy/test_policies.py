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

import pytest

from mirage.policy import (Action, CommandContext, Deny, GuardSpec,
                           MountRootPolicy, OpsContext, OpsResultContext,
                           Policies, Policy, PolicyError, post_ops_gate,
                           pre_ops_gate)
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


class DenyReadOps(Policy):

    async def pre_ops(self, ctx: OpsContext) -> Action | None:
        if ctx.op == "read":
            return Deny("no reads\n")
        return None


class DenyBigResults(Policy):

    async def post_ops(self, ctx: OpsResultContext) -> Action | None:
        if isinstance(ctx.result, bytes) and len(ctx.result) > 8:
            return Deny("result too large\n")
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


@pytest.mark.asyncio
async def test_pre_ops_gate_raises_eacces():
    policies = Policies()
    policies.add(DenyReadOps())
    with pytest.raises(PermissionError) as excinfo:
        await pre_ops_gate(policies, "read", _path("/data/x"), False, "/data/")
    assert excinfo.value.errno == errno.EACCES
    assert excinfo.value.filename == "/data/x"
    assert "no reads" in str(excinfo.value)
    # No opinion on writes: the gate passes silently.
    await pre_ops_gate(policies, "write", _path("/data/x"), True, "/data/")


@pytest.mark.asyncio
async def test_post_ops_gate_suppresses_the_result():
    policies = Policies()
    policies.add(DenyBigResults())
    await post_ops_gate(policies, "read", _path("/data/x"), False, "/data/",
                        b"tiny")
    with pytest.raises(PermissionError) as excinfo:
        await post_ops_gate(policies, "read", _path("/data/x"), False,
                            "/data/", b"a long secret payload")
    assert excinfo.value.errno == errno.EACCES

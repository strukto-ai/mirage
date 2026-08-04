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

from mirage.policy import (Action, Deny, ExecuteContext, ExecuteResultContext,
                           OpsContext, OpsResultContext, ParsedCommand,
                           Policies, Policy, Route, post_execute_gate,
                           post_ops_gate, pre_execute_gate, pre_ops_gate)
from mirage.types import Limit, PathSpec, Producer


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


class CapFour(Policy):

    async def post_ops(self, ctx: OpsResultContext) -> Action | None:
        return Limit(max_bytes=4)


class CapLines(Policy):

    async def post_execute(self, ctx: ExecuteResultContext) -> Action | None:
        return Limit(max_lines=2)


class RoutePython(Policy):

    async def pre_execute(self, ctx: ExecuteContext) -> Action | None:
        if ctx.command == "python3":
            return Route("monty")
        return None


class DenyCurl(Policy):

    async def pre_execute(self, ctx: ExecuteContext) -> Action | None:
        if ctx.command == "curl":
            return Deny("curl: no network\n", 126)
        return None


def _path(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual,
                    resource_path="",
                    raw_path=virtual,
                    resolved=True)


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
async def test_pre_execute_gate_passes_when_nothing_wants_it():
    assert await pre_execute_gate(Policies(), _exec_ctx("ls")) == (None, None)


@pytest.mark.asyncio
async def test_pre_execute_gate_returns_the_route():
    policies = Policies()
    policies.add(RoutePython())
    deny, route = await pre_execute_gate(policies, _exec_ctx("python3"))
    assert deny is None
    assert route == Route("monty")
    assert await pre_execute_gate(policies, _exec_ctx("ls")) == (None, None)


@pytest.mark.asyncio
async def test_pre_execute_gate_returns_the_deny():
    policies = Policies()
    policies.add(DenyCurl())
    deny, route = await pre_execute_gate(policies, _exec_ctx("curl"))
    assert deny is not None
    assert deny.message == "curl: no network\n"
    assert deny.exit_code == 126
    assert route is None


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


@pytest.mark.asyncio
async def test_post_ops_gate_returns_the_merged_bound():
    policies = Policies()
    policies.add(CapFour())
    bound = await post_ops_gate(policies, "read", _path("/data/x"), False,
                                "/data/", b"payload")
    assert bound is not None
    assert bound.max_bytes == 4


@pytest.mark.asyncio
async def test_post_execute_gate_merges_user_limits():
    policies = Policies()
    policies.add(CapLines())
    deny, bound = await post_execute_gate(
        policies,
        ExecuteResultContext(producer=Producer(command="echo"), exit_code=0))
    assert deny is None
    assert bound is not None
    assert bound.max_lines == 2

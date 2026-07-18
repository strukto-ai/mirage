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

from mirage.runtime.base import RunArgs, RunResult, Runtime
from mirage.runtime.route import (RouteContext, ScriptSource, command_facts,
                                  decide_line, evaluate_route, evaluate_script)
from mirage.runtime.table import VfsRuntime
from mirage.workspace.workspace import parse


class AlphaRuntime(Runtime):
    name = "alpha"
    captures = ("python3", "python")

    async def run(self, args: RunArgs) -> RunResult:
        return RunResult(stdout=b"alpha\n", stderr=None, exit_code=0)


class BetaRuntime(Runtime):
    name = "beta"
    captures = ("python3", "python")

    async def run(self, args: RunArgs) -> RunResult:
        return RunResult(stdout=b"beta\n", stderr=None, exit_code=0)


def ctx_for(line: str) -> RouteContext:
    facts = command_facts(parse(line))
    return RouteContext(line=line,
                        commands=facts,
                        command=facts[0].command if facts else "",
                        builtin=facts[0].builtin if facts else False,
                        cwd="/",
                        env={},
                        session_id="s",
                        agent_id="a",
                        mounts=("/data", ))


@pytest.mark.asyncio
async def test_script_callable_and_awaitable():
    runtime = AlphaRuntime()

    async def wants(ctx: RouteContext) -> bool:
        return "yes" in ctx.line

    assert await evaluate_script(wants, ctx_for("echo yes"), runtime, None)
    assert not await evaluate_script(lambda c: False, ctx_for("echo"), runtime,
                                     None)


@pytest.mark.asyncio
async def test_script_monty_last_expression_is_verdict():
    runtime = AlphaRuntime()
    script = ScriptSource(
        "ctx['runtime']['name'] == 'alpha' and ctx['command'] == 'cat'")
    assert await evaluate_script(script, ctx_for("cat /a"), runtime, None)
    assert not await evaluate_script(script, ctx_for("ls /a"), runtime, None)


@pytest.mark.asyncio
async def test_script_monty_errors_fail_loud():
    with pytest.raises(ValueError, match="syntax error"):
        await evaluate_script(ScriptSource("def broken("), ctx_for("x"),
                              AlphaRuntime(), None)
    with pytest.raises(ValueError, match="failed"):
        await evaluate_script(ScriptSource("1 / 0"), ctx_for("x"),
                              AlphaRuntime(), None)


@pytest.mark.asyncio
async def test_route_returns_name_or_none_only():
    assert await evaluate_route(lambda c: None, ctx_for("x"), None) is None
    assert await evaluate_route(ScriptSource("'beta'"), ctx_for("x"),
                                None) == "beta"
    with pytest.raises(ValueError, match="runtime name or None"):
        await evaluate_route(lambda c: 42, ctx_for("x"), None)


@pytest.mark.asyncio
async def test_decide_route_overlays_static_bindings():
    alpha, beta = AlphaRuntime(), BetaRuntime()
    routing = await decide_line([alpha, beta, VfsRuntime()], lambda c: "beta",
                                ctx_for("python3 x"), {"python3": alpha}, None)
    assert routing.bindings["python3"] is beta
    assert isinstance(routing.fallback, VfsRuntime)


@pytest.mark.asyncio
async def test_decide_scripts_filter_in_list_order():
    alpha, beta = AlphaRuntime(), BetaRuntime()
    alpha.script = lambda c: False
    routing = await decide_line([alpha, beta, VfsRuntime()], None,
                                ctx_for("python3 x"), {}, None)
    assert routing.bindings["python3"] is beta


@pytest.mark.asyncio
async def test_decide_all_refuse_resolves_command_to_none():
    alpha = AlphaRuntime()
    alpha.script = lambda c: False
    routing = await decide_line([alpha, VfsRuntime()], None,
                                ctx_for("python3 x"), {}, None)
    assert routing.bindings["python3"] is None
    assert isinstance(routing.fallback, VfsRuntime)


@pytest.mark.asyncio
async def test_decide_vfs_entry_script_gates_vfs():
    vfs = VfsRuntime(script=lambda c: "/secret" not in c.line)
    allowed = await decide_line([vfs], None, ctx_for("cat /notes"), {}, None)
    denied = await decide_line([vfs], None, ctx_for("cat /secret/x"), {}, None)
    assert allowed.fallback is vfs
    assert denied.fallback is None


@pytest.mark.asyncio
async def test_decide_declared_captures_turn_the_catch_all_off():
    vfs = VfsRuntime(captures=["grep"])
    routing = await decide_line([vfs], None, ctx_for("grep x /a"), {}, None)
    assert routing.bindings["grep"] is vfs
    assert routing.fallback is None


@pytest.mark.asyncio
async def test_scripts_see_their_own_stage_on_pipelines():
    alpha = AlphaRuntime()
    seen: list[str] = []
    alpha.script = lambda c: seen.append(c.command) or True
    await decide_line([alpha, VfsRuntime()], None,
                      ctx_for("cat /a.txt | python3 x"), {}, None)
    assert seen == ["python3"]


def test_for_runtime_keeps_first_stage_for_the_catch_all():
    ctx = ctx_for("cat /a.txt | python3 x")
    assert ctx.for_runtime(VfsRuntime()).command == "cat"
    assert ctx.for_runtime(AlphaRuntime()).command == "python3"

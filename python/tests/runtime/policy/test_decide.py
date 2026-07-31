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

from mirage.runtime.base import Runtime
from mirage.runtime.policy import (DenyResult, PolicyContext, PolicyDeny,
                                   PolicyError, RouteResult, ScriptSource,
                                   command_facts, decide_line, evaluate_policy,
                                   evaluate_script, evaluator_of,
                                   parse_verdict)
from mirage.runtime.python.monty import MontyRuntime
from mirage.runtime.table import VfsRuntime
from mirage.runtime.types import RunArgs, RunResult
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


def ctx_for(line: str) -> PolicyContext:
    facts = command_facts(parse(line))
    return PolicyContext(line=line,
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

    async def wants(ctx: PolicyContext) -> bool:
        return "yes" in ctx.line

    assert await evaluate_script(wants, ctx_for("echo yes"), runtime, None)
    assert not await evaluate_script(lambda c: False, ctx_for("echo"), runtime,
                                     None)


@pytest.mark.asyncio
async def test_script_source_last_expression_is_verdict():
    runtime = AlphaRuntime()
    evaluator = MontyRuntime()
    script = ScriptSource(
        "ctx['runtime']['name'] == 'alpha' and ctx['command'] == 'cat'")
    assert await evaluate_script(script, ctx_for("cat /a"), runtime, evaluator)
    assert not await evaluate_script(script, ctx_for("ls /a"), runtime,
                                     evaluator)


@pytest.mark.asyncio
async def test_script_source_errors_fail_loud():
    with pytest.raises(ValueError, match="syntax error"):
        await evaluate_script(ScriptSource("def broken("), ctx_for("x"),
                              AlphaRuntime(), MontyRuntime())
    with pytest.raises(ValueError, match="failed"):
        await evaluate_script(ScriptSource("1 / 0"), ctx_for("x"),
                              AlphaRuntime(), MontyRuntime())


@pytest.mark.asyncio
async def test_script_source_needs_an_evaluator():
    """A world with no evaluator refuses config scripts loud."""
    with pytest.raises(ValueError, match="evaluator runtime"):
        await evaluate_script(ScriptSource("True"), ctx_for("x"),
                              AlphaRuntime(), None)


def test_evaluator_of_picks_first_evaluator_entry():
    alpha, monty = AlphaRuntime(), MontyRuntime()
    assert evaluator_of([alpha, monty, VfsRuntime()]) is monty
    assert evaluator_of([alpha, VfsRuntime()]) is None


@pytest.mark.asyncio
async def test_policy_returns_name_none_or_verdict_dict():
    assert await evaluate_policy(lambda c: None, ctx_for("x"), None) is None
    assert await evaluate_policy(ScriptSource("'beta'"), ctx_for("x"),
                                 MontyRuntime()) == "beta"
    assert await evaluate_policy(lambda c: {"runtime": "beta"}, ctx_for("x"),
                                 None) == "beta"
    with pytest.raises(ValueError, match="verdict dict, or None"):
        await evaluate_policy(lambda c: 42, ctx_for("x"), None)


@pytest.mark.asyncio
async def test_policy_deny_verdict_raises_with_reason():
    with pytest.raises(PolicyDeny) as caught:
        await evaluate_policy(lambda c: {"deny": "blocked here"}, ctx_for("x"),
                              None)
    assert caught.value.reason == "blocked here"
    with pytest.raises(PolicyDeny, match="no python3"):
        await evaluate_policy(
            ScriptSource("{'deny': 'no python3'} "
                         "if ctx['command'] == 'python3' else None"),
            ctx_for("python3 x"), MontyRuntime())


@pytest.mark.asyncio
async def test_policy_result_arms_parse():
    assert parse_verdict(RouteResult("beta")) == "beta"
    with pytest.raises(PolicyDeny, match="not here"):
        parse_verdict(DenyResult("not here"))
    assert await evaluate_policy(lambda c: RouteResult("beta"), ctx_for("x"),
                                 None) == "beta"
    with pytest.raises(PolicyDeny, match="blocked"):
        await evaluate_policy(lambda c: DenyResult("blocked"), ctx_for("x"),
                              None)


@pytest.mark.asyncio
async def test_entry_script_verdict_shapes_fail_loud():
    """A deny-dict is truthy; coercing it would mean willing."""
    runtime = AlphaRuntime()
    with pytest.raises(PolicyError, match="answer a boolean"):
        await evaluate_script(lambda c: {"deny": "x"}, ctx_for("python3 x"),
                              runtime, None)
    with pytest.raises(PolicyError, match="answer a boolean"):
        await evaluate_script(lambda c: DenyResult("x"), ctx_for("python3 x"),
                              runtime, None)
    with pytest.raises(PolicyError, match="answer a boolean"):
        await evaluate_script(ScriptSource("{'deny': 'x'}"),
                              ctx_for("python3 x"), runtime, MontyRuntime())


def test_parse_verdict_raises_policy_error():
    """Direct callers get PolicyError, mirroring the TS parseVerdict."""
    with pytest.raises(PolicyError):
        parse_verdict(42)


def test_parse_verdict_fails_loud_on_bad_dicts():
    with pytest.raises(ValueError, match="unknown policy verdict keys"):
        parse_verdict({"runtme": "beta"})
    with pytest.raises(ValueError, match="both place and deny"):
        parse_verdict({"runtime": "beta", "deny": "no"})
    with pytest.raises(ValueError, match="needs a 'runtime' name"):
        parse_verdict({})


@pytest.mark.asyncio
async def test_decide_route_overlays_static_bindings():
    alpha, beta = AlphaRuntime(), BetaRuntime()
    routing = await decide_line([alpha, beta, VfsRuntime()], lambda c: "beta",
                                ctx_for("python3 x"), {"python3": alpha})
    assert routing.bindings["python3"] is beta
    assert isinstance(routing.fallback, VfsRuntime)


@pytest.mark.asyncio
async def test_decide_scripts_filter_in_list_order():
    alpha, beta = AlphaRuntime(), BetaRuntime()
    alpha.script = lambda c: False
    routing = await decide_line([alpha, beta, VfsRuntime()], None,
                                ctx_for("python3 x"), {})
    assert routing.bindings["python3"] is beta


@pytest.mark.asyncio
async def test_decide_all_refuse_resolves_command_to_none():
    alpha = AlphaRuntime()
    alpha.script = lambda c: False
    routing = await decide_line([alpha, VfsRuntime()], None,
                                ctx_for("python3 x"), {})
    assert routing.bindings["python3"] is None
    assert isinstance(routing.fallback, VfsRuntime)


@pytest.mark.asyncio
async def test_decide_vfs_entry_script_gates_vfs():
    vfs = VfsRuntime(script=lambda c: "/secret" not in c.line)
    allowed = await decide_line([vfs], None, ctx_for("cat /notes"), {})
    denied = await decide_line([vfs], None, ctx_for("cat /secret/x"), {})
    assert allowed.fallback is vfs
    assert denied.fallback is None


@pytest.mark.asyncio
async def test_decide_declared_captures_turn_the_catch_all_off():
    vfs = VfsRuntime(captures=["grep"])
    routing = await decide_line([vfs], None, ctx_for("grep x /a"), {})
    assert routing.bindings["grep"] is vfs
    assert routing.fallback is None


@pytest.mark.asyncio
async def test_scripts_see_their_own_stage_on_pipelines():
    alpha = AlphaRuntime()
    seen: list[str] = []
    alpha.script = lambda c: seen.append(c.command) or True
    await decide_line([alpha, VfsRuntime()], None,
                      ctx_for("cat /a.txt | python3 x"), {})
    assert seen == ["python3"]


def test_for_runtime_keeps_first_stage_for_the_catch_all():
    ctx = ctx_for("cat /a.txt | python3 x")
    assert ctx.for_runtime(VfsRuntime()).command == "cat"
    assert ctx.for_runtime(AlphaRuntime()).command == "python3"

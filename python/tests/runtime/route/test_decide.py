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

from mirage.policy import Deny, ExecuteContext, PolicyError
from mirage.runtime.base import Runtime
from mirage.runtime.mixin import EvaluatorMixin
from mirage.runtime.python.monty import MontyRuntime
from mirage.runtime.route import (ScriptSource, decide_line, evaluate_script,
                                  evaluator_of, parsed_commands)
from mirage.runtime.table import VfsRuntime
from mirage.runtime.types import EvalResult, RunArgs, RunResult
from mirage.shell.parse import parse


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


class JsEvaluator(Runtime, EvaluatorMixin):
    name = "js-eval"
    captures = ("node", )
    eval_language = "js"

    def __init__(self) -> None:
        super().__init__()
        self.calls: list[str] = []

    async def run(self, args: RunArgs) -> RunResult:
        return RunResult(stdout=b"", stderr=None, exit_code=0)

    async def eval(self, code, *, inputs=None, session=None):
        self.calls.append(code)
        return EvalResult(value=None,
                          stdout=b"",
                          stderr=None,
                          exit_code=0,
                          status="complete")


def ctx_for(line: str) -> ExecuteContext:
    commands = parsed_commands(parse(line))
    return ExecuteContext(line=line,
                          commands=commands,
                          command=commands[0].command if commands else "",
                          builtin=commands[0].builtin if commands else False,
                          cwd="/",
                          env={},
                          session_id="s",
                          agent_id="a",
                          mounts=("/data", ))


@pytest.mark.asyncio
async def test_script_callable_and_awaitable():
    runtime = AlphaRuntime()

    async def wants(ctx: ExecuteContext) -> bool:
        return "yes" in ctx.line

    assert await evaluate_script(wants, ctx_for("echo yes"), runtime, [])
    assert not await evaluate_script(lambda c: False, ctx_for("echo"), runtime,
                                     [])


@pytest.mark.asyncio
async def test_script_source_last_expression_is_verdict():
    runtime = AlphaRuntime()
    evaluator = MontyRuntime()
    script = ScriptSource(
        "ctx['runtime']['name'] == 'alpha' and ctx['command'] == 'cat'")
    assert await evaluate_script(script, ctx_for("cat /a"), runtime,
                                 [evaluator])
    assert not await evaluate_script(script, ctx_for("ls /a"), runtime,
                                     [evaluator])


@pytest.mark.asyncio
async def test_script_source_errors_fail_loud():
    with pytest.raises(PolicyError, match="syntax error"):
        await evaluate_script(ScriptSource("def broken("), ctx_for("x"),
                              AlphaRuntime(), [MontyRuntime()])
    with pytest.raises(PolicyError, match="failed"):
        await evaluate_script(ScriptSource("1 / 0"), ctx_for("x"),
                              AlphaRuntime(), [MontyRuntime()])


@pytest.mark.asyncio
async def test_script_source_needs_an_evaluator():
    """A world with no evaluator refuses config scripts loud."""
    with pytest.raises(PolicyError, match="evaluator runtime"):
        await evaluate_script(ScriptSource("True"), ctx_for("x"),
                              AlphaRuntime(), [])


def test_evaluator_of_picks_first_evaluator_entry():
    alpha, monty = AlphaRuntime(), MontyRuntime()
    assert evaluator_of([alpha, monty, VfsRuntime()]) is monty
    assert evaluator_of([alpha, VfsRuntime()]) is None


def test_evaluator_of_prefers_a_language_match():
    monty, js = MontyRuntime(), JsEvaluator()
    assert evaluator_of([monty, js], "js") is js
    assert evaluator_of([monty, js], "python") is monty
    assert evaluator_of([monty, js]) is monty
    assert evaluator_of([monty], "js") is monty
    assert evaluator_of([], "js") is None


@pytest.mark.asyncio
async def test_entry_script_verdict_shapes_fail_loud():
    """A deny-dict is truthy; coercing it would mean willing."""
    runtime = AlphaRuntime()
    with pytest.raises(PolicyError, match="answer a boolean"):
        await evaluate_script(lambda c: {"deny": "x"}, ctx_for("python3 x"),
                              runtime, [])
    with pytest.raises(PolicyError, match="answer a boolean"):
        await evaluate_script(lambda c: Deny("x"), ctx_for("python3 x"),
                              runtime, [])
    with pytest.raises(PolicyError, match="answer a boolean"):
        await evaluate_script(ScriptSource("{'deny': 'x'}"),
                              ctx_for("python3 x"), runtime, [MontyRuntime()])


@pytest.mark.asyncio
async def test_decide_scripts_filter_in_list_order():
    alpha, beta = AlphaRuntime(), BetaRuntime()
    alpha.script = lambda c: False
    routing = await decide_line([alpha, beta, VfsRuntime()],
                                ctx_for("python3 x"))
    assert routing.bindings["python3"] is beta


@pytest.mark.asyncio
async def test_decide_all_refuse_resolves_command_to_none():
    alpha = AlphaRuntime()
    alpha.script = lambda c: False
    routing = await decide_line([alpha, VfsRuntime()], ctx_for("python3 x"))
    assert routing.bindings["python3"] is None
    assert isinstance(routing.fallback, VfsRuntime)


@pytest.mark.asyncio
async def test_decide_vfs_entry_script_gates_vfs():
    vfs = VfsRuntime(script=lambda c: "/secret" not in c.line)
    allowed = await decide_line([vfs], ctx_for("cat /notes"))
    denied = await decide_line([vfs], ctx_for("cat /secret/x"))
    assert allowed.fallback is vfs
    assert denied.fallback is None


@pytest.mark.asyncio
async def test_decide_declared_captures_turn_the_catch_all_off():
    vfs = VfsRuntime(captures=["grep"])
    routing = await decide_line([vfs], ctx_for("grep x /a"))
    assert routing.bindings["grep"] is vfs
    assert routing.fallback is None


@pytest.mark.asyncio
async def test_scripts_see_their_own_stage_on_pipelines():
    alpha = AlphaRuntime()
    seen: list[str] = []
    alpha.script = lambda c: seen.append(c.command) or True
    await decide_line([alpha, VfsRuntime()], ctx_for("cat /a.txt | python3 x"))
    assert seen == ["python3"]


def test_for_runtime_keeps_first_stage_for_the_catch_all():
    ctx = ctx_for("cat /a.txt | python3 x")
    assert ctx.for_runtime(VfsRuntime()).command == "cat"
    assert ctx.for_runtime(AlphaRuntime()).command == "python3"

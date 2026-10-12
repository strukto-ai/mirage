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

import asyncio

import pytest

import mirage.runtime.routing.decide as decide_mod
from mirage.commands.spec.types import WordKind
from mirage.policy.types import CommandContext, CommandWord, Deny, RouteContext
from mirage.runtime.base import Runtime
from mirage.runtime.js.base import JsRuntime
from mirage.runtime.mixin import EvaluatorMixin
from mirage.runtime.python.local import LocalRuntime
from mirage.runtime.python.monty import MontyRuntime
from mirage.runtime.routing import (
    RouteError,
    ScriptSource,
    command_nodes,
    decide_line,
    evaluate_policy,
    evaluate_script,
    evaluator_of,
    runtime_for_language,
)
from mirage.runtime.types import RunArgs, RunResult
from mirage.runtime.workspace import WorkspaceRuntime
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


def ctx_for(line: str) -> RouteContext:
    commands = []
    for node in command_nodes(parse(line)):
        words = [
            child.text.decode()
            for child in node.children
            if child.type in ("command_name", "word") and child.text
        ]
        commands.append(
            CommandContext(
                command=words[0],
                paths=(),
                argv=tuple(words[1:]),
                cwd="/",
                line=line,
                words=(
                    CommandWord(words[0], WordKind.NAME),
                    *(CommandWord(w, WordKind.OPERAND) for w in words[1:]),
                ),
            )
        )
    return RouteContext(
        line=line, commands=tuple(commands), session_id="s", agent_id="a"
    )


@pytest.mark.asyncio
async def test_script_callable_and_awaitable():
    runtime = AlphaRuntime()

    async def wants(ctx: RouteContext) -> bool:
        return "yes" in ctx.line

    assert await evaluate_script(wants, ctx_for("echo yes"), runtime, [])
    assert not await evaluate_script(
        lambda c: False, ctx_for("echo"), runtime, []
    )


@pytest.mark.asyncio
async def test_script_source_last_expression_is_verdict():
    runtime = AlphaRuntime()
    evaluator = MontyRuntime()
    script = ScriptSource(
        "ctx['runtime']['name'] == 'alpha' "
        "and ctx['commands'][0]['command'] == 'cat'"
    )
    assert await evaluate_script(
        script, ctx_for("cat /a"), runtime, [evaluator]
    )
    assert not await evaluate_script(
        script, ctx_for("ls /a"), runtime, [evaluator]
    )


@pytest.mark.asyncio
async def test_script_source_errors_fail_loud():
    with pytest.raises(ValueError, match="syntax error"):
        await evaluate_script(
            ScriptSource("def broken("),
            ctx_for("x"),
            AlphaRuntime(),
            [MontyRuntime()],
        )
    with pytest.raises(ValueError, match="failed"):
        await evaluate_script(
            ScriptSource("1 / 0"),
            ctx_for("x"),
            AlphaRuntime(),
            [MontyRuntime()],
        )


@pytest.mark.asyncio
async def test_script_source_needs_an_evaluator():
    """A world with no evaluator refuses config scripts loud."""
    with pytest.raises(ValueError, match="evaluator runtime"):
        await evaluate_script(
            ScriptSource("True"), ctx_for("x"), AlphaRuntime(), []
        )


def test_evaluator_of_picks_first_evaluator_entry():
    alpha, monty = AlphaRuntime(), MontyRuntime()
    assert evaluator_of([alpha, monty, WorkspaceRuntime()]) is monty
    assert evaluator_of([alpha, WorkspaceRuntime()]) is None


class JsEvaluator(JsRuntime, EvaluatorMixin):
    name = "js-eval"
    captures = ("node",)

    def __init__(self) -> None:
        super().__init__()
        self.calls: list[str] = []

    async def run(self, args: RunArgs) -> RunResult:
        return RunResult(stdout=b"", stderr=None, exit_code=0)

    async def eval(self, code, *, inputs=None, session=None):
        from mirage.runtime.types import EvalResult

        self.calls.append(code)
        return EvalResult(
            value=None, stdout=b"", stderr=None, exit_code=0, status="complete"
        )


class HangingEvaluator(Runtime, EvaluatorMixin):
    name = "hang-eval"
    captures = ("python3",)

    async def run(self, args: RunArgs) -> RunResult:
        return RunResult(stdout=b"", stderr=None, exit_code=0)

    async def eval(self, code, *, inputs=None, session=None):
        await asyncio.sleep(60)


def test_evaluator_of_prefers_a_language_match():
    monty, js = MontyRuntime(), JsEvaluator()
    assert evaluator_of([monty, js], "js") is js
    assert evaluator_of([monty, js], "python") is monty
    assert evaluator_of([monty, js]) is monty
    assert evaluator_of([monty], "js") is monty
    assert evaluator_of([], "js") is None


def test_one_language_attribute_serves_both_entry_points():
    # The eval entry point and the run entry point read the same
    # Runtime.language, so an engine cannot be picked as a js interpreter and a
    # python evaluator at once. Two attributes could disagree, and the
    # disagreement only showed up as an unexplained 127 or a policy
    # script evaluated on the wrong engine.
    js = JsEvaluator()
    assert evaluator_of([js], "js") is js
    assert runtime_for_language([js], "js") is js
    assert runtime_for_language([js], "python") is None


def test_runtime_for_language_is_first_match_wins():
    monty, local, js = MontyRuntime(), LocalRuntime(), JsEvaluator()
    assert runtime_for_language([monty, local, js], "python") is monty
    assert runtime_for_language([local, monty, js], "python") is local
    assert runtime_for_language([monty, js], "js") is js


def test_runtime_for_language_has_no_cross_language_fallback():
    # evaluator_of serves the first evaluator when nothing matches; the
    # run selector must not: a python program cannot run on a js
    # engine. Captures do not count either (alpha captures python3 but
    # declares no language), and an empty world selects nothing.
    assert runtime_for_language([JsEvaluator()], "python") is None
    assert (
        runtime_for_language([AlphaRuntime(), WorkspaceRuntime()], "python")
        is None
    )
    assert runtime_for_language([], "js") is None


@pytest.mark.asyncio
async def test_js_policy_script_selects_the_js_evaluator():
    js = JsEvaluator()
    verdict = await evaluate_policy(
        ScriptSource("null", language="js"),
        ctx_for("node -e 1"),
        [MontyRuntime(), js],
    )
    assert verdict is None
    assert js.calls == ["null"]


@pytest.mark.asyncio
async def test_hung_policy_script_times_out(monkeypatch):
    monkeypatch.setattr(decide_mod, "SCRIPT_EVAL_TIMEOUT_SECONDS", 0.05)
    with pytest.raises(RouteError, match="timed out after 0.05s"):
        await evaluate_policy(
            ScriptSource("1"), ctx_for("x"), [HangingEvaluator()]
        )


@pytest.mark.asyncio
async def test_policy_answers_come_back_unread():
    assert await evaluate_policy(lambda c: None, ctx_for("x"), []) is None
    assert (
        await evaluate_policy(
            ScriptSource("'beta'"), ctx_for("x"), [MontyRuntime()]
        )
        == "beta"
    )
    assert await evaluate_policy(
        lambda c: {"route": "beta"}, ctx_for("x"), []
    ) == {"route": "beta"}
    assert await evaluate_policy(
        ScriptSource(
            "{'deny': 'no python3'} "
            "if ctx['commands'][0]['command'] == 'python3' else None"
        ),
        ctx_for("python3 x"),
        [MontyRuntime()],
    ) == {"deny": "no python3"}


@pytest.mark.asyncio
async def test_entry_script_verdict_shapes_fail_loud():
    """A deny-dict is truthy; coercing it would mean willing."""
    runtime = AlphaRuntime()
    with pytest.raises(RouteError, match="answer a boolean"):
        await evaluate_script(
            lambda c: {"deny": "x"}, ctx_for("python3 x"), runtime, []
        )
    with pytest.raises(RouteError, match="answer a boolean"):
        await evaluate_script(
            lambda c: Deny("x"), ctx_for("python3 x"), runtime, []
        )
    with pytest.raises(RouteError, match="answer a boolean"):
        await evaluate_script(
            ScriptSource("{'deny': 'x'}"),
            ctx_for("python3 x"),
            runtime,
            [MontyRuntime()],
        )


@pytest.mark.asyncio
async def test_decide_scripts_filter_in_list_order():
    alpha, beta = AlphaRuntime(), BetaRuntime()
    alpha.script = lambda c: False
    routing = await decide_line(
        [alpha, beta, WorkspaceRuntime()], ctx_for("python3 x")
    )
    assert routing.bindings["python3"] is beta


@pytest.mark.asyncio
async def test_decide_all_refuse_resolves_command_to_none():
    alpha = AlphaRuntime()
    alpha.script = lambda c: False
    routing = await decide_line(
        [alpha, WorkspaceRuntime()], ctx_for("python3 x")
    )
    assert routing.bindings["python3"] is None
    assert isinstance(routing.fallback, WorkspaceRuntime)


@pytest.mark.asyncio
async def test_decide_vfs_entry_script_gates_vfs():
    vfs = WorkspaceRuntime(script=lambda c: "/secret" not in c.line)
    allowed = await decide_line([vfs], ctx_for("cat /notes"))
    denied = await decide_line([vfs], ctx_for("cat /secret/x"))
    assert allowed.fallback is vfs
    assert denied.fallback is None


@pytest.mark.asyncio
async def test_decide_declared_captures_turn_the_catch_all_off():
    vfs = WorkspaceRuntime(captures=["grep"])
    routing = await decide_line([vfs], ctx_for("grep x /a"))
    assert routing.bindings["grep"] is vfs
    assert routing.fallback is None


@pytest.mark.asyncio
async def test_scripts_see_every_command_of_a_pipeline():
    alpha = AlphaRuntime()
    seen: list[list[str]] = []
    alpha.script = lambda c: (
        seen.append([x.command for x in c.commands]) or True
    )
    await decide_line(
        [alpha, WorkspaceRuntime()], ctx_for("cat /a.txt | python3 x")
    )
    assert seen == [["cat", "python3"]]

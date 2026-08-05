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

import mirage.runtime.route.decide as decide_mod
from mirage.policy import Deny, ExecuteContext, PolicyError, Route
from mirage.runtime.base import Runtime
from mirage.runtime.mixin import EvaluatorMixin
from mirage.runtime.python.monty import MontyRuntime
from mirage.runtime.route import (RoutingPolicy, ScriptSource, parse_verdict,
                                  parsed_commands)
from mirage.runtime.types import EvalResult, RunArgs, RunResult
from mirage.shell.parse import parse


class World:

    def __init__(self, entries: list[Runtime]) -> None:
        self._entries = entries

    @property
    def entries(self) -> list[Runtime]:
        return self._entries


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


class HangingEvaluator(Runtime, EvaluatorMixin):
    name = "hang-eval"
    captures = ("python3", )

    async def run(self, args: RunArgs) -> RunResult:
        return RunResult(stdout=b"", stderr=None, exit_code=0)

    async def eval(self, code, *, inputs=None, session=None):
        await asyncio.sleep(60)


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


def test_parse_verdict_normalizes_to_the_action_arms():
    assert parse_verdict(None) is None
    assert parse_verdict("beta") == Route("beta")
    assert parse_verdict(Route("beta")) == Route("beta")
    assert parse_verdict(Deny("not here", 126)) == Deny("not here", 126)
    assert parse_verdict({"runtime": "beta"}) == Route("beta")
    assert parse_verdict({"deny": "blocked"}) == Deny("blocked", 126)


def test_parse_verdict_raises_policy_error():
    """Direct callers get PolicyError, mirroring the TS parseVerdict."""
    with pytest.raises(PolicyError):
        parse_verdict(42)


def test_parse_verdict_fails_loud_on_bad_dicts():
    with pytest.raises(PolicyError, match="unknown policy verdict keys"):
        parse_verdict({"runtme": "beta"})
    with pytest.raises(PolicyError, match="both place and deny"):
        parse_verdict({"runtime": "beta", "deny": "no"})
    with pytest.raises(PolicyError, match="needs a 'runtime' name"):
        parse_verdict({})


@pytest.mark.asyncio
async def test_routing_policy_returns_name_none_or_verdict_dict():
    world = World([])
    assert await RoutingPolicy(lambda c: None,
                               world).pre_execute(ctx_for("x")) is None
    assert await RoutingPolicy(lambda c: {
        "runtime": "beta"
    }, world).pre_execute(ctx_for("x")) == Route("beta")
    assert await RoutingPolicy(ScriptSource("'beta'"),
                               World([MontyRuntime()
                                      ])).pre_execute(ctx_for("x")
                                                      ) == Route("beta")
    with pytest.raises(PolicyError, match="verdict dict, or None"):
        await RoutingPolicy(lambda c: 42, world).pre_execute(ctx_for("x"))


@pytest.mark.asyncio
async def test_routing_policy_deny_verdict_carries_the_reason():
    world = World([])
    deny = await RoutingPolicy(lambda c: {
        "deny": "blocked here"
    }, world).pre_execute(ctx_for("x"))
    assert deny == Deny("blocked here", 126)
    action = await RoutingPolicy(
        ScriptSource("{'deny': 'no python3'} "
                     "if ctx['command'] == 'python3' else None"),
        World([MontyRuntime()])).pre_execute(ctx_for("python3 x"))
    assert action == Deny("no python3", 126)


@pytest.mark.asyncio
async def test_routing_policy_awaits_async_callables():

    async def policy(ctx: ExecuteContext) -> str | None:
        return "beta" if ctx.command == "python3" else None

    routing = RoutingPolicy(policy, World([]))
    assert await routing.pre_execute(ctx_for("python3 x")) == Route("beta")
    assert await routing.pre_execute(ctx_for("ls /")) is None


@pytest.mark.asyncio
async def test_js_policy_script_selects_the_js_evaluator():
    js = JsEvaluator()
    routing = RoutingPolicy(ScriptSource("null", language="js"),
                            World([MontyRuntime(), js]))
    assert await routing.pre_execute(ctx_for("node -e 1")) is None
    assert js.calls == ["null"]


@pytest.mark.asyncio
async def test_hung_policy_script_times_out(monkeypatch):
    monkeypatch.setattr(decide_mod, "POLICY_EVAL_TIMEOUT_SECONDS", 0.05)
    routing = RoutingPolicy(ScriptSource("1"), World([HangingEvaluator()]))
    with pytest.raises(PolicyError, match="timed out after 0.05s"):
        await routing.pre_execute(ctx_for("x"))

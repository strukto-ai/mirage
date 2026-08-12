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

from dataclasses import dataclass

import pytest

from mirage.io import IOResult
from mirage.io.types import materialize
from mirage.shell.errors import ArithError
from mirage.workspace.executor.control import (BreakSignal, ContinueSignal,
                                               handle_case, handle_cfor,
                                               handle_for, handle_if,
                                               handle_until, handle_while)
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode


@dataclass
class FakeNode:
    text: str
    type: str = "command"


def node(text: str) -> FakeNode:
    return FakeNode(text=text)


def session(**kwargs) -> Session:
    return Session(session_id="test", **kwargs)


async def text_of(stdout) -> str:
    if stdout is None:
        return ""
    return (await materialize(stdout)).decode()


def result(stdout=None, exit_code=0):
    return stdout, IOResult(exit_code=exit_code), ExecutionNode()


@pytest.mark.asyncio
async def test_if_runs_the_first_matching_branch_and_skips_the_rest():
    calls = []

    async def execute(n, *_args):
        calls.append(n.text)
        if n.text == "c1":
            return result(exit_code=1)
        if n.text == "c2":
            return result()
        return result(f"{n.text}-out".encode())

    branches = [(node("c1"), [node("b1")]), (node("c2"), [node("b2")])]
    stdout, io, _ = await handle_if(execute, branches, None, session())
    assert io.exit_code == 0
    assert await text_of(stdout) == "b2-out"
    assert calls == ["c1", "c2", "b2"]


@pytest.mark.asyncio
async def test_if_runs_the_else_body_when_no_branch_matches():

    async def execute(n, *_args):
        if n.text == "c":
            return result(exit_code=1)
        return result(b"else-out")

    stdout, io, _ = await handle_if(execute, [(node("c"), [node("b")])],
                                    [node("e")], session())
    assert io.exit_code == 0
    assert await text_of(stdout) == "else-out"


@pytest.mark.asyncio
async def test_if_without_an_else_body_succeeds_silently():

    async def execute(_n, *_args):
        return result(exit_code=1)

    stdout, io, _ = await handle_if(execute, [(node("c"), [node("b")])], None,
                                    session())
    assert io.exit_code == 0
    assert stdout is None


@pytest.mark.asyncio
async def test_for_iterates_values_binding_the_loop_variable():
    seen = []
    sess = session()

    async def execute(_n, s, *_args):
        seen.append(s.env.get("X", ""))
        return result(f"iter-{s.env.get('X', '')}\n".encode())

    stdout, _, _ = await handle_for(execute, "X", ["a", "b", "c"],
                                    [node("body")], sess)
    assert seen == ["a", "b", "c"]
    assert await text_of(stdout) == "iter-a\niter-b\niter-c\n"
    assert "X" not in sess.env


@pytest.mark.asyncio
async def test_for_stops_early_on_break():
    seen = []

    async def execute(_n, s, *_args):
        seen.append(s.env["X"])
        if s.env["X"] == "b":
            raise BreakSignal()
        return result()

    await handle_for(execute, "X", ["a", "b", "c"], [node("body")], session())
    assert seen == ["a", "b"]


@pytest.mark.asyncio
async def test_for_skips_to_the_next_iteration_on_continue():
    seen = []

    async def execute(_n, s, *_args):
        seen.append(s.env["X"])
        if s.env["X"] == "b":
            raise ContinueSignal()
        return result()

    await handle_for(execute, "X", ["a", "b", "c"], [node("body")], session())
    assert seen == ["a", "b", "c"]


@pytest.mark.asyncio
async def test_for_restores_a_shadowed_loop_variable():
    sess = session(env={"X": "saved"})

    async def execute(*_args):
        return result()

    await handle_for(execute, "X", ["a"], [node("body")], sess)
    assert sess.env["X"] == "saved"


@pytest.mark.asyncio
async def test_for_carries_a_multi_level_break_out_to_the_caller():
    seen = []

    async def execute(_n, s, *_args):
        seen.append(s.env["X"])
        raise BreakSignal(levels=2)

    with pytest.raises(BreakSignal) as caught:
        await handle_for(execute, "X", ["a", "b"], [node("body")], session())
    assert caught.value.levels == 1
    assert seen == ["a"]


@pytest.mark.asyncio
async def test_while_runs_the_body_while_the_condition_succeeds():
    state = {"i": 0}

    async def execute(n, *_args):
        if n.text == "cond":
            return result(exit_code=0 if state["i"] < 2 else 1)
        state["i"] += 1
        return result(f"{state['i']};".encode())

    stdout, _, _ = await handle_while(execute, node("cond"), [node("body")],
                                      session())
    assert await text_of(stdout) == "1;2;"


@pytest.mark.asyncio
async def test_until_runs_the_body_while_the_condition_fails():
    state = {"i": 0}

    async def execute(n, *_args):
        if n.text == "cond":
            return result(exit_code=0 if state["i"] >= 2 else 1)
        state["i"] += 1
        return result(f"{state['i']};".encode())

    stdout, _, _ = await handle_until(execute, node("cond"), [node("body")],
                                      session())
    assert await text_of(stdout) == "1;2;"


@pytest.mark.asyncio
async def test_while_caps_runaway_loops_and_says_so_on_stderr():

    async def execute(n, *_args):
        return result(exit_code=0) if n.text == "cond" else result()

    _, io, _ = await handle_while(execute, node("cond"), [node("body")],
                                  session())
    assert b"while loop terminated after 10000" in await materialize(io.stderr)


@pytest.mark.asyncio
async def test_case_runs_the_first_arm_whose_pattern_matches():
    ran = []

    async def execute(n, *_args):
        ran.append(n.text)
        return result()

    items = [(["a*"], [node("A")], ";;"), (["b*"], [node("B")], ";;"),
             (["*"], [node("catchall")], ";;")]
    await handle_case(execute, "banana", items, session())
    assert ran == ["B"]


@pytest.mark.asyncio
async def test_case_reaches_the_catchall_arm():
    ran = []

    async def execute(n, *_args):
        ran.append(n.text)
        return result()

    items = [(["a*"], [node("A")], ";;"), (["*"], [node("catchall")], ";;")]
    await handle_case(execute, "xyz", items, session())
    assert ran == ["catchall"]


@pytest.mark.asyncio
async def test_case_succeeds_silently_when_nothing_matches():
    ran = []

    async def execute(n, *_args):
        ran.append(n.text)
        return result()

    items = [(["z*"], [node("body")], ";;")]
    stdout, io, _ = await handle_case(execute, "abc", items, session())
    assert ran == []
    assert io.exit_code == 0
    assert stdout is None


@pytest.mark.asyncio
async def test_case_falls_through_the_next_arm_on_semicolon_amp():
    ran = []

    async def execute(n, *_args):
        ran.append(n.text)
        return result()

    items = [(["a"], [node("A")], ";&"), (["b"], [node("B")], ";;"),
             (["c"], [node("C")], ";;")]
    await handle_case(execute, "a", items, session())
    assert ran == ["A", "B"]


@pytest.mark.asyncio
async def test_case_keeps_testing_later_patterns_on_double_semicolon_amp():
    ran = []

    async def execute(n, *_args):
        ran.append(n.text)
        return result()

    items = [(["a"], [node("A")], ";;&"), (["a"], [node("A2")], ";;&"),
             (["b"], [node("B")], ";;")]
    await handle_case(execute, "a", items, session())
    assert ran == ["A", "A2"]


@pytest.mark.asyncio
async def test_cfor_runs_init_once_then_condition_and_update_per_iteration():
    ran = []
    state = {"i": 0}

    async def execute(n, *_args):
        ran.append(n.text)
        return result()

    async def eval_expr(expr, default):
        if expr is None:
            return default
        if expr.text == "init":
            state["i"] = 0
            return 0
        if expr.text == "cond":
            return 1 if state["i"] < 3 else 0
        state["i"] += 1
        return state["i"]

    exprs = [node("init"), node("cond"), node("update")]
    _, io, _ = await handle_cfor(execute, exprs, [node("body")], eval_expr,
                                 session())
    assert ran == ["body", "body", "body"]
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_cfor_aborts_with_status_1_on_a_bad_expression():

    async def execute(_n, *_args):
        return result(b"ran\n")

    calls = {"n": 0}

    async def eval_expr(expr, default):
        if expr is None:
            return default
        calls["n"] += 1
        if calls["n"] > 2:
            raise ArithError("x +: syntax error")
        return 1

    exprs = [node("init"), node("cond"), node("update")]
    stdout, io, _ = await handle_cfor(execute, exprs, [node("body")],
                                      eval_expr, session())
    assert io.exit_code == 1
    assert b"bash: ((: x +: syntax error" in await materialize(io.stderr)
    assert await text_of(stdout) == "ran\n"

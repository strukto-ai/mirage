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
from functools import partial

import pytest

from mirage.io import IOResult
from mirage.io.types import materialize
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.executor.control import (
    ContinueSignal,
    _absorbed,
    execute_body,
    handle_if,
    handle_while,
)
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode


@dataclass
class FakeNode:
    text: str
    type: str = "command"
    next_sibling: "FakeNode | None" = None


def node(text: str) -> FakeNode:
    return FakeNode(text=text)


def bg(text: str) -> FakeNode:
    """A body statement whose terminator is ``&``.

    Its text is bytes, as a parsed node's is, because the job
    launcher names the job through ``get_text``.
    """
    return FakeNode(
        text=text.encode(), next_sibling=FakeNode(text="&", type="&")
    )


def runner(execute, sess: SessionState):
    return partial(
        execute_body,
        execute,
        context=EvaluationContext(sess),
        stdin=None,
        call_stack=None,
        job_table=None,
        handed=None,
        decisions=None,
    )


def result(stdout=None, exit_code=0):
    return stdout, IOResult(exit_code=exit_code), ExecutionNode()


@pytest.mark.asyncio
async def test_while_stops_at_a_set_e_failure_in_its_body():
    turns = 0

    async def execute(n, *_args):
        nonlocal turns
        if n.text == "cond":
            return result()
        turns += 1
        assert turns < 3
        return result(exit_code=1)

    sess = SessionState(session_id="test")
    sess.shell_options["errexit"] = True
    _, io, _ = await handle_while(
        runner(execute, sess), [node("cond")], [node("body")], sess
    )
    assert (turns, io.exit_code) == (1, 1)


@pytest.mark.asyncio
async def test_a_continue_with_no_output_adds_nothing_to_the_loop():
    kept: list = []
    await _absorbed(ContinueSignal(), kept, IOResult())
    assert kept == []


@pytest.mark.asyncio
async def test_while_runs_until_its_condition_fails():
    turns = 0

    async def execute(n, *_args):
        nonlocal turns
        if n.text != "cond":
            return result()
        turns += 1
        return result(exit_code=0 if turns <= 10001 else 1)

    sess = SessionState(session_id="test")
    _, io, _ = await handle_while(
        runner(execute, sess), [node("cond")], [node("body")], sess
    )
    assert turns == 10002
    assert await materialize(io.stderr) == b""


@pytest.mark.asyncio
async def test_body_ampersand_without_a_job_table_fails_loud():
    async def execute(n, *_args, **_kw):
        return result()

    sess = SessionState(session_id="test")
    with pytest.raises(RuntimeError, match="job table"):
        await handle_if(
            runner(execute, sess), [([node("c")], [bg("x")])], None, sess
        )

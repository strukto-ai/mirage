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

from mirage.io import IOResult
from mirage.io.types import materialize
from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace
from mirage.workspace.executor.pipes import handle_pipe, handle_subshell
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode


class FakeNode:

    def __init__(self, text: str):
        self.text = text
        self.is_named = True
        self.type = "command"


@pytest.mark.asyncio
async def test_handle_pipe_passes_empty_stdin_when_left_returns_none():
    calls: list[dict] = []

    async def execute_node(nd, _session, stdin, _call_stack=None):
        stdin_was_none = stdin is None
        materialized = await materialize(stdin)
        calls.append({
            "text": nd.text,
            "stdin_was_none": stdin_was_none,
            "stdin_bytes": materialized,
        })
        if nd.text == "left":
            return (None, IOResult(stderr=b"boom", exit_code=1),
                    ExecutionNode(command=nd.text, exit_code=1))
        return (b"right-out", IOResult(exit_code=0),
                ExecutionNode(command=nd.text, exit_code=0))

    await handle_pipe(
        execute_node,
        [FakeNode("left"), FakeNode("right")],
        [False],
        Session(session_id="t"),
        None,
    )
    right = next(c for c in calls if c["text"] == "right")
    assert right["stdin_was_none"] is False
    assert right["stdin_bytes"] == b""


@pytest.mark.asyncio
async def test_handle_pipe_threads_stdout_to_next_stdin():
    seen: list[bytes] = []

    async def execute_node(nd, _session, stdin, _call_stack=None):
        seen.append(await materialize(stdin))
        return (f"{nd.text}-out".encode(), IOResult(exit_code=0),
                ExecutionNode(command=nd.text, exit_code=0))

    await handle_pipe(
        execute_node,
        [FakeNode("a"), FakeNode("b")],
        [False],
        Session(session_id="t"),
        None,
    )
    assert seen[0] == b""
    assert seen[1] == b"a-out"


@pytest.mark.asyncio
async def test_handle_subshell_seeds_last_exit_code_between_children():
    session = Session(session_id="t")
    session.last_exit_code = 0
    seen: list[int] = []

    async def execute_node(nd, sess, _stdin, _call_stack=None):
        seen.append(sess.last_exit_code)
        code = 7 if nd.text == "a" else 0
        return (b"", IOResult(exit_code=code),
                ExecutionNode(command=nd.text, exit_code=code))

    await handle_subshell(
        execute_node,
        [FakeNode("a"), FakeNode("b")],
        session,
        None,
    )
    assert seen == [0, 7]
    assert session.last_exit_code == 0


@pytest.mark.asyncio
async def test_each_segment_sees_the_status_the_pipeline_started_with():
    session = Session(session_id="t")
    session.last_exit_code = 1
    seen: list[int] = []

    async def execute_node(nd, sess, _stdin, _call_stack=None):
        seen.append(sess.last_exit_code)
        # An inner statement of a compound segment lands its own status.
        sess.last_exit_code = 0
        return (b"", IOResult(exit_code=0),
                ExecutionNode(command=nd.text, exit_code=0))

    await handle_pipe(execute_node,
                      [FakeNode("a"), FakeNode("b")], [False], session, None)
    assert seen == [1, 1]


@pytest.mark.asyncio
async def test_a_segment_expands_the_pre_pipeline_status():
    # bash 5.2: each segment is a child of the shell as it stood before
    # the pipeline, so `$?` is the pre-pipeline status even after a
    # sibling segment ran a compound command or a function.
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    try:
        for line in ("false; { true; } | echo $?",
                     "f() { true; }; false; f | echo $?",
                     "false; true | echo $?"):
            io = await ws.execute(line)
            assert (await io.stdout_str(), io.exit_code) == ("1\n", 0), line
        io = await ws.execute("false; { false; } | true; echo $?")
        assert await io.stdout_str() == "0\n"
    finally:
        await ws.close()

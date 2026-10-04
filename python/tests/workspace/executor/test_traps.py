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
from mirage.shell.call_stack import CallStack
from mirage.shell.errors import ExitSignal
from mirage.workspace.executor.traps import (
    clear_exit_trap,
    end_shell,
    finish_shell,
    inherit_exit_trap,
    run_exit_trap,
)
from mirage.workspace.session.session import SessionState
from mirage.workspace.types import ExecutionNode


def make_session(action: str | None = None) -> SessionState:
    session = SessionState(session_id="s1")
    session.exit_trap = action
    return session


class Recorder:
    """An evaluator that records each call and answers with a result."""

    def __init__(self, result: IOResult | Exception) -> None:
        self.result = result
        self.calls: list[tuple[str, dict]] = []

    async def __call__(self, line: str, **kwargs) -> IOResult:
        self.calls.append((line, kwargs))
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


@pytest.mark.asyncio
async def test_nothing_runs_without_an_own_action():
    run = Recorder(IOResult())
    assert await run_exit_trap(run, make_session(), 3) is None
    inherited = make_session("echo x")
    inherit_exit_trap(inherited)
    assert await run_exit_trap(run, inherited, 3) is None
    assert await run_exit_trap(run, make_session(""), 3) is None
    assert run.calls == []


@pytest.mark.asyncio
async def test_action_runs_once_in_the_frames_given():
    run = Recorder(IOResult(stdout=b"bye\n"))
    session = make_session("echo bye")
    frames = CallStack()
    frames.push(["a"], function_name="f")
    cleanup = await run_exit_trap(run, session, 7, b"in", frames)
    assert cleanup is not None
    assert await cleanup.materialize_stdout() == b"bye\n"
    assert cleanup.exit_code == 7
    assert session.last_exit_code == 7
    assert run.calls == [
        (
            "echo bye",
            {"session_id": "s1", "stdin": b"in", "call_stack": frames},
        )
    ]
    assert session.exit_trap is None
    assert await run_exit_trap(run, session, 7) is None


@pytest.mark.asyncio
async def test_exit_in_the_action_sets_the_status():
    run = Recorder(ExitSignal(9, stderr=b"e\n", stdout=b"o\n"))
    cleanup = await run_exit_trap(run, make_session("exit 9"), 7)
    assert cleanup is not None
    assert cleanup.exit_code == 9
    assert await cleanup.materialize_stdout() == b"o\n"
    assert await cleanup.materialize_stderr() == b"e\n"


@pytest.mark.asyncio
async def test_failure_counts_only_under_errexit():
    failing = IOResult(exit_code=1)
    plain = await run_exit_trap(Recorder(failing), make_session("false"), 5)
    assert plain is not None and plain.exit_code == 5
    session = make_session("false")
    session.shell_options["errexit"] = True
    errexit = await run_exit_trap(Recorder(failing), session, 5)
    assert errexit is not None and errexit.exit_code == 1


@pytest.mark.asyncio
async def test_an_exempt_failure_keeps_the_status_under_errexit():
    # `false && x` or `! true` ends the action failing, but `set -e`
    # does not act on it, so it ends no shell.
    session = make_session("false && echo skipped")
    session.shell_options["errexit"] = True
    session.errexit_immune = True
    exempt = await run_exit_trap(Recorder(IOResult(exit_code=1)), session, 7)
    assert exempt is not None and exempt.exit_code == 7


@pytest.mark.asyncio
async def test_an_action_running_does_not_start_again():
    session = make_session("echo again")
    session._trap_status = 2
    assert await run_exit_trap(Recorder(IOResult()), session, 2) is None


def test_child_shells_list_but_new_shells_drop_the_action():
    child = make_session("echo parent")
    inherit_exit_trap(child)
    assert child.exit_trap == "echo parent"
    assert child.exit_trap_inherited is True
    fresh = make_session("echo parent")
    clear_exit_trap(fresh)
    assert fresh.exit_trap is None
    assert fresh.exit_trap_inherited is False


@pytest.mark.asyncio
async def test_finish_shell_appends_cleanup_after_the_line():
    run = Recorder(IOResult(stdout=b"cleanup\n", stderr=b"err\n"))
    io = await finish_shell(
        run,
        make_session("echo cleanup"),
        IOResult(stdout=b"body\n", stderr=b"warn\n", exit_code=4),
    )
    assert await io.materialize_stdout() == b"body\ncleanup\n"
    assert await io.materialize_stderr() == b"warn\nerr\n"
    assert io.exit_code == 4


async def _exits():
    raise ExitSignal(3, stdout=b"body\n")


async def _ends():
    return b"body\n", IOResult(exit_code=2), ExecutionNode(exit_code=2)


@pytest.mark.asyncio
async def test_end_shell_carries_cleanup_on_an_exit():
    run = Recorder(IOResult(stdout=b"cleanup\n"))
    with pytest.raises(ExitSignal) as exc:
        await end_shell(
            run, make_session("echo cleanup"), None, None, _exits()
        )
    assert exc.value.stdout == b"body\ncleanup\n"
    assert exc.value.contained_code == 3


@pytest.mark.asyncio
async def test_end_shell_runs_cleanup_after_a_normal_end():
    run = Recorder(IOResult(stdout=b"cleanup\n"))
    stdout, io, node = await end_shell(
        run, make_session("echo cleanup"), None, None, _ends()
    )
    chunks = [chunk async for chunk in stdout]
    assert b"".join(chunks) == b"body\ncleanup\n"
    assert io.exit_code == 2 and node.exit_code == 2

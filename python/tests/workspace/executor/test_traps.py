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
from mirage.workspace.executor.traps import (
    clear_traps,
    ignored_signals,
    inherit_traps,
    lift_function_traps,
    own_action,
    restore_function_traps,
    run_exit_trap,
    start_job_traps,
)
from mirage.workspace.session.session import SessionState


def make_session(action: str | None = None) -> SessionState:
    session = SessionState(session_id="s1")
    session.exit_trap = action
    return session


class Recorder:
    """An evaluator that records each call and answers with a result."""

    def __init__(self, result: IOResult) -> None:
        self.result = result
        self.calls: list[tuple[str, dict]] = []

    async def __call__(self, line: str, **kwargs) -> IOResult:
        self.calls.append((line, kwargs))
        return self.result


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


@pytest.mark.parametrize(
    "traced, inside, body, after",
    [
        (False, (None, None), (None, None), ("echo e", "echo r")),
        (False, (None, None), ("echo f", ""), ("echo f", "")),
        (True, ("echo e", "echo r"), (None, None), ("echo e", "echo r")),
    ],
)
def test_a_function_lifts_err_and_return_unless_traced(
    traced, inside, body, after
):
    session = make_session()
    session.err_trap, session.return_trap = "echo e", "echo r"
    session.shell_options.update(errtrace=traced, functrace=traced)
    lifted = lift_function_traps(session)
    assert (session.err_trap, session.return_trap) == inside
    if not traced:
        session.err_trap, session.return_trap = body
    restore_function_traps(session, lifted)
    assert (session.err_trap, session.return_trap) == after


@pytest.mark.parametrize(
    "lists, monitor, traps",
    [
        (True, False, {15: "", 2: ""}),
        (False, False, {15: "", 2: "echo i"}),
        (True, True, {15: "", 2: "echo i"}),
    ],
)
def test_a_job_that_runs_commands_lists_its_int_ignore(lists, monitor, traps):
    session = make_session()
    session.signal_traps = {15: "", 2: "echo i"}
    session.shell_options["monitor"] = monitor
    start_job_traps(session, lists)
    assert session.signal_traps == traps
    assert session.job_ignored == frozenset({2} if traps[2] == "" else ())


def test_a_shell_outside_the_jobs_process_drops_its_int_ignore():
    job = make_session()
    start_job_traps(job, True)
    start_job_traps(job, False)
    assert (job.signal_traps, job.job_ignored) == ({}, frozenset())
    child = make_session()
    start_job_traps(child, True)
    inherit_traps(child)
    assert (child.signal_traps, child.job_ignored) == ({}, frozenset())
    shell = make_session()
    start_job_traps(shell, True)
    clear_traps(shell)
    assert (shell.signal_traps, shell.entry_ignored) == ({}, frozenset())


def test_what_a_shell_ignores_passes_on_but_kill_and_stop():
    session = make_session()
    session.signal_traps = {9: "", 15: "", 19: "", 2: "", 10: "echo u"}
    session.job_ignored = frozenset({2})
    assert ignored_signals(session) == frozenset({15})


def test_only_a_shells_own_action_counts_as_its_own():
    session = make_session()
    session.signal_traps = {10: "echo u", 15: ""}
    assert [own_action(session, s) for s in (10, 15, 1)] == [
        True,
        False,
        False,
    ]
    session.signal_traps_inherited = True
    assert not own_action(session, 10)

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
from mirage.shell.console import JobConsole, Terminal
from mirage.shell.errors import ExitSignal
from mirage.workspace.executor.traps import (
    clear_traps,
    ignored_signals,
    inherit_traps,
    lift_function_traps,
    own_action,
    restore_function_traps,
    run_exit_trap,
    run_signal_traps,
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


class Watcher:
    """An evaluator that notes ``$?`` and the sink each line gets, then
    answers with a result or raises it."""

    def __init__(
        self, session: SessionState, answer: IOResult | ExitSignal
    ) -> None:
        self.session = session
        self.answer = answer
        self.seen: list[tuple[str, int, JobConsole | None]] = []

    async def __call__(self, line: str, **kwargs) -> IOResult:
        self.seen.append(
            (line, self.session.last_exit_code, kwargs.get("sink"))
        )
        if isinstance(self.answer, ExitSignal):
            raise self.answer
        return self.answer


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "answer", [IOResult(stdout=b"bye\n"), ExitSignal(3, stdout=b"bye\n")]
)
async def test_a_fatal_signal_runs_the_exit_action_and_keeps_its_status(
    answer,
):
    session = make_session("echo bye")
    session.fatal_signal, session.status_before_signal = 15, 4
    session.last_exit_code = 143
    sink = Terminal()
    run = Watcher(session, answer)
    with pytest.raises(ExitSignal) as raised:
        await run_signal_traps(run, session, None, None, sink)
    assert raised.value.exit_code == 143
    assert raised.value.cleanup == b"bye\n"
    assert run.seen == [("echo bye", 4, sink)]
    assert session.last_exit_code == 143
    assert (session.fatal_signal, session.exit_trap) == (None, None)


@pytest.mark.asyncio
async def test_a_fatal_signal_ends_a_shell_with_no_exit_action():
    session = make_session()
    session.fatal_signal = 2
    run = Watcher(session, IOResult())
    with pytest.raises(ExitSignal) as raised:
        await run_signal_traps(run, session)
    assert (raised.value.exit_code, run.seen) == (130, [])


@pytest.mark.asyncio
async def test_a_queued_action_runs_first_with_the_status_a_fatal_signal_found():
    session = make_session("echo bye")
    session.signal_traps = {10: "echo usr1"}
    session.pending_signals = {10}
    session.fatal_signal, session.status_before_signal = 15, 4
    session.last_exit_code = 143
    run = Watcher(session, IOResult())
    with pytest.raises(ExitSignal) as raised:
        await run_signal_traps(run, session)
    assert raised.value.exit_code == 143
    assert [(line, status) for line, status, _ in run.seen] == [
        ("echo usr1", 4),
        ("echo bye", 4),
    ]


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

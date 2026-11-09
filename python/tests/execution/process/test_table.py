import asyncio
import errno
from collections.abc import Awaitable, Callable
from dataclasses import FrozenInstanceError

import pytest

from mirage.context.session_context import (
    current_process_id,
    run_as_process,
)
from mirage.execution.constants import HISTORY_SECONDS
from mirage.execution.process.config import ProcessPermissions
from mirage.execution.process.constants import FIRST_PID
from mirage.execution.process.handle import ProcessHandle
from mirage.execution.process.table import ProcessTable
from mirage.execution.process.types import ProcessState
from mirage.execution.types import LineId
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_execution_context_isolated_between_concurrent_runners():
    processes = ProcessTable(bind=run_as_process)
    release = asyncio.Event()
    seen = []

    async def run():
        before = current_process_id()
        await release.wait()
        seen.append((before, current_process_id()))
        return 0

    handles = [
        processes.start(
            session_id="same",
            command="probe",
            cwd=PathSpec.from_str_path("/"),
            run=run,
            line=LineId(identity),
        )
        for identity in ("first", "second")
    ]
    await asyncio.sleep(0)
    release.set()
    await asyncio.gather(*(handle.join() for handle in handles))
    ids = sorted(str(handle.record.id) for handle in handles)
    assert sorted((str(a), str(b)) for a, b in seen) == [
        (pid, pid) for pid in ids
    ]
    assert {handle.record.line for handle in handles} == {
        LineId("first"),
        LineId("second"),
    }
    assert current_process_id() is None


@pytest.mark.asyncio
async def test_execution_ancestry_does_not_grant_cancellation_ownership():
    processes = ProcessTable()
    started, release = asyncio.Event(), asyncio.Event()
    children = []

    async def child():
        await release.wait()
        return 0

    async def parent():
        children.append(
            processes.start(
                session_id="a",
                command="detached",
                cwd=PathSpec.from_str_path("/"),
                run=child,
            )
        )
        started.set()
        await asyncio.Event().wait()
        return 0

    root = processes.start(
        session_id="a",
        command="parent",
        cwd=PathSpec.from_str_path("/"),
        run=parent,
        line=LineId("request"),
    )
    await started.wait()
    child_handle = children[0]
    assert child_handle.record.parent is None
    root.terminate()
    await root.join()
    assert child_handle.record.state == ProcessState.RUNNING
    release.set()
    await child_handle.join()


@pytest.mark.asyncio
async def test_cancel_does_not_claim_exit_before_finally_finishes():
    processes = ProcessTable()
    entered, cleaning, release = (
        asyncio.Event(),
        asyncio.Event(),
        asyncio.Event(),
    )

    async def run():
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cleaning.set()
            await release.wait()
        return 0

    process = processes.start(
        session_id="a",
        command="work",
        cwd=PathSpec.from_str_path("/"),
        run=run,
    )
    await entered.wait()
    assert process.terminate()
    assert not process.terminate()
    await cleaning.wait()
    [info] = processes.visible("a", ProcessPermissions())
    assert info.state == ProcessState.STOPPING
    assert info.exit is None
    waiter = asyncio.create_task(process.join())
    await asyncio.sleep(0)
    assert not waiter.done()
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    assert processes.live() == (process,)
    with pytest.raises(BlockingIOError):
        processes.start(
            session_id="a",
            command="replacement",
            cwd=PathSpec.from_str_path("/"),
            run=run,
            limit=1,
        )
    release.set()
    result = await process.join()
    assert result.state == ProcessState.EXITED
    assert (result.exit, result.signal) == (137, 9)
    assert result.pid not in [
        i.pid for i in processes.visible("a", ProcessPermissions())
    ]
    assert not process.terminate()


@pytest.mark.asyncio
async def test_views_are_immutable_scoped_and_revoked_on_session_reuse():
    processes = ProcessTable()
    release = asyncio.Event()

    async def run():
        await release.wait()
        return 7

    a = processes.start(
        session_id="a", command="a", cwd=PathSpec.from_str_path("/"), run=run
    )
    b = processes.start(
        session_id="b", command="b", cwd=PathSpec.from_str_path("/"), run=run
    )
    old_grants = processes.for_session("a")
    assert old_grants.probe(a.record.pid)
    with pytest.raises(FrozenInstanceError):
        a.record.command = "changed"
    processes.revoke_session("a")
    new_grants = processes.for_session("a")
    replacement = processes.start(
        session_id="a", command="new", cwd=PathSpec.from_str_path("/"), run=run
    )
    assert not old_grants.probe(replacement.record.pid)
    assert new_grants.probe(replacement.record.pid)
    assert not new_grants.probe(a.record.pid)
    assert processes.visible("a", ProcessPermissions()) == (
        replacement.record,
    )
    assert len({a.record.pid, b.record.pid, replacement.record.pid}) == 3
    release.set()
    assert [
        info.exit
        for info in await asyncio.gather(
            a.join(), b.join(), replacement.join()
        )
    ] == [7, 7, 7]
    assert processes.live() == ()


@pytest.mark.asyncio
async def test_failed_runner_is_observed_and_retired():
    processes = ProcessTable()

    async def run():
        raise RuntimeError("failed cleanup")

    process = processes.start(
        session_id="a",
        command="work",
        cwd=PathSpec.from_str_path("/"),
        run=run,
    )
    result = await process.join()
    assert result.exit == 1
    assert result.error == "failed cleanup"
    assert processes.live() == ()


@pytest.mark.asyncio
async def test_prestart_cancellation_still_completes_and_retires():
    processes = ProcessTable()

    async def run():
        await asyncio.Event().wait()
        return 0

    process = processes.start(
        session_id="a",
        command="work",
        cwd=PathSpec.from_str_path("/"),
        run=run,
    )
    process.task.cancel()
    assert (await process.join()).exit == 137
    assert processes.live() == ()


@pytest.mark.asyncio
async def test_stop_closes_admission_and_cancels_every_live_runner():
    processes = ProcessTable()

    async def run():
        await asyncio.Event().wait()
        return 0

    a = processes.start(
        session_id="a", command="a", cwd=PathSpec.from_str_path("/"), run=run
    )
    b = processes.start(
        session_id="b", command="b", cwd=PathSpec.from_str_path("/"), run=run
    )
    processes.stop()
    processes.stop()
    with pytest.raises(RuntimeError, match="stopped"):
        processes.start(
            session_id="a",
            command="new",
            cwd=PathSpec.from_str_path("/"),
            run=run,
        )
    assert all(
        result.signal == 9
        for result in await asyncio.gather(a.join(), b.join())
    )
    assert processes.live() == ()


def _join_on_another_loop(process):
    with asyncio.Runner() as runner:
        return runner.run(process.join())


@pytest.mark.asyncio
async def test_join_can_cross_event_loops_without_blocking_the_runner():
    processes = ProcessTable()
    release = asyncio.Event()

    async def run():
        await release.wait()
        return 12

    process = processes.start(
        session_id="a",
        command="work",
        cwd=PathSpec.from_str_path("/"),
        run=run,
    )
    waiter = asyncio.create_task(
        asyncio.to_thread(_join_on_another_loop, process)
    )
    await asyncio.sleep(0)
    release.set()
    assert (await asyncio.wait_for(waiter, 2)).exit == 12


@pytest.mark.asyncio
async def test_workspace_list_does_not_grant_kill():
    processes = ProcessTable()
    release = asyncio.Event()

    async def run():
        await release.wait()
        return 0

    child = processes.start(
        session_id="other",
        command="secret argument",
        cwd=PathSpec.from_str_path("/private"),
        run=run,
    )
    grants = ProcessPermissions(list="workspace")
    scoped = processes.for_session("observer", lambda: grants)
    [info] = processes.visible("observer", grants)
    assert info.pid == child.record.pid and info.command == "secret argument"
    with pytest.raises(PermissionError) as denied:
        scoped.probe(child.record.pid)
    assert denied.value.errno == errno.EPERM
    processes.revoke_session("observer")
    with pytest.raises(PermissionError):
        scoped.check_spawn()
    assert not scoped.probe(child.record.pid)
    release.set()
    await child.join()


@pytest.mark.asyncio
async def test_start_refuses_a_session_at_its_limit():
    processes = ProcessTable()
    release = asyncio.Event()

    async def run():
        await release.wait()
        return 0

    def start(session_id: str) -> ProcessHandle:
        return processes.start(
            session_id=session_id,
            command="work",
            cwd=PathSpec.from_str_path("/"),
            run=run,
            limit=2,
        )

    held = [start("a"), start("a")]
    with pytest.raises(BlockingIOError) as refused:
        start("a")
    assert refused.value.errno == errno.EAGAIN
    held.append(start("b"))
    held[0].terminate()
    with pytest.raises(BlockingIOError):
        start("a")
    await held[0].join()
    held.append(start("a"))
    release.set()
    await asyncio.gather(*(process.join() for process in held))


@pytest.mark.asyncio
async def test_the_ceiling_holds_a_lifted_or_larger_limit():
    processes = ProcessTable()
    processes.ceiling = 1
    release = asyncio.Event()

    async def run():
        await release.wait()
        return 0

    def start(limit: int | None) -> ProcessHandle:
        return processes.start(
            session_id="a",
            command="work",
            cwd=PathSpec.from_str_path("/"),
            run=run,
            limit=limit,
        )

    held = start(None)
    for limit in (None, 128):
        with pytest.raises(BlockingIOError):
            start(limit)
    release.set()
    await held.join()


@pytest.mark.asyncio
async def test_cancel_group_reaches_grandchild_after_intermediate_exit():
    processes = ProcessTable()
    release = asyncio.Event()

    async def run():
        await release.wait()
        return 0

    async def quick():
        return 0

    root = processes.start(
        session_id="a",
        command="root",
        cwd=PathSpec.from_str_path("/"),
        run=run,
    )
    middle = processes.start(
        session_id="a",
        command="middle",
        cwd=PathSpec.from_str_path("/"),
        run=quick,
        parent=root.record.pid,
    )
    leaf = processes.start(
        session_id="a",
        command="leaf",
        cwd=PathSpec.from_str_path("/"),
        run=run,
        parent=middle.record.pid,
    )
    await middle.join()
    assert leaf.record.group == root.record.pid
    root.terminate()
    with pytest.raises(RuntimeError, match="accepting children"):
        processes.start(
            session_id="a",
            command="late",
            cwd=PathSpec.from_str_path("/"),
            run=run,
            parent=root.record.pid,
        )
    await processes.drain()
    assert (await leaf.join()).signal is not None
    assert processes.live() == ()


@pytest.mark.asyncio
async def test_cancel_reaches_a_grandchild_past_an_exited_parent_below_the_leader():
    processes = ProcessTable()
    release = asyncio.Event()

    async def run():
        await release.wait()
        return 0

    async def quick():
        return 0

    def start(runner, parent=None):
        return processes.start(
            session_id="a",
            command="runner",
            cwd=PathSpec.from_str_path("/"),
            run=runner,
            parent=parent,
        )

    root = start(run)
    job = start(run, root.record.pid)
    middle = start(quick, job.record.pid)
    leaf = start(run, middle.record.pid)
    await middle.join()
    job.terminate()
    async with asyncio.timeout(5):
        assert (await leaf.join()).signal is not None
    assert root.record.state == ProcessState.RUNNING
    release.set()
    await root.join()


async def _hangs() -> int:
    await asyncio.Event().wait()
    return 0


async def _exits() -> int:
    return 0


# A runner that already exited has nothing left to cancel, but stopping it
# still stops what it left running (``sh -c 'sleep 100 &'``).
@pytest.mark.asyncio
async def test_stopping_an_exited_runner_stops_what_it_left_running():
    processes = ProcessTable()
    parent = processes.start(
        session_id="a",
        command="sh",
        cwd=PathSpec.from_str_path("/"),
        run=_exits,
    )
    left = processes.start(
        session_id="a",
        command="sleep",
        cwd=PathSpec.from_str_path("/"),
        run=_hangs,
        parent=parent.record.pid,
    )
    await parent.join()
    assert parent.terminate(15) is False
    async with asyncio.timeout(5):
        info = await left.join()
    assert (info.exit, info.signal) == (143, 15)


# A signal the runner's jobs ignore stops the runner alone, under the
# signal, and leaves what it started running.
@pytest.mark.asyncio
async def test_stopping_a_runner_alone_leaves_its_children_running():
    processes = ProcessTable()
    parent = processes.start(
        session_id="a",
        command="sh",
        cwd=PathSpec.from_str_path("/"),
        run=_hangs,
    )
    child = processes.start(
        session_id="a",
        command="sleep",
        cwd=PathSpec.from_str_path("/"),
        run=_hangs,
        parent=parent.record.pid,
    )
    assert parent.terminate(2, children=False)
    async with asyncio.timeout(5):
        assert (await parent.join()).exit == 130
    assert child.record.state == ProcessState.RUNNING
    child.terminate()
    await child.join()


# A signal to a process group reaches every runner in it, as killpg(2)
# does: one that ignores it (a shell) hands it to the program it runs right
# now, which ends with it, and goes on; any other stops with it, a child of
# such a shell too. A runner leading a group of its own is not in it.
@pytest.mark.asyncio
async def test_a_group_signal_ends_an_ignoring_shells_program_and_stops_the_rest():
    processes = ProcessTable()
    parent = processes.start(
        session_id="a",
        command="sh",
        cwd=PathSpec.from_str_path("/"),
        run=_hangs,
    )
    started = asyncio.Event()
    outcome: list[tuple[int | None, int | None]] = []

    async def program() -> int:
        started.set()
        return await _hangs()

    async def shell() -> int:
        outcome.append(await child.program(program))
        return 0

    child = processes.start(
        session_id="a",
        command="sh",
        cwd=PathSpec.from_str_path("/"),
        run=shell,
        parent=parent.record.pid,
        ignores=frozenset({2}),
    )
    other = processes.start(
        session_id="a",
        command="sleep",
        cwd=PathSpec.from_str_path("/"),
        run=_hangs,
        parent=parent.record.pid,
    )
    forked = processes.start(
        session_id="a",
        command="sleep",
        cwd=PathSpec.from_str_path("/"),
        run=_hangs,
        parent=child.record.pid,
    )
    outside = processes.start(
        session_id="a",
        command="timeout",
        cwd=PathSpec.from_str_path("/"),
        run=_hangs,
        parent=parent.record.pid,
        own_group=True,
    )
    async with asyncio.timeout(5):
        await started.wait()
        assert await processes.signal_group(parent.record.group, 2)
        assert (await child.join()).exit == 0
        assert (await other.join()).exit == 130
        assert (await forked.join()).exit == 130
        assert (await parent.join()).exit == 130
    assert outcome == [(None, 2)]
    assert outside.signal is None
    assert not await processes.signal_group(outside.record.pid + 1, 2)
    outside.terminate()
    await outside.join()


# A pid a session's lines take in turn runs each line under it; one a live
# runner holds is not taken twice, and later pids go on past it.
@pytest.mark.asyncio
async def test_a_given_pid_is_taken_while_free():
    processes = ProcessTable()
    first = processes.start(
        session_id="a",
        command="line",
        cwd=PathSpec.from_str_path("/"),
        run=_exits_0,
        pid=FIRST_PID + 6,
    )
    held = processes.start(
        session_id="a",
        command="line",
        cwd=PathSpec.from_str_path("/"),
        run=_hangs,
        pid=FIRST_PID + 6,
    )
    assert (first.record.pid, held.record.pid) == (
        FIRST_PID + 6,
        FIRST_PID + 7,
    )
    await first.join()
    again = processes.start(
        session_id="a",
        command="line",
        cwd=PathSpec.from_str_path("/"),
        run=_exits_0,
        pid=FIRST_PID + 6,
    )
    assert again.record.pid == FIRST_PID + 6
    await again.join()
    assert [p.record.pid for p in processes.live()] == [FIRST_PID + 7]
    held.terminate()
    await held.join()


# A kill reaches the whole group with the signal it named, so a native
# program a child runner started receives that signal too.
@pytest.mark.asyncio
async def test_a_group_stopped_with_a_signal_passes_it_to_every_child():
    processes = ProcessTable()

    async def run():
        await asyncio.Event().wait()
        return 0

    root = processes.start(
        session_id="a",
        command="root",
        cwd=PathSpec.from_str_path("/"),
        run=run,
    )
    child = processes.start(
        session_id="a",
        command="child",
        cwd=PathSpec.from_str_path("/"),
        run=run,
        parent=root.record.pid,
    )
    await asyncio.sleep(0)
    assert root.terminate(15)
    assert ((await root.join()).exit, child.signal) == (143, 15)
    assert (await child.join()).exit == 143


# A caller's setup from the new process (the session's $$) runs before the
# runner does, with the process already live, so a runner that starts at
# once sees both.
@pytest.mark.asyncio
async def test_started_runs_before_the_runner_with_the_process_live():
    processes = ProcessTable()
    order: list[str] = []

    async def run() -> int:
        order.append(f"run {[p.record.pid for p in processes.live()]}")
        return 0

    handle = processes.start(
        session_id="s",
        command="probe",
        cwd=PathSpec.from_str_path("/"),
        run=run,
        started=lambda process: order.append(f"started {process.record.pid}"),
    )
    await handle.join()
    assert order == [f"started {FIRST_PID}", f"run [{FIRST_PID}]"]


async def _exits_0() -> int:
    return 0


# A table that publishes the live runners learns each one that started,
# once it is live, so the next publish lists it.
@pytest.mark.asyncio
async def test_a_started_runner_tells_the_publisher():
    live: list[int] = []
    processes = ProcessTable(
        changed=lambda: live.append(len(processes.live()))
    )
    for _ in range(2):
        handle = processes.start(
            session_id="s",
            command="true",
            cwd=PathSpec.from_str_path("/"),
            run=_exits_0,
        )
        await handle.join()
    assert live == [1, 1]


async def _done() -> int:
    return 3


# The table keeps an ended process's record beside the live ones, until
# it is older than the history keeps.
@pytest.mark.asyncio
async def test_an_ended_process_stays_listed_until_its_history_lapses():
    clock = [100.0]
    processes = ProcessTable(now=lambda: clock[0])
    ended = processes.start(
        session_id="a",
        command="done",
        cwd=PathSpec.from_str_path("/"),
        run=_done,
    )
    await ended.join()
    release = asyncio.Event()

    async def held() -> int:
        await release.wait()
        return 0

    live = processes.start(
        session_id="a",
        command="held",
        cwd=PathSpec.from_str_path("/"),
        run=held,
    )
    try:
        assert [(r.command, r.state, r.exit) for r in processes.records()] == [
            ("done", ProcessState.EXITED, 3),
            ("held", ProcessState.RUNNING, None),
        ]
        clock[0] += HISTORY_SECONDS + 1
        assert [r.command for r in processes.records()] == ["held"]
    finally:
        release.set()
        await live.join()


# A process stays in its ancestor's tree after the process between them has
# ended and its record lapsed, and a process outside it never joins.
@pytest.mark.asyncio
async def test_a_tree_keeps_a_live_grandchild_whose_parent_lapsed():
    clock = [100.0]
    processes = ProcessTable(now=lambda: clock[0])
    release, middle_done = asyncio.Event(), asyncio.Event()

    async def held() -> int:
        await release.wait()
        return 0

    async def middle() -> int:
        await middle_done.wait()
        return 0

    def start(
        command: str, run: Callable[[], Awaitable[int]], parent: int | None
    ) -> ProcessHandle:
        return processes.start(
            session_id="a",
            command=command,
            cwd=PathSpec.from_str_path("/"),
            run=run,
            parent=parent,
        )

    root = start("root", held, None)
    child = start("child", middle, root.record.pid)
    grandchild = start("grandchild", held, child.record.pid)
    other = start("other", held, None)
    try:
        middle_done.set()
        await child.join()
        clock[0] += HISTORY_SECONDS + 1
        assert child.record.pid not in [r.pid for r in processes.records()]
        assert processes.tree(root.record.pid) == {
            root.record.pid,
            grandchild.record.pid,
        }
    finally:
        release.set()
        for handle in (root, grandchild, other):
            await handle.join()


async def _sleeper(processes, group=False):
    gate = asyncio.Event()

    async def run():
        await gate.wait()
        return 0

    return processes.start(
        session_id="a",
        command="work",
        cwd=PathSpec.from_str_path("/"),
        run=run,
        own_group=group,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("group", [False, True])
async def test_signal_holds_what_a_stopped_process_is_sent(group):
    processes = ProcessTable()
    process = await _sleeper(processes, group)
    await asyncio.sleep(0)

    async def send(number):
        if group:
            return await processes.signal_group(process.record.group, number)
        return await processes.signal(process, number)

    assert await send(19)
    assert process.record.shown_state == "T"
    assert await send(15)
    assert process.record.state == ProcessState.RUNNING
    assert await send(18)
    ended = await process.join()
    assert (ended.exit, ended.signal) == (143, 15)


@pytest.mark.asyncio
async def test_signal_kill_ends_a_stopped_process():
    processes = ProcessTable()
    process = await _sleeper(processes)
    await asyncio.sleep(0)
    assert await processes.signal(process, 19)
    assert await processes.signal(process, 9)
    ended = await process.join()
    assert (ended.exit, ended.signal) == (137, 9)
    assert not process.paused


@pytest.mark.asyncio
async def test_signal_a_kept_one_leaves_it_running():
    processes = ProcessTable()
    process = await _sleeper(processes)
    await asyncio.sleep(0)
    for number in (0, 17, 18, 20, 23, 28):
        assert await processes.signal(process, number)
    assert process.record.state == ProcessState.RUNNING
    assert process.record.shown_state is None
    process.terminate()
    await process.join()


@pytest.mark.asyncio
async def test_an_ended_process_lets_go_of_what_it_held():
    processes = ProcessTable()
    process = await _sleeper(processes)
    await asyncio.sleep(0)
    processes.pause(process)
    assert process.paused
    process.terminate(15)
    await process.join()
    assert not process.paused

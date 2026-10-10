import asyncio
import errno
from dataclasses import FrozenInstanceError

import pytest

from mirage.execution.context import current_execution_id
from mirage.process.config import ProcessPermissions
from mirage.process.handle import ProcessHandle
from mirage.process.supervisor import ProcessSupervisor
from mirage.process.types import ProcessState
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_execution_context_isolated_between_concurrent_runners():
    supervisor = ProcessSupervisor()
    release = asyncio.Event()
    seen = []

    async def run():
        before = current_execution_id()
        await release.wait()
        seen.append((before, current_execution_id()))
        return 0

    handles = [
        supervisor.start(
            session_id="same",
            command="probe",
            cwd=PathSpec.from_str_path("/"),
            run=run,
            execution_id=identity,
        )
        for identity in ("first", "second")
    ]
    await asyncio.sleep(0)
    release.set()
    await asyncio.gather(*(handle.join() for handle in handles))
    assert sorted(seen) == [("first", "first"), ("second", "second")]
    assert current_execution_id() is None


@pytest.mark.asyncio
async def test_execution_ancestry_does_not_grant_cancellation_ownership():
    supervisor = ProcessSupervisor()
    started, release = asyncio.Event(), asyncio.Event()
    children = []

    async def child():
        await release.wait()
        return 0

    async def parent():
        children.append(
            supervisor.start(
                session_id="a",
                command="detached",
                cwd=PathSpec.from_str_path("/"),
                run=child,
            )
        )
        started.set()
        await asyncio.Event().wait()
        return 0

    root = supervisor.start(
        session_id="a",
        command="parent",
        cwd=PathSpec.from_str_path("/"),
        run=parent,
        execution_id="request",
    )
    await started.wait()
    child_handle = children[0]
    assert child_handle.info.parent_pid is None
    root.terminate()
    await root.join()
    assert child_handle.info.state == ProcessState.RUNNING
    release.set()
    await child_handle.join()


@pytest.mark.asyncio
async def test_cancel_does_not_claim_exit_before_finally_finishes():
    supervisor = ProcessSupervisor()
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

    process = supervisor.start(
        session_id="a",
        command="work",
        cwd=PathSpec.from_str_path("/"),
        run=run,
    )
    view = supervisor.view("a")
    await entered.wait()
    assert process.terminate()
    assert not process.terminate()
    await cleaning.wait()
    [info] = view.list()
    assert info.state == ProcessState.STOPPING
    assert info.exit_code is None
    waiter = asyncio.create_task(process.join())
    await asyncio.sleep(0)
    assert not waiter.done()
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    assert supervisor.live() == (process,)
    with pytest.raises(BlockingIOError):
        supervisor.start(
            session_id="a",
            command="replacement",
            cwd=PathSpec.from_str_path("/"),
            run=run,
            limit=1,
        )
    release.set()
    result = await process.join()
    assert result.state == ProcessState.EXITED
    assert result.exit_code == 137 and result.cancellation_requested
    assert result.pid not in [i.pid for i in view.list()]
    assert not process.terminate()


@pytest.mark.asyncio
async def test_views_are_immutable_scoped_and_revoked_on_session_reuse():
    supervisor = ProcessSupervisor()
    release = asyncio.Event()

    async def run():
        await release.wait()
        return 7

    a = supervisor.start(
        session_id="a", command="a", cwd=PathSpec.from_str_path("/"), run=run
    )
    b = supervisor.start(
        session_id="b", command="b", cwd=PathSpec.from_str_path("/"), run=run
    )
    old_view = supervisor.view("a")
    assert old_view.list() == (a.info,)
    with pytest.raises(FrozenInstanceError):
        a.info.command = "changed"
    supervisor.revoke_session("a")
    new_view = supervisor.view("a")
    replacement = supervisor.start(
        session_id="a", command="new", cwd=PathSpec.from_str_path("/"), run=run
    )
    assert old_view.list() == ()
    assert new_view.list() == (replacement.info,)
    assert len({a.info.pid, b.info.pid, replacement.info.pid}) == 3
    release.set()
    assert [
        info.exit_code
        for info in await asyncio.gather(
            a.join(), b.join(), replacement.join()
        )
    ] == [7, 7, 7]
    assert supervisor.live() == ()


@pytest.mark.asyncio
async def test_failed_runner_is_observed_and_retired():
    supervisor = ProcessSupervisor()

    async def run():
        raise RuntimeError("failed cleanup")

    process = supervisor.start(
        session_id="a",
        command="work",
        cwd=PathSpec.from_str_path("/"),
        run=run,
    )
    result = await process.join()
    assert result.exit_code == 1
    assert result.failure == "failed cleanup"
    assert supervisor.live() == ()


@pytest.mark.asyncio
async def test_prestart_cancellation_still_completes_and_retires():
    supervisor = ProcessSupervisor()

    async def run():
        await asyncio.Event().wait()
        return 0

    process = supervisor.start(
        session_id="a",
        command="work",
        cwd=PathSpec.from_str_path("/"),
        run=run,
    )
    process.task.cancel()
    assert (await process.join()).exit_code == 137
    assert supervisor.live() == ()


@pytest.mark.asyncio
async def test_stop_closes_admission_and_cancels_every_live_runner():
    supervisor = ProcessSupervisor()

    async def run():
        await asyncio.Event().wait()
        return 0

    a = supervisor.start(
        session_id="a", command="a", cwd=PathSpec.from_str_path("/"), run=run
    )
    b = supervisor.start(
        session_id="b", command="b", cwd=PathSpec.from_str_path("/"), run=run
    )
    supervisor.stop()
    supervisor.stop()
    with pytest.raises(RuntimeError, match="stopped"):
        supervisor.start(
            session_id="a",
            command="new",
            cwd=PathSpec.from_str_path("/"),
            run=run,
        )
    assert all(
        result.cancellation_requested
        for result in await asyncio.gather(a.join(), b.join())
    )
    assert supervisor.live() == ()


def _join_on_another_loop(process):
    with asyncio.Runner() as runner:
        return runner.run(process.join())


@pytest.mark.asyncio
async def test_join_can_cross_event_loops_without_blocking_the_runner():
    supervisor = ProcessSupervisor()
    release = asyncio.Event()

    async def run():
        await release.wait()
        return 12

    process = supervisor.start(
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
    assert (await asyncio.wait_for(waiter, 2)).exit_code == 12


@pytest.mark.asyncio
async def test_workspace_list_does_not_grant_kill():
    supervisor = ProcessSupervisor()
    release = asyncio.Event()

    async def run():
        await release.wait()
        return 0

    child = supervisor.start(
        session_id="other",
        command="secret argument",
        cwd=PathSpec.from_str_path("/private"),
        run=run,
    )
    grants = ProcessPermissions(list="workspace")
    view = supervisor.view("observer", lambda: grants)
    [info] = view.list()
    assert info.pid == child.info.pid and info.command == "secret argument"
    with pytest.raises(PermissionError) as denied:
        view.terminate(child.info.pid)
    assert denied.value.errno == errno.EPERM
    supervisor.revoke_session("observer")
    with pytest.raises(PermissionError):
        view.check_spawn()
    assert view.list() == ()
    release.set()
    await child.join()


@pytest.mark.asyncio
async def test_start_refuses_a_session_at_its_limit():
    supervisor = ProcessSupervisor()
    release = asyncio.Event()

    async def run():
        await release.wait()
        return 0

    def start(session_id: str) -> ProcessHandle:
        return supervisor.start(
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
async def test_cancel_group_reaches_grandchild_after_intermediate_exit():
    supervisor = ProcessSupervisor()
    release = asyncio.Event()

    async def run():
        await release.wait()
        return 0

    async def quick():
        return 0

    root = supervisor.start(
        session_id="a",
        command="root",
        cwd=PathSpec.from_str_path("/"),
        run=run,
    )
    middle = supervisor.start(
        session_id="a",
        command="middle",
        cwd=PathSpec.from_str_path("/"),
        run=quick,
        parent_pid=root.info.pid,
    )
    leaf = supervisor.start(
        session_id="a",
        command="leaf",
        cwd=PathSpec.from_str_path("/"),
        run=run,
        parent_pid=middle.info.pid,
    )
    await middle.join()
    assert leaf.info.group_id == root.info.pid
    root.terminate()
    with pytest.raises(RuntimeError, match="accepting children"):
        supervisor.start(
            session_id="a",
            command="late",
            cwd=PathSpec.from_str_path("/"),
            run=run,
            parent_pid=root.info.pid,
        )
    await supervisor.drain()
    assert (await leaf.join()).cancellation_requested
    assert supervisor.live() == ()

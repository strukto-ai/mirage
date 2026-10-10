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
from functools import partial
from typing import Any

import pytest

from mirage.io import IOResult
from mirage.policy.profile import SessionProfile
from mirage.shell.console import Channel, JobConsole
from mirage.shell.job_table import Job, JobStatus, JobTable
from mirage.types import MountMode, PathSpec
from mirage.utils.abort import MirageAbortError
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.executor.jobs import (
    handle_disown,
    handle_fg,
    handle_jobs,
    handle_kill,
    handle_ps,
    handle_wait,
)
from mirage.workspace.types import ExecutionNode


def _workspace() -> Workspace:
    return Workspace({"/m": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE)


async def _run_bg(cmd: str, job_id: int = 1) -> tuple[bytes, bytes]:
    """Run a backgrounded command and return its finished console.

    Args:
        cmd (str): shell line to execute, ending in ``&``.
        job_id (int): job to wait for.
    """
    ws = _workspace()
    await ws.shell(cmd)
    await ws.job_table.wait(job_id, ws.default_session_id)
    job = ws.job_table.get(job_id, ws.default_session_id)
    assert job is not None
    return (
        await job.console.snapshot(Channel.STDOUT),
        await job.console.snapshot(Channel.STDERR),
    )


# ── streaming: output lands while the job is still running ──────────


def test_loop_body_streams_each_iteration_instead_of_batching():
    """A reader sees earlier iterations before the loop finishes.

    Without the sink the whole construct is materialized and pumped at
    completion, so a mid-run snapshot is empty.
    """

    async def _do():
        ws = _workspace()
        await ws.shell("for i in 1 2 3; do echo $i; sleep 0.25; done &")
        job = ws.job_table.get(1, ws.default_session_id)
        assert job is not None
        await asyncio.sleep(0.35)
        mid = await job.console.snapshot(Channel.STDOUT)
        await ws.job_table.wait(1, ws.default_session_id)
        return mid, await job.console.snapshot(Channel.STDOUT)

    mid, end = asyncio.run(_do())
    assert end == b"1\n2\n3\n"
    assert mid, "loop produced nothing until it finished"
    assert end.startswith(mid) and mid != end


@pytest.mark.parametrize(
    "cmd,expected",
    [
        ("echo one && echo two &", b"one\ntwo\n"),
        ("(echo s1; echo s2) &", b"s1\ns2\n"),
        ("if true; then echo yes; fi &", b"yes\n"),
        (
            "i=0; while [ $i -lt 2 ]; do echo w$i; i=$((i+1)); done &",
            b"w0\nw1\n",
        ),
        ("for i in a b; do echo $i; done &", b"a\nb\n"),
    ],
)
def test_compound_constructs_reach_the_console(cmd, expected):
    """Every sequencing construct feeds the job console.

    Args:
        cmd (str): backgrounded shell line.
        expected (bytes): the console's stdout once the job ends.
    """
    out, _ = asyncio.run(_run_bg(cmd))
    assert out == expected


# ── capture sites: a sink must never leak into a captured value ─────


def test_command_substitution_does_not_leak_into_the_console():
    out, _ = asyncio.run(_run_bg("echo $(echo inner) &"))
    assert out == b"inner\n"


def test_pipe_stages_do_not_leak_into_the_console():
    """Only the last stage's output is the job's output."""
    out, _ = asyncio.run(_run_bg("printf 'a\\nb\\n' | grep b &"))
    assert out == b"b\n"


def test_redirected_output_goes_to_the_file_not_the_console():
    async def _do():
        ws = _workspace()
        await ws.shell("echo hi > /m/f.txt &")
        await ws.job_table.wait(1, ws.default_session_id)
        job = ws.job_table.get(1, ws.default_session_id)
        assert job is not None
        written = await (await ws.shell("cat /m/f.txt")).stdout_str()
        return await job.console.snapshot(Channel.STDOUT), written

    out, written = asyncio.run(_do())
    assert out == b""
    assert written == "hi\n"


# ── job output reaches the session's terminal as it is written ─────


@pytest.mark.asyncio
async def test_job_output_reaches_the_lines_once_and_wait_prints_none():
    """A job writes to the terminal its shell writes to, as bash's does:
    the line running when it wrote shows it, or the next one does, and
    `wait` has nothing left to print."""
    ws = _workspace()
    lines = [
        await ws.shell("echo a &"),
        await ws.shell("echo b &"),
        await ws.shell("wait"),
        await ws.shell("true"),
    ]
    assert "".join([await line.stdout_str() for line in lines]) == "a\nb\n"


@pytest.mark.asyncio
async def test_a_line_shows_its_jobs_in_the_order_they_wrote():
    ws = _workspace()
    result = await ws.shell(
        "(sleep 0.05; echo bg) & for i in 1 2; do echo $i; sleep 0.1; done"
    )
    assert await result.stdout_str() == "1\nbg\n2\n"


@pytest.mark.asyncio
async def test_job_nested_in_a_backgrounded_subshell_writes_through_its_job():
    """A nested job writes where the job that started it writes, its
    stdout, so that job's console and the terminal both show the two in
    the order they were written (bash's ``b`` then ``a``)."""
    ws = _workspace()
    await ws.shell("( (sleep 0.15; echo a) & echo b & wait ) &")
    await ws.job_table.wait(1, ws.default_session_id)
    job = ws.job_table.get(1, ws.default_session_id)
    assert job is not None
    later = await (await ws.shell("true")).stdout_str()
    assert await job.console.snapshot(Channel.STDOUT) == b"b\na\n"
    assert later == "b\na\n"


def _slow_first_writes(ws: Workspace, monkeypatch: pytest.MonkeyPatch) -> None:
    """Make each file's first write take 0.2 s, as a remote mount's can.

    Args:
        ws (Workspace): the workspace whose dispatcher to slow.
        monkeypatch (pytest.MonkeyPatch): patches the dispatcher.
    """
    inner = ws._dispatcher.dispatch
    seen: set[tuple[str, str]] = set()

    async def slow(
        op: str, path: PathSpec, **kwargs: Any
    ) -> tuple[Any, IOResult]:
        if (
            op in ("write", "append", "pwrite")
            and (op, path.virtual) not in seen
        ):
            seen.add((op, path.virtual))
            await asyncio.sleep(0.2)
        return await inner(op, path, **kwargs)

    monkeypatch.setattr(ws._dispatcher, "dispatch", slow)


async def _slowly(line: str, monkeypatch: pytest.MonkeyPatch) -> str:
    """Run a line on a workspace whose first writes are slow.

    Args:
        line (str): the line.
        monkeypatch (pytest.MonkeyPatch): patches the dispatcher.
    """
    ws = _workspace()
    _slow_first_writes(ws, monkeypatch)
    return await (await ws.shell(line)).stdout_str()


def test_a_job_writing_while_its_redirect_opens_the_file_keeps_both(
    monkeypatch: pytest.MonkeyPatch,
):
    line = (
        "{ echo first; (sleep .05; echo second) & } > /m/out; wait; cat /m/out"
    )
    assert asyncio.run(_slowly(line, monkeypatch)) == "first\nsecond\n"


def test_jobs_writing_one_file_at_once_keep_every_line(
    monkeypatch: pytest.MonkeyPatch,
):
    line = (
        "{ echo a; (sleep .3; echo b) & (sleep .3; echo c) & } > /m/out; "
        "wait; sort /m/out"
    )
    assert asyncio.run(_slowly(line, monkeypatch)) == "a\nb\nc\n"


def test_a_job_writes_after_what_its_redirect_held_in_every_file(
    monkeypatch: pytest.MonkeyPatch,
):
    line = (
        "{ echo a; echo b >&2; (sleep .05; echo c >&2) & } > /m/out "
        "2> /m/err; wait; cat /m/err"
    )
    assert asyncio.run(_slowly(line, monkeypatch)) == "b\nc\n"


def _failing_slow_writes(
    ws: Workspace, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Make every write fail after 0.2 s, as a remote mount's can.

    Args:
        ws (Workspace): the workspace whose dispatcher to break.
        monkeypatch (pytest.MonkeyPatch): patches the dispatcher.
    """
    inner = ws._dispatcher.dispatch

    async def failing(
        op: str, path: PathSpec, **kwargs: Any
    ) -> tuple[Any, IOResult]:
        if op in ("write", "append", "pwrite"):
            await asyncio.sleep(0.2)
            raise PermissionError(path.virtual)
        return await inner(op, path, **kwargs)

    monkeypatch.setattr(ws._dispatcher, "dispatch", failing)


class _Stalled(JobConsole):
    """A streaming caller whose writes wait for ``release``."""

    def __init__(self) -> None:
        super().__init__()
        self.entered = asyncio.Event()
        self.release = asyncio.Event()

    async def emit(self, channel: Channel, data: bytes) -> None:
        self.entered.set()
        await self.release.wait()
        await super().emit(channel, data)


@pytest.mark.asyncio
async def test_a_killed_job_ends_while_a_streamed_line_takes_what_waited():
    ws = _workspace()
    sid = ws._session_mgr.default_id
    await ws.shell(
        "(sleep 0.03; echo early; sleep 0.1; echo late; sleep 30) &"
    )
    await asyncio.sleep(0.08)
    reader = _Stalled()
    line = asyncio.create_task(ws.shell("true", sink=reader))
    await reader.entered.wait()
    tty = ws.get_session(sid).tty
    while not any(data == b"late\n" for _, data, _ in tty.chunks):
        await asyncio.sleep(0.01)
    job = ws.job_table.get(1, sid)
    assert job is not None and job.process is not None
    await ws.job_table.kill(1, sid)
    done, _ = await asyncio.wait({job.process.task}, timeout=1)
    assert done == {job.process.task}
    reader.release.set()
    await line


def _hold_second_write(
    ws: Workspace, held: asyncio.Event, monkeypatch: pytest.MonkeyPatch
) -> list[str]:
    """Make the second write to ``/m/out`` wait for ``held``, recording
    every write to it.

    Args:
        ws (Workspace): the workspace whose dispatcher to gate.
        held (asyncio.Event): releases the second write.
        monkeypatch (pytest.MonkeyPatch): patches the dispatcher.
    """
    inner = ws._dispatcher.dispatch
    writes: list[str] = []

    async def gated(
        op: str, path: PathSpec, **kwargs: Any
    ) -> tuple[Any, IOResult]:
        if op in ("write", "append", "pwrite") and path.virtual == "/m/out":
            writes.append(op)
            if len(writes) == 2:
                await held.wait()
        return await inner(op, path, **kwargs)

    monkeypatch.setattr(ws._dispatcher, "dispatch", gated)
    return writes


@pytest.mark.asyncio
async def test_a_job_killed_while_its_write_waits_its_turn_writes_nothing(
    monkeypatch: pytest.MonkeyPatch,
):
    ws = _workspace()
    held = asyncio.Event()
    writes = _hold_second_write(ws, held, monkeypatch)
    sid = ws._session_mgr.default_id
    await ws.shell("{ (sleep 0.05; echo a) & (sleep 0.1; echo b) & } > /m/out")
    await asyncio.sleep(0.3)
    job = ws.job_table.get(2, sid)
    assert job is not None and job.process is not None
    assert len(writes) == 2
    await ws.job_table.kill(2, sid)
    done, _ = await asyncio.wait({job.process.task}, timeout=1)
    assert done == {job.process.task}
    held.set()
    await ws.job_table.wait(1, sid)
    await asyncio.sleep(0.05)
    assert len(writes) == 2
    assert await (await ws.shell("cat /m/out")).stdout_str() == "a\n"


@pytest.mark.asyncio
async def test_a_held_job_write_that_fails_leaves_the_line_running(
    monkeypatch: pytest.MonkeyPatch,
):
    ws = _workspace()
    _failing_slow_writes(ws, monkeypatch)
    result = await ws.shell(
        "{ echo first; (sleep .05; echo job) & } > /m/out; echo next=$?; wait"
    )
    assert await result.stdout_str() == "next=1\n"


@pytest.mark.asyncio
async def test_a_job_writes_the_file_after_its_redirect_is_canceled():
    ws = _workspace()
    cancel = asyncio.Event()
    asyncio.get_running_loop().call_later(0.05, cancel.set)
    with pytest.raises(MirageAbortError):
        await ws.shell(
            "{ { sleep .1; echo late; } & sleep 5; } > /m/out", cancel=cancel
        )
    result = await ws.shell("sleep .3; cat /m/out")
    assert await result.stdout_str() == "late\n"


def test_bare_wait_with_no_jobs_returns_nothing():
    async def _do():
        ws = _workspace()
        result = await ws.shell("wait")
        return await result.stdout_str(), result.exit_code

    out, code = asyncio.run(_do())
    assert out == ""
    assert code == 0


def test_stderr_is_routed_to_its_own_channel():
    out, err = asyncio.run(_run_bg("echo err >&2 &"))
    assert out == b""
    assert err == b"err\n"


# ── the shell builtins over a job table ─────────────────────────────


async def _emit_and_settle(
    job: Job, stdout: bytes = b"", stderr: bytes = b"", exit_code: int = 0
) -> tuple[IOResult, ExecutionNode]:
    """A runner that prints to its console and ends with a status.

    Args:
        job (Job): the job being run.
        stdout (bytes): what the job prints on stdout.
        stderr (bytes): what the job prints on stderr.
        exit_code (int): the job's exit status.
    """
    if stdout:
        await job.console.emit(Channel.STDOUT, stdout)
    if stderr:
        await job.console.emit(Channel.STDERR, stderr)
    return IOResult(exit_code=exit_code), ExecutionNode()


async def _run_forever(job: Job) -> tuple[IOResult, ExecutionNode]:
    """A runner that never finishes on its own.

    Args:
        job (Job): the job being run.
    """
    await asyncio.Event().wait()
    return IOResult(), ExecutionNode()


async def _emit_after(
    job: Job, gate: asyncio.Event
) -> tuple[IOResult, ExecutionNode]:
    """A runner that prints only once the test opens ``gate``, so it is
    still running while ``fg`` picks a job.

    Args:
        job (Job): the job being run.
        gate (asyncio.Event): what the runner waits on before printing.
    """
    await gate.wait()
    return await _emit_and_settle(job, stdout=b"late")


def _submit_settled(
    table: JobTable,
    command: str = "foo",
    stdout: bytes = b"",
    stderr: bytes = b"",
    exit_code: int = 0,
) -> Job:
    return table.submit(
        command=command,
        run=partial(
            _emit_and_settle, stdout=stdout, stderr=stderr, exit_code=exit_code
        ),
        cwd="/",
    )


def _submit_pending(table: JobTable, command: str = "sleep") -> Job:
    return table.submit(command=command, run=_run_forever, cwd="/")


@pytest.mark.asyncio
async def test_wait_without_an_id_waits_for_every_job():
    table = JobTable()
    job = _submit_settled(table)
    _, io, node = await handle_wait(table, ["wait"])
    assert io.exit_code == 0
    assert node.command == "wait"
    # Bare `wait` adopts and reaps, so the table entry is gone but the
    # job object itself has settled.
    assert table.get(job.id) is None
    assert job.status == JobStatus.COMPLETED


@pytest.mark.asyncio
async def test_wait_rejects_a_non_numeric_job_id():
    _, io, _ = await handle_wait(JobTable(), ["wait", "abc"])
    assert io.exit_code == 1
    assert b"not a pid or valid job spec" in io.stderr


@pytest.mark.asyncio
async def test_wait_rejects_an_unknown_job_id():
    _, io, _ = await handle_wait(JobTable(), ["wait", "999"])
    assert io.exit_code == 127
    assert b"not a child of this shell" in io.stderr


@pytest.mark.asyncio
async def test_wait_answers_the_awaited_jobs_status_and_prints_nothing():
    table = JobTable()
    job = _submit_settled(table, stdout=b"out", stderr=b"done", exit_code=3)
    stdout, io, _ = await handle_wait(table, ["wait", str(job.id)])
    assert stdout is None
    assert io.exit_code == 3
    assert io.stderr is None


@pytest.mark.asyncio
async def test_wait_accepts_the_percent_job_id_spelling():
    table = JobTable()
    job = _submit_settled(table)
    _, io, _ = await handle_wait(table, ["wait", f"%{job.id}"])
    assert io.exit_code == 0


_KILL_USAGE = (
    b"kill: usage: kill [-s sigspec | -n signum | -sigspec] pid"
    b" | jobspec ... or kill -l [sigspec]\n"
)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "args,code,stderr",
    [
        ([], 2, _KILL_USAGE),
        (["-9"], 2, _KILL_USAGE),
        (["--"], 2, _KILL_USAGE),
        (["-?"], 2, _KILL_USAGE),
        (["-s"], 1, b"bash: kill: -s: option requires an argument\n"),
        (["-n"], 1, b"bash: kill: -n: option requires an argument\n"),
        (["-FOO"], 1, b"bash: kill: FOO: invalid signal specification\n"),
        (
            ["-s", "FOO", "1"],
            1,
            b"bash: kill: FOO: invalid signal specification\n",
        ),
        (["-65", "1"], 1, b"bash: kill: 65: invalid signal specification\n"),
        (
            ["abc"],
            1,
            b"bash: kill: abc: arguments must be process or job IDs\n",
        ),
        (
            ["0x1"],
            1,
            b"bash: kill: 0x1: arguments must be process or job IDs\n",
        ),
        (
            ["--", "-"],
            1,
            b"bash: kill: -: arguments must be process or job IDs\n",
        ),
        ([""], 1, b"bash: kill: `': not a pid or valid job spec\n"),
        (["999"], 1, b"bash: kill: (999) - No such process\n"),
        (["-0", "999"], 1, b"bash: kill: (999) - No such process\n"),
        (["%3"], 1, b"bash: kill: %3: no such job\n"),
        (["%abc"], 1, b"bash: kill: %abc: no such job\n"),
        (
            ["999", "998"],
            1,
            b"bash: kill: (999) - No such process\n"
            b"bash: kill: (998) - No such process\n",
        ),
    ],
)
async def test_kill_refuses_in_bash_words(args, code, stderr):
    _, io, _ = await handle_kill(JobTable(), ["kill", *args])
    assert (io.exit_code, io.stderr) == (code, stderr)


@pytest.mark.asyncio
async def test_kill_marks_a_known_job_killed():
    table = JobTable()
    job = _submit_pending(table)
    _, io, _ = await handle_kill(table, ["kill", str(job.id)])
    assert io.exit_code == 0
    assert table.get(job.id).status == JobStatus.KILLED


@pytest.mark.asyncio
async def test_jobs_prints_nothing_when_the_table_is_empty():
    out, io, _ = await handle_jobs(JobTable(), ["jobs"])
    assert out == b""
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_jobs_lists_id_status_and_command():
    table = JobTable()
    done = _submit_settled(table, command="foo")
    pending = _submit_pending(table, command="bar")
    await table.wait(done.id)
    out, _, _ = await handle_jobs(table, ["jobs"])
    assert b"[1] completed foo" in out
    assert b"[2] running bar" in out
    await table.kill(pending.id)


@pytest.mark.asyncio
async def test_jobs_reaps_the_completed_entries_it_reported():
    table = JobTable()
    job = _submit_settled(table)
    await table.wait(job.id)
    await handle_jobs(table, ["jobs"])
    assert table.list_jobs() == []


@pytest.mark.asyncio
async def test_ps_lists_only_the_running_jobs():
    table = JobTable()
    job = _submit_pending(table)
    done = _submit_settled(table, command="foo")
    await table.wait(done.id)
    out, _, _ = await handle_ps(table, ["ps"])
    assert out == b"1\tsleep\n"
    await table.kill(job.id)


@pytest.mark.asyncio
async def test_ps_prints_nothing_when_no_job_is_running():
    out, _, _ = await handle_ps(JobTable(), ["ps"])
    assert out == b""


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "true && ps < /m/f | cat",
        "ps | cat 2>/dev/null",
        "true && ps | cat 2>/dev/null",
    ],
)
async def test_ps_lists_the_stages_of_a_pipeline_under_a_redirect(line):
    ws = _workspace()
    try:
        await ws.shell("echo x > /m/f")
        out = (await ws.shell(line)).stdout
        commands = {row.split(b"\t", 1)[1] for row in out.splitlines()}
        assert {b"ps", b"cat"} <= commands
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_fg_without_an_operand_reports_when_there_is_no_job():
    _, io, _ = await handle_fg(JobTable(), ["fg"])
    assert io.exit_code == 1
    assert io.stderr == b"bash: fg: current: no such job\n"


@pytest.mark.asyncio
async def test_fg_without_an_operand_takes_a_job_that_already_finished():
    # A background job can end before `fg` runs; it is still the current
    # job, as `fg %N` would find it.
    table = JobTable()
    job = _submit_settled(table, command="quick", stdout=b"body", exit_code=3)
    await table.wait(job.id)
    stdout, io, _ = await handle_fg(table, ["fg"])
    assert stdout == b"quick\n"
    assert io.exit_code == 3


@pytest.mark.asyncio
async def test_fg_without_an_operand_prefers_a_running_job_to_a_finished_one():
    # bash's current job is the newest one still running; a finished job
    # answers only when nothing runs. The older job holds until fg has
    # picked, which it does before its first await.
    table = JobTable()
    gate = asyncio.Event()
    table.submit("older", partial(_emit_after, gate=gate), cwd="/")
    done = _submit_settled(table, command="newer", stdout=b"early")
    await table.wait(done.id)
    fg = asyncio.create_task(handle_fg(table, ["fg"]))
    await asyncio.sleep(0)
    gate.set()
    stdout, _, _ = await fg
    assert stdout == b"older\n"


@pytest.mark.asyncio
async def test_fg_rejects_an_unknown_job_id_with_the_operand_as_typed():
    _, io, _ = await handle_fg(JobTable(), ["fg", "%9"])
    assert io.exit_code == 1
    assert io.stderr == b"bash: fg: %9: no such job\n"


@pytest.mark.asyncio
async def test_fg_echoes_the_command_line_then_answers_the_jobs_status():
    table = JobTable()
    job = _submit_settled(table, command="slow", stdout=b"body", exit_code=7)
    stdout, io, _ = await handle_fg(table, ["fg", str(job.id)])
    assert stdout == b"slow\n"
    assert io.exit_code == 7


@pytest.mark.asyncio
async def test_fg_writes_the_command_line_before_it_blocks():
    table = JobTable()
    gate = asyncio.Event()
    table.submit("held", partial(_emit_after, gate=gate), cwd="/")
    sink = JobConsole()
    fg = asyncio.create_task(handle_fg(table, ["fg"], sink=sink))
    await asyncio.sleep(0)
    assert await sink.snapshot(Channel.STDOUT) == b"held\n"
    gate.set()
    stdout, _, _ = await fg
    assert stdout is None


@pytest.mark.asyncio
async def test_disown_drops_a_job_from_the_table():
    table = JobTable()

    async def _run(job):
        await asyncio.sleep(0.05)
        return IOResult(), ExecutionNode(command="j", exit_code=0)

    table.submit("sleep", _run, cwd="/")
    _, io, _ = await handle_disown(table, ["disown"])
    assert io.exit_code == 0
    assert table.list_jobs() == []
    await table.kill_all()


@pytest.mark.asyncio
async def test_disown_unknown_job_and_bad_option():
    _, io, _ = await handle_disown(JobTable(), ["disown", "%9"])
    assert io.exit_code == 1
    assert b"no such job" in io.stderr
    _, io, _ = await handle_disown(JobTable(), ["disown", "-x"])
    assert io.exit_code == 2


@pytest.mark.asyncio
async def test_wait_n_returns_first_finisher():
    table = JobTable()

    async def _quick(job):
        return IOResult(exit_code=3), ExecutionNode(command="q", exit_code=3)

    table.submit("q", _quick, cwd="/")
    _, io, _ = await handle_wait(table, ["wait", "-n"])
    assert io.exit_code == 3


@pytest.mark.asyncio
async def test_wait_n_with_no_jobs_is_127():
    _, io, _ = await handle_wait(JobTable(), ["wait", "-n"])
    assert io.exit_code == 127


@pytest.mark.asyncio
async def test_wait_bad_option():
    _, io, _ = await handle_wait(JobTable(), ["wait", "-x"])
    assert io.exit_code == 2
    assert b"invalid option" in io.stderr


@pytest.mark.asyncio
async def test_wait_p_names_the_job_whose_status_is_returned():
    """`wait id1 id2` answers with the last id's status, so `-p` names
    that job however many ids were waited for."""
    ws = Workspace({"data": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell(
        "(exit 3) & (exit 5) & p=$!; wait -p V %1 %2; "
        'echo rc=$?; test "$V" = "$p" && echo pid-match'
    )
    assert (await io.stdout_str()) == "rc=5\npid-match\n"
    await ws.close()


@pytest.mark.asyncio
async def test_wait_p_with_no_operand_leaves_the_variable_unset():
    """The no-operand form waits for everything and reports no one job,
    so bash leaves the variable unset (having cleared it first)."""
    ws = Workspace({"data": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell('(exit 0) & V=stale; wait -p V; echo "V=[${V-UNSET}]"')
    assert (await io.stdout_str()) == "V=[UNSET]\n"
    await ws.close()


# ── `&` inside a compound body launches a job, as it does at top level ──

_BODY_SHAPES = [
    "for i in 1; do false & done",
    "for ((k=0;k<1;k++)); do false & done",
    "n=0; while [ $n -lt 1 ]; do false & n=$((n+1)); done",
    "n=0; until [ $n -ge 1 ]; do false & n=$((n+1)); done",
    "if true; then false & fi",
    "if false; then :; elif true; then false & fi",
    "if false; then :; else false & fi",
    "case x in x) false & ;; esac",
    "{ false & }",
    "f() { false & }; f",
]


@pytest.mark.asyncio
@pytest.mark.parametrize("line", _BODY_SHAPES)
async def test_ampersand_inside_a_body_launches_a_job_with_status_zero(line):
    ws = _workspace()
    res = await ws.shell(f"{line}; echo rc=$?")
    assert res.stdout == b"rc=0\n"
    job = ws.job_table.get(1, ws.default_session_id)
    assert job is not None
    assert job.command == "false"
    await ws.job_table.wait(1, ws.default_session_id)
    assert job.exit_code == 1


@pytest.mark.asyncio
async def test_loop_body_jobs_are_still_running_when_the_loop_ends():
    ws = _workspace()
    res = await ws.shell("for i in 1 2; do sleep 0.3 & done; jobs")
    assert res.stdout == b"[1] running sleep 0.3\n[2] running sleep 0.3\n"
    await ws.shell("wait")
    assert (await ws.shell("jobs")).stdout == b""


@pytest.mark.asyncio
async def test_loop_body_jobs_write_after_the_foreground_line():
    ws = _workspace()
    res = await ws.shell(
        "for i in 1 2; do { sleep 0.05; echo $i; } & done; echo launched; wait"
    )
    assert res.stdout == b"launched\n1\n2\n"


@pytest.mark.asyncio
async def test_bang_names_each_loop_body_job():
    ws = _workspace()
    res = await ws.shell("for i in 1 2; do sleep 0.1 & echo $!; done; wait")
    pids = [int(value) for value in res.stdout.splitlines()]
    assert len(pids) == 2 and 0 < pids[0] < pids[1]


@pytest.mark.asyncio
async def test_errexit_does_not_trip_on_a_body_launch():
    ws = _workspace()
    line = "set -e; for i in 1; do false & done; echo ok; wait"
    res = await ws.shell(line)
    assert res.stdout == b"ok\n"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,expected,code",
    [
        ('if false & then echo yes; else echo no; fi; wait "$!"', "yes\n", 1),
        (
            'if false; then echo no; elif false & then echo yes; fi; wait "$!"',
            "yes\n",
            1,
        ),
        ('while false & do echo yes; break; done; wait "$!"', "yes\n", 1),
        (
            'until false & do echo no; break; done; echo yes; wait "$!"',
            "yes\n",
            1,
        ),
        (
            'f() { { sleep 0.05; printf "%s:%s:%s\\n" "$1" "$#" "$*"; } & }'
            "; f first second; wait",
            "first:2:first second\n",
            0,
        ),
        (
            'f() { { sleep 0.05; printf "%s:%s\\n" "$1" "$#"; } & shift; }'
            "; f first second; wait",
            "first:2\n",
            0,
        ),
        (
            'f() { { shift; sleep 0.05; printf "bg:%s:%s\\n" "$1" "$#"; } &'
            ' sleep 0.1; printf "fg:%s:%s\\n" "$1" "$#"; wait; }'
            "; f first second",
            "bg:second:1\nfg:first:2\n",
            0,
        ),
        ('f() { return 7 & j=$!; wait "$j"; }; f', "", 7),
        ('f() { { sleep 0.05; return 9; } & }; f; wait "$!"', "", 9),
        ('f() { false; return & j=$!; wait "$j"; }; f', "", 1),
    ],
)
async def test_background_condition_and_function_scope(line, expected, code):
    ws = _workspace()
    try:
        result = await ws.shell(line)
        assert await result.stdout_str() == expected
        assert await result.stderr_str() == ""
        assert result.exit_code == code
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_jobs_are_scoped_to_the_session_that_launched_them():
    ws = _workspace()
    ws.create_session("a")
    ws.create_session("b")
    try:
        await ws.shell("sleep 30 &", session_id="a")
        assert (await ws.shell("jobs", session_id="b")).stdout == b""
        assert b"[1]" in (await ws.shell("jobs", session_id="a")).stdout
        io = await ws.shell("wait %1", session_id="b")
        assert io.exit_code == 127
        assert b"no such job" in (io.stderr or b"")
        assert b"sleep 30" not in (await ws.shell("ps", session_id="b")).stdout
        assert (await ws.shell("kill %1", session_id="a")).exit_code == 0
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_each_session_numbers_its_jobs_from_one():
    ws = _workspace()
    ws.create_session("a")
    ws.create_session("b")
    try:
        first_a = await ws.shell("sleep 30 & echo $!", session_id="a")
        first_b = await ws.shell("sleep 30 & echo $!", session_id="b")
        second_a = await ws.shell("sleep 30 & echo $!", session_id="a")
        assert len({first_a.stdout, first_b.stdout, second_a.stdout}) == 3
        assert [j.id for j in ws.job_table.list_jobs("a")] == [1, 2]
        assert [j.id for j in ws.job_table.list_jobs("b")] == [1]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_closing_a_session_purges_its_jobs():
    ws = _workspace()
    ws.create_session("a")
    try:
        await ws.shell("sleep 30 &", session_id="a")
        await ws.shell("sleep 30 &", session_id="a")
        old = ws.job_table.get(2, "a")
        assert old is not None
        await ws.close_session("a")
        assert old.status is JobStatus.KILLED
        assert ws.job_table.list_jobs("a") == []
        # A session reusing the id starts from one and inherits nothing.
        ws.create_session("a")
        assert (await ws.shell("jobs", session_id="a")).stdout == b""
        io = await ws.shell("sleep 30 & echo $!", session_id="a")
        assert int(io.stdout) > old.process.info.pid
        assert ws.job_table.get(1, "a") is not None
        io = await ws.shell("wait %2", session_id="a")
        assert io.exit_code == 127
        assert b"no such job" in (io.stderr or b"")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_closing_the_other_sessions_keeps_the_default_ones_jobs():
    ws = _workspace()
    ws.create_session("a")
    ws.create_session("b")
    try:
        await ws.shell("sleep 30 &")
        await ws.shell("sleep 30 &", session_id="a")
        await ws.shell("sleep 30 &", session_id="b")
        await ws.close_session("a")
        await ws.close_session("b")
        assert ws.job_table.list_jobs("a") == []
        assert ws.job_table.list_jobs("b") == []
        kept = ws.job_table.get(1, ws.default_session_id)
        assert kept is not None and kept.status is JobStatus.RUNNING
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_followed_tail_streams_to_its_job_console_until_killed():
    # `timeout N tail -f` cannot show partial output: the line barrier
    # materializes stdout before `timeout` drains it. A job is the shape
    # that works, and the one an agent reaches for: the console shows
    # each line as the file gains it, and `kill` ends the follow.
    ws = _workspace()
    ws.create_session("writer")
    try:
        await ws.shell("printf 'l1\\n' > /m/log")
        await ws.shell("tail -f -s 0.05 /m/log &")
        await asyncio.sleep(0.15)
        await ws.shell("printf 'l2\\n' >> /m/log", session_id="writer")
        await asyncio.sleep(0.25)
        job = ws.job_table.get(1, ws.default_session_id)
        assert job is not None
        assert job.status is JobStatus.RUNNING
        assert await job.console.snapshot(Channel.STDOUT) == b"l1\nl2\n"
        assert (await ws.shell("kill %1")).exit_code == 0
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_job_evaluating_a_nested_line_survives_the_line_cancel():
    # The launching line returned; its caller then set the event. The
    # job is not the caller's to abort, and neither is a line the job
    # evaluates on its way.
    ws = _workspace()
    cancel = asyncio.Event()
    await ws.shell("{ sleep 0.1; echo $(echo inner); } &", cancel=cancel)
    cancel.set()
    await ws.job_table.wait(1, ws.default_session_id)
    job = ws.job_table.get(1, ws.default_session_id)
    assert job is not None
    assert job.exit_code == 0
    assert (await job.console.snapshot(Channel.STDOUT)) == b"inner\n"


@pytest.mark.asyncio
async def test_ps_and_kill_reach_other_sessions_as_far_as_the_profile_says():
    ws = _workspace()
    ws.create_session("a")
    ws.create_session("b")
    ws.create_session("audit", profile={"processes": {"list": "workspace"}})
    ws.create_session("ops", profile={"processes": "workspace"})
    count = "ps | grep -c 'sleep 30$'"
    stop = "kill $(ps | grep 'sleep 30$' | cut -f1); echo rc=$?"
    try:
        pid = (await ws.shell("sleep 30 & echo $!", session_id="a")).stdout
        assert (await ws.shell(count, session_id="b")).stdout == b"0\n"
        assert (await ws.shell(count, session_id="audit")).stdout == b"1\n"
        io = await ws.shell(stop, session_id="audit")
        assert (await io.stdout_str(), await io.stderr_str()) == (
            "rc=1\n",
            f"bash: kill: ({pid.decode().strip()}) - Operation not permitted\n",
        )
        assert (await ws.shell(stop, session_id="ops")).stdout == b"rc=0\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_session_at_its_process_cap_cannot_fork():
    ws = _workspace()
    ws.create_session("capped", profile={"processes": {"max": 2}})
    refusal = "bash: fork: Resource temporarily unavailable\n"

    async def run(line: str) -> tuple[str, str, int]:
        io = await ws.shell(line, session_id="capped")
        return await io.stdout_str(), await io.stderr_str(), io.exit_code

    try:
        assert await run("(sleep 30 & echo in); echo sub=$?") == (
            "sub=254\n",
            refusal,
            0,
        )
        assert await run("sleep 30 & echo one") == ("one\n", "", 0)
        for line in (
            "(echo sub); echo no",
            "echo x | cat; echo no",
            "sleep 30 & echo no",
        ):
            assert await run(line) == ("", refusal, 254)
        assert await run("echo $?") == ("254\n", "", 0)
        assert await run("kill %1") == ("", "", 0)
        await ws.processes.drain()
        assert await run("(echo sub)") == ("sub\n", "", 0)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_runaway_loop_stops_at_the_process_cap():
    ws = _workspace()
    ws.create_session("capped", profile={"processes": {"max": 3}})
    try:
        io = await asyncio.wait_for(
            ws.shell(
                "n=0; while true; do sleep 30 & n=$((n+1)); done; echo no",
                session_id="capped",
            ),
            10,
        )
        assert io.exit_code == 254
        io = await ws.shell("echo $n; jobs", session_id="capped")
        assert io.stdout == (
            b"2\n[1] running sleep 30\n[2] running sleep 30\n"
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "selector", ["-TERM", "-15", "-s TERM", "-n 15", "-SIGTERM", "-9"]
)
async def test_ps_columns_and_signal_probes_share_managed_processes(selector):
    ws = Workspace({"/": RAMVFS()}, mode="exec")
    try:
        started = await ws.shell("sleep 30 & echo $!")
        pid = int(started.stdout)
        result = await ws.shell(
            f"kill -0 {pid}; echo alive=$?; ps -p{pid} -o pid=,ppid=,comm="
        )
        lines = result.stdout.decode().splitlines()
        assert lines[0] == "alive=0"
        assert lines[1].split()[0] == str(pid)
        assert lines[1].split()[-1] == "sleep"
        assert not result.stderr
        result = await ws.shell(f"ps --pid={pid} --format=pid= -o args=")
        assert result.stdout.decode().split() == [str(pid), "sleep", "30"]
        result = await ws.shell("ps -eo pid,cmd")
        assert result.stdout.decode().splitlines()[0].split() == ["PID", "CMD"]
        assert f"{pid}" in result.stdout.decode()
        assert (await ws.shell(f"kill {selector} {pid}")).exit_code == 0
        await ws.processes.drain()
        result = await ws.shell(f"ps -p {pid} -o pid=; echo absent=$?")
        assert result.stdout == b"absent=1\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_kill_zero_respects_signal_permissions_without_cancelling():
    ws = Workspace({"/": RAMVFS()}, mode="exec")
    ws.create_session("owner")
    ws.create_session("audit", profile={"processes": {"list": "workspace"}})
    try:
        pid = int(
            (await ws.shell("sleep 30 & echo $!", session_id="owner")).stdout
        )
        result = await ws.shell(f"kill -0 {pid}", session_id="audit")
        assert result.exit_code == 1
        assert b"Operation not permitted" in result.stderr
        assert (
            await ws.shell(f"kill -0 {pid}", session_id="owner")
        ).exit_code == 0
        [info] = [i for i in ws.processes.view("owner").list() if i.pid == pid]
        assert info.cancellation_requested is False
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "spelling", ["-kill", "-SIGkill", "-s kill", "-n KILL", "-s 9"]
)
async def test_kill_reads_signal_names_in_any_case(spelling):
    ws = Workspace({"/": RAMVFS()}, mode="exec")
    try:
        pid = int((await ws.shell("sleep 30 & echo $!")).stdout)
        result = await ws.shell(f"kill {spelling} {pid}")
        assert (result.exit_code, result.stderr or b"") == (0, b"")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_kill_succeeds_when_any_operand_was_signalled():
    ws = Workspace({"/": RAMVFS()}, mode="exec")
    try:
        pid = int((await ws.shell("sleep 30 & echo $!")).stdout)
        result = await ws.shell(f"kill 999999 %9 abc {pid}; echo rc=$?")
        assert result.stdout == b"rc=0\n"
        assert result.stderr == (
            b"bash: kill: (999999) - No such process\nbash: kill: %9: no such job\n"
            b"bash: kill: abc: arguments must be process or job IDs\n"
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_ps_lays_columns_out_as_procps_does():
    ws = Workspace({"/": RAMVFS()}, mode="exec")
    try:
        pid = int((await ws.shell("sleep 30 & echo $!")).stdout)
        cases = {
            f"ps -o pid,ppid,cmd -p {pid}": (
                f"    PID    PPID CMD\n{pid:>7}       1 sleep 30\n"
            ),
            f"ps -o cmd,pid -p {pid}": (
                f"CMD{' ' * 25}    PID\nsleep 30{' ' * 20}{pid:>7}\n"
            ),
            f"ps -o comm,args -p {pid}": (
                "COMMAND         COMMAND\nsleep           sleep 30\n"
            ),
            f"ps -o pid,cmd= -p {pid}": f"    PID \n{pid:>7} sleep 30\n",
            f"ps -o pid=,cmd -p {pid}": f"        CMD\n{pid:>7} sleep 30\n",
            f"ps -o pid=X,cmd=Y -p {pid}": f"      X Y\n{pid:>7} sleep 30\n",
            f'ps -o "pid cmd" -p {pid},{pid}': f"    PID CMD\n{pid:>7} sleep 30\n",
            f"ps ax -o pid= -p {pid} | grep -c .": None,
        }
        for line, out in cases.items():
            result = await ws.shell(line)
            if out is not None:
                assert result.stdout.decode() == out, line
            assert (result.exit_code, result.stderr or b"") == (0, b""), line
    finally:
        await ws.close()


# The issue's line: `$$` is the session's first line, which ps lists
# while it runs as the session leader procps marks with `s`; the owner
# is the workspace user and the group the session's profile.
@pytest.mark.asyncio
async def test_ps_lists_the_session_leader_with_its_owner():
    ws = Workspace(
        {"/": RAMVFS()},
        mode="exec",
        agent_id="alice",
        profiles={"admin": SessionProfile()},
        profile="admin",
    )
    try:
        line = "ps -o pid,ppid,pgid,sid,stat,user,uid,group,gid,cmd -p $$"
        result = await ws.shell(line)
        assert result.stdout.decode() == (
            "    PID    PPID    PGID     SID STAT USER       UID GROUP      "
            "GID CMD\n"
            f"      1       0       1       1 Rs   alice    alice admin    "
            f"admin {line}\n"
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_ps_does_not_name_another_sessions_group():
    ws = Workspace(
        {"/": RAMVFS()},
        mode="exec",
        profiles={
            "admin": SessionProfile(processes="workspace"),
            "reader": SessionProfile(),
        },
        profile="admin",
    )
    ws.create_session("r", profile="reader")
    try:
        pid = int(
            (await ws.shell("sleep 30 & echo $!", session_id="r")).stdout
        )
        result = await ws.shell(f"ps -o pid=,group= -p {pid},$$")
        words = result.stdout.decode().split()
        rows = dict(zip(words[::2], words[1::2], strict=True))
        assert (rows.pop(str(pid)), list(rows.values())) == ("-", ["admin"])
    finally:
        await ws.close()


_PS_USAGE = (
    b"\nUsage:\n ps [options]\n\n"
    b" Try 'ps --help <simple|list|output|threads|misc|all>'\n"
    b"  or 'ps --help <s|l|o|t|m|a>'\n for additional help text.\n\n"
    b"For more details see ps(1).\n"
)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "args,message",
    [
        (["-p"], b"list of process IDs must follow -p"),
        (["-p", ""], b"list of process IDs must follow -p"),
        (["--pid"], b"list of process IDs must follow --pid"),
        (["-p", "1,x"], b"process ID list syntax error"),
        (["-p", "0"], b"process ID out of range"),
        (["-p", "-1"], b"process ID out of range"),
        (["-o"], b"format specification must follow -o"),
        (["--format"], b"format specification must follow --format"),
        (["-o", "pid,,cmd"], b"improper format list"),
        (["-o", "foo"], b'unknown user-defined format specifier "foo"'),
        (["-o", "="], b'unknown user-defined format specifier ""'),
        (["-K"], b"unsupported SysV option"),
        (["--bogus"], b"unknown gnu long option"),
        (["bogus"], b"unsupported option (BSD syntax)"),
    ],
)
async def test_ps_refuses_in_procps_words(args, message):
    out, io, _ = await handle_ps(JobTable(), ["ps", *args])
    assert out is None
    assert (io.exit_code, io.stderr) == (
        1,
        b"error: " + message + b"\n" + _PS_USAGE,
    )

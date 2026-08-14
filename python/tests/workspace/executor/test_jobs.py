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

import pytest

from mirage.io import IOResult
from mirage.resource.ram import RAMResource
from mirage.shell.console import Channel
from mirage.shell.job_table import Job, JobStatus, JobTable
from mirage.types import MountMode
from mirage.workspace import Workspace
from mirage.workspace.executor.jobs import (handle_fg, handle_jobs,
                                            handle_kill, handle_ps,
                                            handle_wait)
from mirage.workspace.types import ExecutionNode


def _workspace() -> Workspace:
    return Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                     mode=MountMode.WRITE)


async def _run_bg(cmd: str, job_id: int = 1) -> tuple[bytes, bytes]:
    """Run a backgrounded command and return its finished console.

    Args:
        cmd (str): shell line to execute, ending in ``&``.
        job_id (int): job to wait for.
    """
    ws = _workspace()
    await ws.execute(cmd)
    await ws.job_table.wait(job_id)
    job = ws.job_table.get(job_id)
    assert job is not None
    return (await job.console.snapshot(Channel.STDOUT), await
            job.console.snapshot(Channel.STDERR))


# ── streaming: output lands while the job is still running ──────────


def test_loop_body_streams_each_iteration_instead_of_batching():
    """A reader sees earlier iterations before the loop finishes.

    Without the sink the whole construct is materialized and pumped at
    completion, so a mid-run snapshot is empty.
    """

    async def _do():
        ws = _workspace()
        await ws.execute("for i in 1 2 3; do echo $i; sleep 0.25; done &")
        job = ws.job_table.get(1)
        assert job is not None
        await asyncio.sleep(0.35)
        mid = await job.console.snapshot(Channel.STDOUT)
        await ws.job_table.wait(1)
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
        ("i=0; while [ $i -lt 2 ]; do echo w$i; i=$((i+1)); done &",
         b"w0\nw1\n"),
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
        await ws.execute("echo hi > /m/f.txt &")
        await ws.job_table.wait(1)
        job = ws.job_table.get(1)
        assert job is not None
        written = await (await ws.execute("cat /m/f.txt")).stdout_str()
        return await job.console.snapshot(Channel.STDOUT), written

    out, written = asyncio.run(_do())
    assert out == b""
    assert written == "hi\n"


# ── bare `wait` adopts job output ───────────────────────────────────


def test_bare_wait_adopts_output_from_every_job_in_id_order():
    """`wait` with no operand surfaces what the jobs printed.

    A real shell has nothing to adopt because its jobs share the
    terminal. Mirage jobs print to their console, so bare `wait` has to
    surface it or the output is stranded.
    """

    async def _do():
        ws = _workspace()
        await ws.execute("echo a &")
        await ws.execute("echo b &")
        result = await ws.execute("wait")
        return await result.stdout_str()

    assert asyncio.run(_do()) == "a\nb\n"


def test_job_nested_in_a_backgrounded_subshell_gets_its_own_console():
    """A nested job's output must not land on the enclosing job's console.

    The parity partner of the TypeScript regression, which is where this
    can actually break: ``sub_recurse`` is a ``partial``, so a nested
    ``handle_background`` passing ``sink=<its own console>`` always
    overrides the bound default, while a hand-written closure can drop
    the argument. When it is dropped, both nested jobs write straight to
    the outer console, bare ``wait`` adopts nothing, and the documented
    job-id order becomes completion order (``b\\na\\n``).
    """
    out, _ = asyncio.run(_run_bg("( (sleep 0.15; echo a) & echo b & wait ) &"))
    assert out == b"a\nb\n"


def test_bare_wait_with_no_jobs_returns_nothing():

    async def _do():
        ws = _workspace()
        result = await ws.execute("wait")
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
        job: Job,
        stdout: bytes = b"",
        stderr: bytes = b"",
        exit_code: int = 0) -> tuple[IOResult, ExecutionNode]:
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


def _submit_settled(table: JobTable,
                    command: str = "foo",
                    stdout: bytes = b"",
                    stderr: bytes = b"",
                    exit_code: int = 0) -> Job:
    return table.submit(command=command,
                        run=partial(_emit_and_settle,
                                    stdout=stdout,
                                    stderr=stderr,
                                    exit_code=exit_code),
                        cwd="/")


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
    assert b"invalid job id" in io.stderr


@pytest.mark.asyncio
async def test_wait_rejects_an_unknown_job_id():
    _, io, _ = await handle_wait(JobTable(), ["wait", "999"])
    assert io.exit_code == 1
    assert b"no such job" in io.stderr


@pytest.mark.asyncio
async def test_wait_adopts_the_awaited_jobs_output_and_exit_code():
    table = JobTable()
    job = _submit_settled(table, stdout=b"out", stderr=b"done", exit_code=3)
    stdout, io, _ = await handle_wait(table, ["wait", str(job.id)])
    assert stdout == b"out"
    assert io.exit_code == 3
    assert io.stderr == b"done"


@pytest.mark.asyncio
async def test_wait_accepts_the_percent_job_id_spelling():
    table = JobTable()
    job = _submit_settled(table)
    _, io, _ = await handle_wait(table, ["wait", f"%{job.id}"])
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_kill_rejects_a_missing_operand():
    _, io, _ = await handle_kill(JobTable(), ["kill"])
    assert io.exit_code == 1
    assert b"usage" in io.stderr


@pytest.mark.asyncio
async def test_kill_rejects_a_non_numeric_job_id():
    _, io, _ = await handle_kill(JobTable(), ["kill", "abc"])
    assert io.exit_code == 1
    assert b"invalid job id" in io.stderr


@pytest.mark.asyncio
async def test_kill_rejects_an_unknown_job_id():
    _, io, _ = await handle_kill(JobTable(), ["kill", "999"])
    assert io.exit_code == 1
    assert b"no such job" in io.stderr


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
async def test_fg_without_an_operand_reports_when_there_is_no_job():
    _, io, _ = await handle_fg(JobTable(), ["fg"])
    assert io.exit_code == 1
    assert io.stderr == b"fg: current: no such job\n"


@pytest.mark.asyncio
async def test_fg_rejects_an_unknown_job_id_with_the_operand_as_typed():
    _, io, _ = await handle_fg(JobTable(), ["fg", "%9"])
    assert io.exit_code == 1
    assert io.stderr == b"fg: %9: no such job\n"


@pytest.mark.asyncio
async def test_fg_echoes_the_command_line_then_adopts_the_jobs_result():
    table = JobTable()
    job = _submit_settled(table, command="slow", stdout=b"body", exit_code=7)
    stdout, io, _ = await handle_fg(table, ["fg", str(job.id)])
    assert stdout == b"slow\nbody"
    assert io.exit_code == 7

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
from typing import Any

import pytest

from mirage.bridge.sync import handed
from mirage.execution.errors import WorkspaceHeldError
from mirage.execution.job import JobState
from mirage.execution.line.types import LineState
from mirage.io import IOResult
from mirage.io.async_line_iterator import (
    AsyncLineIterator,
    SharedInput,
    hold_inputs,
)
from mirage.shell.console import Channel, JobConsole
from mirage.types import Limit, MountMode, PathSpec
from mirage.utils.abort import MirageAbortError
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.executor import background
from mirage.workspace.store import RAMWorkspaceStateStore


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


@pytest.mark.asyncio
async def test_loop_body_streams_each_iteration_instead_of_batching():
    """A reader sees earlier iterations before the loop finishes.

    Without the sink the whole construct is materialized and pumped at
    completion, so a mid-run snapshot is empty.
    """
    ws = _workspace()
    try:
        await ws.shell("for i in 1 2 3; do echo $i; sleep 0.25; done &")
        job = ws.job_table.get(1, ws.default_session_id)
        assert job is not None
        await asyncio.sleep(0.35)
        mid = await job.console.snapshot(Channel.STDOUT)
        await ws.job_table.wait(1, ws.default_session_id)
        end = await job.console.snapshot(Channel.STDOUT)
    finally:
        await ws.close()
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


@pytest.mark.asyncio
async def test_redirected_output_goes_to_the_file_not_the_console():
    ws = _workspace()
    try:
        await ws.shell("echo hi > /m/f.txt &")
        await ws.job_table.wait(1, ws.default_session_id)
        job = ws.job_table.get(1, ws.default_session_id)
        assert job is not None
        written = await (await ws.shell("cat /m/f.txt")).stdout_str()
        out = await job.console.snapshot(Channel.STDOUT)
    finally:
        await ws.close()
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
    # Independent jobs may finish in either order; neither output may repeat.
    assert "".join([await line.stdout_str() for line in lines]) in (
        "a\nb\n",
        "b\na\n",
    )


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


# Runners begin in the order they were started: a job begins before the
# subshell or substitution after it in its line, and before the next
# line, so each reads what the job's redirect wrote.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "lines",
    [
        ["echo hi > /m/a & (cat /m/a); wait"],
        ['echo hi > /m/a & echo "$(cat /m/a)"; wait'],
        ["echo hi > /m/a &", "cat /m/a; wait"],
    ],
)
async def test_a_job_begins_before_what_its_line_runs_next(lines):
    ws = _workspace()
    for line in lines:
        result = await ws.shell(line)
    assert (await result.stdout_str(), await result.stderr_str()) == (
        "hi\n",
        "",
    )


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


def test_stderr_is_routed_to_its_own_channel():
    out, err = asyncio.run(_run_bg("echo err >&2 &"))
    assert out == b""
    assert err == b"err\n"


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
    assert res.stdout == (
        b"[1]-  Running                 sleep 0.3 &\n"
        b"[2]+  Running                 sleep 0.3 &\n"
    )
    await ws.shell("wait")
    assert (await ws.shell("jobs")).stdout == b""


@pytest.mark.asyncio
@pytest.mark.parametrize("order", [(1, 2), (2, 1)])
async def test_loop_body_jobs_write_after_the_foreground_line(
    order: tuple[int, int], monkeypatch: pytest.MonkeyPatch
):
    vfs = RAMVFS()
    ws = Workspace({"/m": (vfs, MountMode.WRITE)}, mode=MountMode.WRITE)
    gates = {str(i): asyncio.Event() for i in (1, 2)}
    await ws.shell("touch /m/1 /m/2")

    async def read(
        path: PathSpec, offset: int = 0, size: int | None = None
    ) -> bytes:
        await gates[path.vfs_path].wait()
        return b""

    monkeypatch.setattr(vfs, "read", read)
    try:
        async with asyncio.timeout(5):
            res = await ws.shell(
                "for i in 1 2; do { cat /m/$i; echo $i; } & done; echo launched"
            )
            assert res.stdout == b"launched\n"
            for job_id in order:
                gates[str(job_id)].set()
                await ws.job_table.wait(job_id, ws.default_session_id)
            res = await ws.shell("wait")
            assert res.stdout == "".join(f"{i}\n" for i in order).encode()
    finally:
        for gate in gates.values():
            gate.set()
        await ws.close()


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
        assert old.signal is not None
        assert ws.job_table.list_jobs("a") == []
        # A session reusing the id starts from one and inherits nothing.
        ws.create_session("a")
        assert (await ws.shell("jobs", session_id="a")).stdout == b""
        io = await ws.shell("sleep 30 & echo $!", session_id="a")
        assert int(io.stdout) > old.process.record.pid
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
        assert kept is not None and kept.state is JobState.RUNNING
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
        assert job.state is JobState.RUNNING
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
        await ws.process_table.drain()
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
            b"2\n[1]-  Running                 sleep 30 &\n"
            b"[2]+  Running                 sleep 30 &\n"
        )
    finally:
        await ws.close()


# A job is one program only when bash would run it as the program itself:
# `exec` and `command` run their word in place; a function, `eval`, a
# lookup, an escaped or expanded name, or a word that runs commands of its
# own keeps a shell in between.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,simple",
    [
        ("prog", True),
        ("exec prog", True),
        ("command -p prog", True),
        ("f() { prog; }; f", False),
        ("eval prog", False),
        ("command -v prog", False),
        ("command e\\val prog", False),
        ("prog $(echo 5)", False),
        ("c=prog; $c", False),
        ("{ prog; }", False),
    ],
)
async def test_a_job_is_one_program_only_when_it_runs_one(line, simple):
    ws = _workspace()
    try:
        await ws.shell(f"{line} &")
        job = ws.job_table.get(1, ws.default_session_id)
        assert job is not None
        assert job.simple is simple
    finally:
        await ws.close()


def _sharing(store: RAMWorkspaceStateStore) -> Workspace:
    """A workspace on a state store another workspace shares.

    Args:
        store (RAMWorkspaceStateStore): the shared store.
    """
    return Workspace(
        {"/m": (RAMVFS(), MountMode.WRITE)},
        mode=MountMode.WRITE,
        workspace_id="shared",
        session_id="s",
        store=store,
    )


# One daemon runs a workspace's lines at a time: a line on another daemon's
# workspace is refused, naming the daemon that holds the lease, and listed
# as ended with why after the holder's lines, while that daemon lists,
# kills and waits on the jobs through the store.
@pytest.mark.asyncio
async def test_another_daemon_reaches_a_job_but_runs_no_line():
    store = RAMWorkspaceStateStore()
    a, b = _sharing(store), _sharing(store)
    try:
        assert (await a.shell("sleep 30 &", session_id="s")).exit_code == 0
        with pytest.raises(WorkspaceHeldError) as held:
            await b.shell("jobs", session_id="s")
        assert held.value.holder == a.job_table.daemon
        ran, refused = await b.lines()
        assert ran.command == "sleep 30 &"
        assert (refused.command, refused.state, refused.exit) == (
            "jobs",
            LineState.EXITED,
            None,
        )
        assert (refused.error or "").startswith("WorkspaceHeldError: ")
        await b.job_table.sync("s")
        [seen] = b.job_table.list_jobs("s")
        assert (seen.id, seen.command, seen.state) == (
            1,
            "sleep 30",
            JobState.RUNNING,
        )
        assert await b.job_table.kill(1, "s", 15)
        assert (await b.job_table.wait(1, "s")).exit_code == 143
        job = a.job_table.get(1, "s")
        assert job is not None and job.process is not None
        async with asyncio.timeout(2):
            await job.process.join()
        assert (job.signal, job.exit_code) == (15, 143)
    finally:
        await a.close()
        await b.close()


# Once the daemon holding the lease closes the workspace, another one runs
# its lines, numbering its pids past every pid the first gave out.
@pytest.mark.asyncio
async def test_a_workspace_runs_on_another_daemon_once_its_own_closes():
    store = RAMWorkspaceStateStore()
    a, b = _sharing(store), _sharing(store)
    try:
        first = await a.shell("true & echo $!", session_id="s")
        await a.close()
        second = await b.shell("true & echo $!", session_id="s")
        assert int(second.stdout) > int(first.stdout)
    finally:
        await b.close()


class _Held(JobConsole):
    async def emit(self, channel: Channel, data: bytes) -> None:
        await asyncio.Event().wait()


@pytest.mark.asyncio
async def test_a_stopped_job_past_its_limit_still_ends():
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.WRITE,
        command_limits={"@line": Limit(timeout_seconds=0.2)},
    )
    try:
        await ws.shell("sleep 30 & p=$!; kill -STOP $p")
        async with asyncio.timeout(5):
            await ws.job_table.wait(1, ws.default_session_id)
        job = ws.job_table.get(1, ws.default_session_id)
        assert job.exit_code == 124
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_job_past_its_limit_ends_while_a_reader_holds_its_output(
    monkeypatch,
):
    monkeypatch.setattr(background, "STOP_WAIT_SECONDS", 0.2)
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.WRITE,
        command_limits={"@line": Limit(timeout_seconds=0.2)},
    )
    ws.get_session(ws.default_session_id).tty.jobs = _Held()
    await ws.shell("seq 1 1000000000 &")
    async with asyncio.timeout(5):
        await ws.job_table.wait(1, ws.default_session_id)
    job = ws.job_table.get(1, ws.default_session_id)
    assert job.exit_code == 124
    assert (
        await job.console.snapshot(Channel.STDERR)
    ) == b"line: timed out after 0.2s\n"
    await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "exec 3</m/f; { cat <&3; } & kill %1; wait; exec 3<&-",
        "exec 3</m/f; { cat <&3; } & exec 3<&-; kill %1; wait",
        "exec 3</m/f; { cat <&3 >/dev/null; } & wait; exec 3<&-",
    ],
    ids=["closed-after", "closed-before", "ran"],
)
async def test_a_background_job_lets_go_of_its_readers_once(monkeypatch, line):
    held: list[SharedInput] = []

    def hold(inputs: list[SharedInput]) -> list[SharedInput]:
        sources = hold_inputs(inputs)
        held.extend(sources)
        return sources

    discarded: list[AsyncLineIterator] = []
    discard = AsyncLineIterator.discard

    async def record(self: AsyncLineIterator) -> None:
        discarded.append(self)
        await discard(self)

    monkeypatch.setattr(background, "hold_inputs", hold)
    monkeypatch.setattr(AsyncLineIterator, "discard", record)
    ws = _workspace()
    try:
        await ws.shell("printf 'x\\n' >/m/f")
        await ws.shell(line)
        await handed()
        [source] = held
        # A job killed before its runner started still lets the reader go,
        # whoever closes last; one that ran lets it go once.
        assert source.lines.holders == 0
        assert discarded.count(source.lines) == 1
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_failed_release_still_lets_go_of_the_other_readers(
    monkeypatch,
):
    held: list[SharedInput] = []

    def hold(inputs: list[SharedInput]) -> list[SharedInput]:
        sources = hold_inputs(inputs)
        held.extend(sources)
        return sources

    calls: list[AsyncLineIterator] = []
    unhold = AsyncLineIterator.unhold

    async def fail_first(self: AsyncLineIterator) -> None:
        calls.append(self)
        if len(calls) == 1:
            raise ValueError("unhold failed")
        await unhold(self)

    monkeypatch.setattr(background, "hold_inputs", hold)
    monkeypatch.setattr(AsyncLineIterator, "unhold", fail_first)
    ws = _workspace()
    try:
        await ws.shell("printf 'x\\n' >/m/f")
        await ws.shell(
            "exec 3</m/f 4</m/f; { cat <&3; } & kill %1; wait; exec 3<&- 4<&-"
        )
        await handed()
        failed, *rest = calls
        assert sorted(map(id, calls)) == sorted(id(s.lines) for s in held)
        assert len(held) >= 2
        assert [lines.holders for lines in rest] == [0] * len(rest)
        assert failed.holders == 1
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_background_pipeline_is_its_stages():
    ws = _workspace()
    try:
        said = await ws.shell(
            "sleep 30 | cat & echo $!; echo $$; ps -o pid=,ppid=,cmd=; "
            "jobs -l; jobs -p"
        )
        last, shell, *rest = said.stdout.decode().splitlines()
        first = str(int(last) - 1)
        rows = [line.split(None, 2) for line in rest[:4]]
        assert rows[1:3] == [[first, shell, "sleep 30"], [last, shell, "cat"]]
        assert rest[4:] == [
            f"[1]+ {first} Running                 sleep 30",
            f"     {last}                       | cat &",
            first,
        ]
        said = await ws.shell(f"kill {last}; wait {last}; echo $?; jobs")
        assert said.stdout == b"143\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_wait_of_a_last_stage_answers_for_the_pipeline_under_pipefail():
    ws = _workspace()
    try:
        said = await ws.shell(
            "set -o pipefail; sh -c 'exit 4' | sleep 0.1 & wait $!; echo $?"
        )
        assert said.stdout == b"4\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_second_wait_for_a_pid_answers_its_status():
    ws = _workspace()
    try:
        said = await ws.shell(
            "sh -c 'exit 3' & p=$!; wait $p; echo $?; wait $p; echo $?"
        )
        assert said.stdout == b"3\n3\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_job_specs_name_jobs_as_bash_does():
    ws = _workspace()
    try:
        await ws.shell("sleep 30 & sleep 31 &")
        said = await ws.shell(
            "jobs %%; jobs %+; jobs %; jobs %-; jobs '%sleep 30'; jobs %?31"
        )
        one = "[1]-  Running                 sleep 30 &\n"
        two = "[2]+  Running                 sleep 31 &\n"
        assert said.stdout.decode() == two * 3 + one * 2 + two
        said = await ws.shell("jobs %sleep; echo $?; kill %nope; echo $?")
        assert said.stdout == b"1\n1\n"
        assert said.stderr == (
            b"bash: line 1: jobs: sleep: ambiguous job spec\n"
            b"bash: line 1: jobs: %sleep: no such job\n"
            b"bash: line 1: kill: %nope: no such job\n"
        )
        said = await ws.shell("kill %?31 %-; wait; echo $?; jobs")
        assert said.stdout == b"0\n[2]   Terminated              sleep 31\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_jobs_marks_what_it_lists_and_jobs_n_what_it_has_not():
    ws = _workspace()
    try:
        said = await ws.shell("sleep 30 & true & sleep 0.2; jobs; jobs -n")
        assert said.stdout == (
            b"[1]-  Running                 sleep 30 &\n"
            b"[2]+  Done                    true\n"
        )
    finally:
        await ws.shell("kill %1")
        await ws.close()


@pytest.mark.asyncio
async def test_a_redirected_background_pipeline_is_its_stages():
    ws = _workspace()
    try:
        said = await ws.shell("sleep 30 | cat > /m/out & jobs -l | wc -l")
        assert said.stdout == b"2\n"
    finally:
        await ws.shell("kill %1")
        await ws.close()


@pytest.mark.asyncio
async def test_a_stopped_job_holds_a_term_until_it_goes_on():
    ws = _workspace()
    try:
        said = await ws.shell(
            "sleep 30 & kill -STOP %1; kill %1; ps -o stat= -p $!; jobs; "
            "kill -CONT %1; wait %1; echo $?"
        )
        assert said.stdout == (
            b"T\n[1]+  Running                 sleep 30 &\n143\n"
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_stopped_pipeline_moves_no_bytes():
    ws = _workspace()
    try:
        said = await ws.shell(
            "seq 1 300000 | cat > /m/out & kill -STOP %1; sleep 0.3; jobs; "
            "kill -CONT %1; wait %1; echo $?; wc -l < /m/out"
        )
        assert said.stdout == (
            b"[1]+  Running                 seq 1 300000 | cat > /m/out &\n"
            b"0\n300000\n"
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_ppid_is_the_shell_that_started_this_one():
    ws = _workspace()
    try:
        said = await ws.shell(
            "echo $PPID; (echo $PPID); echo $$; bash -c 'echo $PPID'"
        )
        top, sub, shell, nested = said.stdout.decode().split()
        assert (top, sub, nested) == ("0", "0", shell)
        said = await ws.shell("PPID=5")
        assert said.stderr == b"bash: line 1: PPID: readonly variable\n"
    finally:
        await ws.close()

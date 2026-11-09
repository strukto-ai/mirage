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

import pytest

from mirage.execution.job import JobTable
from mirage.execution.process.config import ProcessPermissions
from mirage.execution.process.types import ProcessState
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.executor.builtins.kill.kill import handle_kill
from tests.fixtures.job_runners import (
    submit_pending,
)


def _workspace() -> Workspace:
    return Workspace({"/m": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE)


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
    job = await submit_pending(table)
    _, io, _ = await handle_kill(table, ["kill", str(job.pid)])
    assert io.exit_code == 0
    assert table.get(job.id).signal is not None


# bash starts a job ignoring INT and QUIT, so kill -INT or -QUIT reaches
# it and the job runs on; TERM still ends it. Pinned on bash 5.2, once
# the job has started (a kill right after `&` races bash's own setup).
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,out",
    [
        ("sleep 0.5 & sleep 0.1; kill -INT $!; wait $!; echo $?", "0\n"),
        ("sleep 0.5 & sleep 0.1; kill -s QUIT %1; wait %1; echo $?", "0\n"),
        (
            "(sleep 0.5; echo x $?) & sleep 0.1; kill -2 $!; wait $!; echo $?",
            "x 0\n0\n",
        ),
        (
            "f() { sleep 0.5; echo f; }; f & sleep 0.1; kill -INT $!; "
            "wait $!; echo $?",
            "f\n0\n",
        ),
        (
            "bash -c 'sleep 0.5; echo y' & sleep 0.1; kill -INT $!; wait; "
            "echo $?",
            "y\n0\n",
        ),
        ("sleep 5 & sleep 0.1; kill -TERM $!; wait $!; echo $?", "143\n"),
    ],
)
async def test_int_and_quit_from_kill_leave_a_job_running(line, out):
    ws = _workspace()
    try:
        io = await ws.shell(line)
        assert (await io.stdout_str(), io.exit_code) == (out, 0)
    finally:
        await ws.close()


# Every line of a session runs under one pid, its $$: a signal to it ends
# the line with 128 plus it, the next line's $?, and leaves its jobs
# running; a QUIT, which every shell ignores, does nothing. A nested shell
# is a process of its own, with a $$ of its own.
@pytest.mark.asyncio
async def test_dollar_dollar_names_the_sessions_shell():
    ws = _workspace()
    try:
        pid = (await (await ws.shell("echo $$")).stdout_str()).strip()
        io = await ws.shell("sleep 0.3 & echo before; kill $$; echo after")
        assert (await io.stdout_str(), io.exit_code) == ("before\n", 143)
        io = await ws.shell(
            "echo $? $$; kill -QUIT $$; echo quit=$?; wait; echo job=$?; "
            "[ \"$(bash -c 'echo $$')\" != $$ ] && echo own; "
            "bash -c 'kill $$; echo no'; echo nested=$?"
        )
        assert await io.stdout_str() == (
            f"143 {pid}\nquit=0\njob=0\nown\nnested=143\n"
        )
    finally:
        await ws.close()


# kill -SIG -- -PGID signals every process of a group, as killpg(2) does:
# the session's shell leads one, which its jobs and nested shells are in. A
# shell hands a QUIT to the program it runs right now; a job ignores an INT
# too, which ends the line's own shell.
@pytest.mark.asyncio
async def test_kill_signals_a_process_group():
    ws = _workspace()
    try:
        io = await ws.shell(
            '{ sleep 1; echo "q $?"; } & sleep 0.1; kill -QUIT -- -$$; '
            "wait $!; echo after=$?; kill -0 -- -$$; echo grp=$?; "
            "bash -c 'kill -0 -- -$$' 2>/dev/null; echo nested=$?; "
            "kill -s TERM -- -999999; echo missing=$?"
        )
        assert await io.stdout_str() == (
            "q 131\nafter=0\ngrp=0\nnested=1\nmissing=1\n"
        )
        assert await io.stderr_str() == (
            "bash: line 1: kill: (-999999) - No such process\n"
        )
        io = await ws.shell(
            '{ sleep 1; echo "a $?" > /m/a; } & sleep 0.1; '
            "kill -INT -- -$$; echo no"
        )
        assert (await io.stdout_str(), io.exit_code) == ("", 130)
        io = await ws.shell("wait; cat /m/a")
        assert await io.stdout_str() == "a 130\n"
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
        [info] = [
            i
            for i in ws.process_table.visible("owner", ProcessPermissions())
            if i.pid == pid
        ]
        assert info.state == ProcessState.RUNNING
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
            b"bash: line 1: "
            b"kill: (999999) - No such process\nbash: line 1: kill: %9: no such job\n"
            b"bash: line 1: kill: abc: arguments must be process or job IDs\n"
        )
    finally:
        await ws.close()


# A pid is a number: kill and ps refuse any other operand in bash's and
# procps's words.
@pytest.mark.asyncio
async def test_kill_and_ps_refuse_a_pid_that_is_no_number():
    ws = Workspace({}, session_id="s")
    try:
        killed = await ws.shell("kill ab12:3 :3", session_id="s")
        assert killed.exit_code == 1
        assert killed.stderr.decode().splitlines() == [
            "bash: line 1: kill: ab12:3: arguments must be process or job IDs",
            "bash: line 1: kill: :3: arguments must be process or job IDs",
        ]
        listed = await ws.shell("ps -p ab12:3", session_id="s")
        assert listed.exit_code == 1
        assert b"process ID list syntax error" in listed.stderr
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_kill_reaches_a_grandchild_past_the_job_between_them():
    ws = _workspace()
    await ws.shell(
        "{ { sleep 30 & } & wait $!; echo > /m/ready; sleep 30; } &"
    )
    async with asyncio.timeout(5):
        while (await ws.shell("test -e /m/ready")).exit_code != 0:
            await asyncio.sleep(0.02)
    await ws.shell("kill %1")
    async with asyncio.timeout(5):
        while ws.process_table.live():
            await asyncio.sleep(0.02)
    await ws.close()

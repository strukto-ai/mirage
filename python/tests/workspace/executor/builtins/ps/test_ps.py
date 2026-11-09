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

from mirage.execution.job import JobTable
from mirage.execution.process.constants import FIRST_PID
from mirage.execution.types import MachineId, MachinePid
from mirage.policy.profile import SessionProfile
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.executor.builtins.ps.ps import handle_ps
from tests.fixtures.job_runners import (
    submit_pending,
    submit_settled,
)

HEADER = f"{'PID':>7} {'MACHINE':<31} CMD"


def _workspace() -> Workspace:
    return Workspace({"/m": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE)


def _row(pid: int, command: str, machine: str = "mirage") -> str:
    return f"{pid:>7} {machine:<31} {command}"


@pytest.mark.asyncio
async def test_ps_lists_only_the_running_jobs():
    table = JobTable()
    job = await submit_pending(table)
    done = await submit_settled(table, command="foo")
    await table.wait(done.id)
    out, _, _ = await handle_ps(table, ["ps"])
    assert out.decode() == f"{HEADER}\n{_row(job.pid, 'sleep')}\n"
    await table.kill(job.id)


@pytest.mark.asyncio
async def test_ps_prints_its_header_alone_when_no_job_is_running():
    out, io, _ = await handle_ps(JobTable(), ["ps"])
    assert (out, io.exit_code) == (f"{HEADER}\n".encode(), 1)


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
        commands = {row[40:] for row in out.splitlines()[1:]}
        assert {b"ps", b"cat"} <= commands
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_ps_and_kill_reach_other_sessions_as_far_as_the_profile_says():
    ws = _workspace()
    ws.create_session("a")
    ws.create_session("b")
    ws.create_session("audit", profile={"processes": {"list": "workspace"}})
    ws.create_session("ops", profile={"processes": "workspace"})
    count = "ps | grep -c 'sleep 30$'"
    stop = "kill $(ps | grep 'sleep 30$' | awk '{print $1}'); echo rc=$?"
    try:
        pid = (await ws.shell("sleep 30 & echo $!", session_id="a")).stdout
        assert (await ws.shell(count, session_id="b")).stdout == b"0\n"
        assert (await ws.shell(count, session_id="audit")).stdout == b"1\n"
        io = await ws.shell(stop, session_id="audit")
        assert (await io.stdout_str(), await io.stderr_str()) == (
            "rc=1\n",
            f"bash: line 1: kill: ({pid.decode().strip()}) - Operation not permitted\n",
        )
        assert (await ws.shell(stop, session_id="ops")).stdout == b"rc=0\n"
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
        await ws.process_table.drain()
        result = await ws.shell(f"ps -p {pid} -o pid=; echo absent=$?")
        assert result.stdout == b"absent=1\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_ps_lays_columns_out_as_procps_does():
    ws = Workspace({"/": RAMVFS()}, mode="exec")
    try:
        pid = int((await ws.shell("sleep 30 & echo $!")).stdout)
        shell = int((await ws.shell("echo $$")).stdout)
        cases = {
            f"ps -o pid,ppid,cmd -p {pid}": (
                f"    PID    PPID CMD\n{pid:>7} {shell:>7} sleep 30\n"
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
        profiles={"admin": SessionProfile()},
        profile="admin",
    )
    try:
        line = "ps -o pid,ppid,pgid,sid,stat,user,uid,group,gid,cmd -p $$"
        result = await ws.shell(line)
        assert result.stdout.decode() == (
            "    PID    PPID    PGID     SID STAT USER       UID GROUP      "
            "GID CMD\n"
            f"{FIRST_PID:>7}       0 {FIRST_PID:>7} {FIRST_PID:>7} Rs   "
            "admin    admin admin    "
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


# ps names the machine a program a runtime runs is on, and its pid there
# once known: a host program's from its start, a machine's from a scan.
@pytest.mark.asyncio
@pytest.mark.parametrize("host", [False, True])
async def test_ps_shows_where_a_program_runs(host):
    ws = Workspace({}, session_id="s")
    try:
        await ws.shell("sleep 30 &", session_id="s")
        job = ws.job_table.get(1, "s")
        assert job is not None and job.process is not None
        job.process.one_command = True
        if host:
            assert job.process.take(None, "local")
            job.process.set_machine_pid(MachinePid(4242, 1.0))
        else:
            assert job.process.take(MachineId("docker", "tools"), "docker")
        machine = str(ws.process_table.machine) if host else "docker:tools"
        own = (await ws.shell("ps", session_id="s")).stdout.decode()
        lines = own.splitlines()
        assert lines[0] == HEADER
        assert _row(4242 if host else job.pid, "sleep 30", machine) in lines
        await ws.shell("kill %1", session_id="s")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_ps_is_a_program_of_its_own_on_a_longer_line():
    ws = _workspace()
    try:
        last = await ws.shell("echo a; ps -o pid=,cmd=")
        shell = (await ws.shell("echo $$")).stdout.decode().strip()
        assert last.stdout.decode().splitlines()[1].split(None, 1) == [
            shell,
            "ps -o pid=,cmd=",
        ]
        first = await ws.shell("ps -o ppid=,stat=,cmd=; echo b")
        rows = [
            row.split(None, 2) for row in first.stdout.decode().splitlines()
        ]
        assert rows[:2] == [
            ["0", "Ss", "ps -o ppid=,stat=,cmd=; echo b"],
            [shell, "R", "ps -o ppid=,stat=,cmd="],
        ]
    finally:
        await ws.close()

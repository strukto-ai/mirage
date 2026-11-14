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
import socket
from dataclasses import replace

import pytest

from mirage import Workspace
from mirage.execution.machine.table import MachineTable
from mirage.execution.machine.types import MachineProcess, MachineState
from mirage.execution.process.table import ProcessTable
from mirage.execution.types import MachineName, MachinePid
from mirage.machine.constants import CHECK_LINE, CHECK_MARK
from mirage.machine.handle import MachineHandle
from mirage.runtime.types import RunResult
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS


def _tag(argv):
    return argv[5].partition("=")[2]


class _Box(MachineHandle):
    provider = "box"

    def __init__(self, name: str, code: int | None, ran: bool = True) -> None:
        super().__init__(name)
        self.code = code
        self.ran = ran
        self.lines: list[str] = []

    async def connect(self) -> None:
        if self.code is None:
            raise ConnectionError("no such box")

    async def _exec_argv(self, argv, stdin, env, cwd, output, errors):
        self.lines.append(argv[-1])
        said = f"{CHECK_MARK}\n".encode() if self.ran else b""
        return RunResult(stdout=said, stderr=None, exit_code=self.code or 0)


@pytest.mark.asyncio
async def test_a_check_tells_how_far_mirage_reaches_each_machine():
    boxes = {
        "a": _Box("a", 0),
        "b": _Box("b", 1),
        "c": _Box("c", None),
        "d": _Box("d", 1, ran=False),
    }
    table = MachineTable(boxes)
    found = await table.check(lambda: 7.0)
    assert [(str(m.name), m.state, m.checked_at) for m in found] == [
        ("box:a", MachineState.MANAGED, 7.0),
        ("box:b", MachineState.REACHABLE, 7.0),
        ("box:c", MachineState.UNREACHABLE, 7.0),
        ("box:d", MachineState.UNREACHABLE, 7.0),
    ]
    assert boxes["a"].lines == [CHECK_LINE]


@pytest.mark.asyncio
async def test_a_check_may_name_one_machine():
    table = MachineTable({"a": _Box("a", 0), "b": _Box("b", 0)})
    assert [str(m.name) for m in await table.check(lambda: 0.0, "box:b")] == [
        "box:b"
    ]
    assert await table.check(lambda: 0.0, "box:z") == []


class _Sleeper(MachineHandle):
    """A box whose runs sleep until a TERM reaches their program, each
    starting a child the scan finds; ``base`` numbers its pids."""

    provider = "box"

    def __init__(self, name: str, base: int = 412) -> None:
        super().__init__(name)
        self.base = base
        self.rows: list[MachineProcess] = []
        self.sent: list[tuple[str | MachinePid, int]] = []
        self.ended = asyncio.Event()
        self.code = 143

    async def connect(self) -> None:
        return None

    async def _exec_argv(self, argv, stdin, env, cwd, output, errors):
        tag = _tag(argv)
        self.rows = [
            MachineProcess(tag, self.base, 1, 100.0, " ".join(argv[7:])),
            MachineProcess(tag, self.base + 1, self.base, 101.0, "train 2"),
        ]
        await self.ended.wait()
        self.rows = []
        return RunResult(stdout=b"", stderr=None, exit_code=self.code)

    async def exec_line(self, line, stdin, env, cwd):
        return RunResult(
            stdout=f"{self.base} 100\n".encode(), stderr=None, exit_code=0
        )

    async def status(self, workspace):
        return [r for r in self.rows if r.tag.startswith(f"{workspace}:")]

    async def signal(self, target, signum):
        self.sent.append((target, signum))
        root = isinstance(target, str) or target.pid == self.base
        if signum == 15 and root:
            self.ended.set()
        return True


async def _started(box: _Sleeper) -> None:
    async with asyncio.timeout(5):
        while not box.rows:
            await asyncio.sleep(0.01)


def _capturing(
    boxes: dict[str, MachineHandle], *captures: str
) -> dict[str, MachineHandle]:
    """``boxes``, each capturing ``captures``, so the first listed takes
    them and a line can name another.

    Args:
        boxes (dict[str, MachineHandle]): the machines, by name.
        captures (str): what each one captures.
    """
    for box in boxes.values():
        box.config = replace(box.config, captures=captures)
    return boxes


def _sleepers(**boxes: MachineHandle) -> Workspace:
    return Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        machines=_capturing(boxes, "train"),
    )


@pytest.mark.asyncio
async def test_a_scan_shows_what_a_program_started_on_its_machine():
    box = _Sleeper("a")
    ws = _sleepers(a=box)
    try:
        pid = int((await ws.shell("train 1 & echo $!")).stdout)
        shell = int((await ws.shell("echo $$")).stdout)
        await _started(box)
        said = await ws.shell("ps f -o pid,ppid,machine,cmd")
        rows = [
            line.split(None, 3) for line in said.stdout.decode().splitlines()
        ]
        assert pid == 412
        assert rows[0] == ["PID", "PPID", "MACHINE", "CMD"]
        assert [row[1:] for row in rows[1:]] == [
            ["0", "mirage", "ps f -o pid,ppid,machine,cmd"],
            [str(shell), "box:a", "\\_ train 1"],
            ["412", "box:a", "\\_ train 2"],
        ]
        assert rows[2][0] == "412" and rows[3][0] == "413"
        program, found = ws.process_table.records()[-2:]
        assert (found.program, found.parent) == (False, program.pid)
        killed = await ws.shell(f"kill -USR1 413; kill -0 {pid}; echo $?")
        assert killed.stdout == b"0\n"
        assert box.sent == [(MachinePid(413, 101.0), 10)]
        assert (await ws.shell(f"kill {pid}; wait {pid}")).exit_code == 143
        assert box.sent[-1] == (MachinePid(412, 100.0), 15)
        await ws.shell("ps")
        assert found.pid not in {p.record.pid for p in ws.process_table.live()}
    finally:
        await ws.close()


class _Unreported(_Sleeper):
    """A box whose runs report no pid (nothing could write there)."""

    async def exec_line(self, line, stdin, env, cwd):
        return RunResult(stdout=b"", stderr=None, exit_code=0)


@pytest.mark.asyncio
async def test_a_signal_reaches_a_program_no_scan_placed_by_its_tag(
    monkeypatch,
):
    monkeypatch.setattr("mirage.machine.handle.RUN_START_WAIT_SECONDS", 0.01)
    box = _Unreported("a")
    ws = _sleepers(a=box)
    try:
        pid = int((await ws.shell("train 1 & echo $!")).stdout)
        await _started(box)
        assert (await ws.shell(f"kill {pid}; wait {pid}")).exit_code == 143
        assert box.sent == [(f"{ws.workspace_id}:{pid}", 15)]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_machine_pid_names_the_process_whose_program_has_it():
    a, b = _Sleeper("a"), _Sleeper("b")
    ws = _sleepers(a=a, b=b)
    try:
        pid = int((await ws.shell("train 1 & echo $!")).stdout)
        await _started(a)
        assert pid == 412
        said = await ws.shell("ps -p 412 -o pid=; kill -0 412; echo $?")
        assert said.stdout.decode().split() == ["412", "0"]
        ws.create_session("other")
        said = await ws.shell("kill -0 412", session_id="other")
        assert said.stderr == b"bash: line 1: kill: (412) - No such process\n"
        said = await ws.shell("kill 999; wait 413")
        assert (await said.stderr_str()).splitlines() == [
            "bash: line 1: kill: (999) - No such process",
            "bash: line 1: wait: pid 413 is not a child of this shell",
        ]
        await ws.shell("train 1 &", machine="b")
        await _started(b)
        said = await ws.shell("kill 412")
        assert said.exit_code == 1
        assert said.stderr == b"bash: line 1: kill: 412: ambiguous job spec\n"
        said = await ws.shell("wait 412")
        assert said.stderr == b"bash: line 1: wait: 412: ambiguous job spec\n"
        assert (await ws.shell("kill -m a 412")).exit_code == 0
        assert a.sent[-1] == (MachinePid(412, 100.0), 15)
        assert (await ws.shell("wait -m box:a 412")).exit_code == 143
        assert b.sent == []
    finally:
        a.ended.set()
        b.ended.set()
        await ws.close()


@pytest.mark.asyncio
async def test_a_group_a_machine_pid_names_stays_on_its_machine():
    a, b = _Sleeper("a"), _Sleeper("b", base=700)
    ws = _sleepers(a=a, b=b)
    try:
        await ws.shell("train 1 &")
        await _started(a)
        await ws.shell("train 1 &", machine="b")
        await _started(b)
        assert (await ws.shell("kill -m a -- -412")).exit_code == 0
        assert a.sent
        assert b.sent == []
        assert (await ws.shell("echo alive")).stdout == b"alive\n"
    finally:
        a.ended.set()
        b.ended.set()
        await ws.close()


@pytest.mark.asyncio
async def test_a_saved_status_stays_with_its_machine():
    a, b = _Sleeper("a"), _Sleeper("b")
    b.code = 7
    ws = _sleepers(a=a, b=b)
    try:
        await ws.shell("train 1 &")
        await _started(a)
        await ws.shell("train 1 &", machine="b")
        await _started(b)
        a.ended.set()
        b.ended.set()
        await ws.shell("wait -m a 412; wait -m b 412")
        said = await ws.shell(
            "wait -m a 412; echo $?; wait -m box:b 412; echo $?; "
            "wait 412; echo $?"
        )
        assert said.stdout == b"143\n7\n127\n"
        assert said.stderr == b"bash: line 1: wait: 412: ambiguous job spec\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_disown_and_tail_take_a_machine_pid():
    box = _Sleeper("a")
    ws = _sleepers(a=box)
    try:
        await ws.shell("echo x > /f")
        await ws.shell("train 1 &")
        await _started(box)
        said = await ws.shell("timeout 0.3 tail -f --pid=412 /f; echo $?")
        assert said.stdout == b"x\n124\n"
        said = await ws.shell("disown 412; echo $?; jobs")
        assert said.stdout == b"0\n"
    finally:
        box.ended.set()
        await ws.close()


@pytest.mark.asyncio
async def test_stop_reaches_a_pipelines_programs_and_not_a_subshells():
    box = _Sleeper("a")
    ws = _sleepers(a=box)
    try:
        await ws.shell("( train 1; true ) &")
        await _started(box)
        await ws.shell("kill -STOP %1; kill -CONT %1")
        assert box.sent == []
        await ws.shell("kill -9 %1; wait; jobs >/dev/null")
        box.sent.clear()
        await ws.shell("train 1 | train 2 &")
        await _started(box)
        await asyncio.sleep(0.05)
        await ws.shell("kill -STOP %1")
        assert [signal for _, signal in box.sent] == [19, 19]
        await ws.shell("kill -CONT %1")
        assert [signal for _, signal in box.sent] == [19, 19, 18, 18]
    finally:
        box.ended.set()
        await ws.close()


@pytest.mark.asyncio
async def test_a_machine_pid_answers_wait_once_its_program_ended():
    box = _Sleeper("a")
    ws = _sleepers(a=box)
    try:
        pid = int((await ws.shell("train 1 & echo $!")).stdout)
        await _started(box)
        await ws.shell("ps")
        box.ended.set()
        async with asyncio.timeout(5):
            while pid in {p.record.shown_pid for p in ws.process_table.live()}:
                await asyncio.sleep(0.01)
        said = await ws.shell("wait 412")
        assert (said.exit_code, said.stderr) == (143, None)
    finally:
        box.ended.set()
        await ws.close()


@pytest.mark.asyncio
async def test_what_a_scan_found_leaves_the_session_room_to_fork():
    box = _Sleeper("a")
    ws = _sleepers(a=box)
    ws.create_session("capped", profile={"processes": {"max": 3}})
    try:
        await ws.shell("train 1 &", session_id="capped")
        await _started(box)
        await ws.shell("ps", session_id="capped")
        held = [
            p.record
            for p in ws.process_table.live()
            if p.record.session_id == "capped"
        ]
        found = [p.machine_pid for p in held if not p.program]
        assert [m.pid for m in found if m is not None] == [413]
        said = await ws.shell("(echo room)", session_id="capped")
        assert (said.stdout, said.exit_code) == (b"room\n", 0)
    finally:
        box.ended.set()
        await ws.close()


class _Leaver(_Sleeper):
    """A box whose runs start a child and exit before any scan."""

    async def _exec_argv(self, argv, stdin, env, cwd, output, errors):
        self.rows = [
            MachineProcess(_tag(argv), self.base + 1, 1, 101.0, "daemon")
        ]
        return RunResult(stdout=b"", stderr=None, exit_code=0)


@pytest.mark.asyncio
async def test_a_scan_finds_what_an_ended_program_left_running():
    box = _Leaver("a")
    ws = _sleepers(a=box)
    try:
        assert (await ws.shell("train 1")).exit_code == 0
        said = await ws.shell("ps -o pid=,args=")
        rows = [line.split() for line in said.stdout.decode().splitlines()]
        assert ["413", "daemon"] in rows
        box.rows = []
        await ws.shell("ps")
        left = [p.record.machine_pid for p in ws.process_table.live()]
        assert all(m is None or m.pid != 413 for m in left)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_session_reusing_a_closed_ones_id_finds_none_of_its_own():
    box = _Leaver("a")
    ws = _sleepers(a=box)
    try:
        old = await ws.session("agent")
        assert (await old.shell("train 1")).exit_code == 0
        await ws.close_session("agent")
        new = await ws.session("agent")
        said = await new.shell("ps -o pid=,args=")
        assert b"daemon" not in said.stdout
        assert (await new.shell("kill 413")).exit_code == 1
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_host_scan_finds_what_an_ended_program_left_running():
    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        machines={"laptop": {"provider": "host"}},
    )
    spawn = (
        "import subprocess as s; "
        "s.Popen(['sleep', '30'], stdin=s.DEVNULL, stdout=s.DEVNULL, "
        "stderr=s.DEVNULL)"
    )
    try:
        assert (await ws.shell(f'python3 -c "{spawn}"')).exit_code == 0
        said = await ws.shell("ps --machine=laptop -o machine=,pid=,args=")
        rows = [line.split() for line in said.stdout.decode().splitlines()]
        held = [row for row in rows if row[2:] == ["sleep", "30"]]
        assert [row[0] for row in held] == ["host:laptop"]
        ran = [
            (str(p.machine), p.machine_instance)
            for p in ws.process_table.records()
            if p.machine_pid is not None
        ]
        assert set(ran) == {("host:laptop", socket.gethostname())}
        assert [str(m.name) for m in await ws.machines()] == [
            f"host:{socket.gethostname()}",
            "host:laptop",
        ]
        assert (await ws.shell(f"kill -9 {held[0][1]}")).exit_code == 0
    finally:
        await ws.close()


# Every host entry is in a search's scope, not only the one that wins a
# command: a program a line ran on the second is found by name.
@pytest.mark.asyncio
async def test_a_search_finds_a_program_on_any_host_entry():
    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        machines={"one": {"provider": "host"}, "two": {"provider": "host"}},
    )
    program = "python3 -c 'import time; time.sleep(30)'"
    try:
        await ws.shell(f"{program} &", machine="two")
        found = (await ws.shell("pgrep -a python3")).stdout.decode()
        assert program in found and found.split()[-1] == "host:two"
        said = await ws.shell("ps --machine=two -o machine=,args=")
        assert said.stdout.decode().split()[0] == "host:two"
        assert (await ws.shell("pkill -x python3")).exit_code == 0
    finally:
        await ws.close()


# A lapsed workspace's program on a host entry is stopped by its pid when
# the host its record names is this one, whatever the entry was called.
@pytest.mark.asyncio
async def test_a_lapsed_host_entrys_program_is_stopped_on_its_host():
    stopped: list[tuple[int, int]] = []

    async def stop_host(target: MachinePid, seen, signum: int) -> bool:
        stopped.append((target.pid, signum))
        return True

    host = MachineName("host", "h")
    table = MachineTable(stop_host=stop_host, host=host)
    processes = ProcessTable("w", host)
    record = {
        "pid": 2,
        "machine": "host:laptop",
        "machine_instance": "h",
        "machine_pid": {"pid": 41, "started": 1.0, "exited": None},
    }
    assert await table.stop(processes, record, 15)
    elsewhere = {**record, "machine_instance": "other"}
    assert not await table.stop(processes, elsewhere, 15)
    assert stopped == [(41, 15)]


@pytest.mark.asyncio
async def test_a_group_signal_reaches_a_shells_program_as_sent():
    box = _Sleeper("a")
    ws = _sleepers(a=box)
    try:
        await ws.shell("( train 1; true ) &")
        await _started(box)
        assert (await ws.shell("kill -QUIT -- -$$")).exit_code == 0
        assert set(box.sent) == {
            (MachinePid(412, 100.0), 3),
            (MachinePid(413, 101.0), 3),
        }
        said = await ws.shell("jobs")
        assert said.stdout == (
            b"[1]+  Running                 ( train 1; true ) &\n"
        )
    finally:
        box.ended.set()
        await ws.close()


@pytest.mark.asyncio
async def test_a_group_signal_reaches_a_parent_before_its_child():
    box = _Sleeper("a")
    ws = _sleepers(a=box)
    try:
        await ws.shell("( train 1; true ) &")
        await _started(box)
        await ws.shell("kill -QUIT -- -$$")
        assert box.sent == [
            (MachinePid(412, 100.0), 3),
            (MachinePid(413, 101.0), 3),
        ]
    finally:
        box.ended.set()
        await ws.close()


@pytest.mark.asyncio
async def test_a_forwarded_group_signal_reaches_a_parent_first():
    box = _Sleeper("a")
    ws = _sleepers(a=box)
    try:
        await ws.shell("train 1 &")
        await _started(box)
        await ws.process_table.scan()
        found = next(
            p for p in ws.process_table.records() if p.machine_pid is not None
        )
        await ws.process_table.signal_group(found.group, 28)
        assert box.sent == [
            (MachinePid(412, 100.0), 28),
            (MachinePid(413, 101.0), 28),
        ]
    finally:
        box.ended.set()
        await ws.close()


@pytest.mark.asyncio
async def test_a_process_a_scan_no_longer_sees_is_gone_from_that_ps():
    box = _Sleeper("a")
    ws = _sleepers(a=box)
    try:
        await ws.shell("train 1 &")
        await _started(box)
        assert b"413" in (await ws.shell("ps -o pid")).stdout
        box.rows = box.rows[:1]
        assert b"413" not in (await ws.shell("ps -o pid")).stdout
    finally:
        box.ended.set()
        await ws.close()


@pytest.mark.asyncio
async def test_a_kept_signal_reaches_a_program_as_sent():
    box = _Sleeper("a")
    ws = _sleepers(a=box)
    try:
        await ws.shell("train 1 &")
        await _started(box)
        assert (await ws.shell("kill -WINCH %1")).exit_code == 0
        assert [signum for _, signum in box.sent] == [28]
        box.sent.clear()
        assert (await ws.shell("kill -WINCH -- -$$")).exit_code == 0
        assert box.sent == [
            (MachinePid(412, 100.0), 28),
            (MachinePid(413, 101.0), 28),
        ]
        said = await ws.shell("jobs")
        assert said.stdout == (b"[1]+  Running                 train 1 &\n")
    finally:
        box.ended.set()
        await ws.close()


class _Unreachable(_Leaver):
    """A leaver whose machine stops answering signals."""

    async def signal(self, target, signum):
        raise ConnectionError("connection lost")


@pytest.mark.asyncio
async def test_an_unanswered_signal_keeps_what_a_scan_found():
    box = _Unreachable("a")
    ws = _sleepers(a=box)
    try:
        assert (await ws.shell("train 1")).exit_code == 0
        assert b"daemon" in (await ws.shell("ps -o args=")).stdout
        assert (await ws.shell("kill -WINCH 413")).exit_code == 1
        assert b"daemon" in (await ws.shell("ps -o args=")).stdout
    finally:
        await ws.close()


class _Quitter(_Sleeper):
    """A box whose program exits on WINCH, its whole run gone before the
    signal's delivery answers."""

    table: ProcessTable | None = None

    async def _exec_argv(self, argv, stdin, env, cwd, output, errors):
        self.rows = [MachineProcess(_tag(argv), self.base, 1, 100.0, "q")]
        await self.ended.wait()
        self.rows = []
        return RunResult(stdout=b"", stderr=None, exit_code=0)

    async def signal(self, target, signum):
        self.sent.append((target, signum))
        self.ended.set()
        assert self.table is not None
        async with asyncio.timeout(5):
            while any(p.record.machine_pid for p in self.table.live()):
                await asyncio.sleep(0.01)
        return True


@pytest.mark.asyncio
async def test_a_kept_signal_to_a_group_that_then_ends_is_sent():
    box = _Quitter("a")
    ws = _sleepers(a=box)
    box.table = ws.process_table
    try:
        await ws.shell("timeout 30 train 1 &")
        await _started(box)
        listed = (await ws.shell("ps -o pgid=,pid=")).stdout.decode()
        group = next(
            row.split()[0]
            for row in listed.splitlines()
            if row.split()[1:] == ["412"]
        )
        said = await ws.shell(f"kill -WINCH -- -{group}")
        assert (said.exit_code, said.stderr) == (0, None)
    finally:
        box.ended.set()
        await ws.close()


class _Gone(_Leaver):
    """A leaver whose machine answers a signal only while a row shows."""

    async def signal(self, target, signum):
        self.sent.append((target, signum))
        return bool(self.rows)


@pytest.mark.asyncio
async def test_a_kept_signal_to_a_group_gone_by_its_scan_fails():
    box = _Gone("a")
    ws = _sleepers(a=box)
    try:
        assert (await ws.shell("train 1")).exit_code == 0
        listed = (await ws.shell("ps -o pgid=,pid=")).stdout.decode()
        group = next(
            row.split()[0]
            for row in listed.splitlines()
            if row.split()[1:] == ["413"]
        )
        box.rows = []
        said = await ws.shell(f"kill -WINCH -- -{group}")
        assert said.exit_code == 1
        assert "No such process" in await said.stderr_str()
    finally:
        await ws.close()


class _Handler(_Sleeper):
    """A box whose program ends on the one signal it handles."""

    def __init__(self, name: str, handles: int) -> None:
        super().__init__(name)
        self.handles = handles

    async def signal(self, target, signum):
        self.sent.append((target, signum))
        if signum == self.handles:
            self.ended.set()
        return True


@pytest.mark.asyncio
async def test_a_foreground_timeout_sends_to_the_program_it_runs():
    box = _Handler("a", 10)
    ws = _sleepers(a=box)
    try:
        said = await ws.shell("timeout --foreground -s USR1 0.1 train 1")
        assert said.exit_code == 124
        assert [signum for _, signum in box.sent] == [10]
    finally:
        box.ended.set()
        await ws.close()


@pytest.mark.asyncio
async def test_a_foreground_timeout_ends_the_shell_it_runs():
    box = _Handler("a", 10)
    ws = _sleepers(a=box)
    try:
        said = await asyncio.wait_for(
            ws.shell(
                "timeout --foreground -s KILL 0.1 "
                "sh -c 'train 1; echo after; sleep 30'"
            ),
            5,
        )
        assert said.exit_code == 137
        assert b"after" not in (said.stdout or b"")
    finally:
        box.ended.set()
        await ws.close()


@pytest.mark.asyncio
async def test_a_foreground_timeout_leaves_a_shell_s_background_program():
    box = _Handler("a", 10)
    ws = _sleepers(a=box)
    try:
        said = await asyncio.wait_for(
            ws.shell(
                "timeout --foreground -s USR1 0.2 sh -c 'train 1 & sleep 30'"
            ),
            5,
        )
        assert said.exit_code == 124
        assert box.sent == []
    finally:
        box.ended.set()
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("how", ["", "--foreground "])
async def test_a_program_that_handles_quit_outlives_a_timeout(how):
    box = _Handler("a", 0)
    ws = _sleepers(a=box)
    try:
        run = asyncio.ensure_future(
            ws.shell(f"timeout {how}-s QUIT 0.1 train 1")
        )
        await asyncio.sleep(0.4)
        assert not run.done()
        assert {signum for _, signum in box.sent} == (
            {3, 18} if how == "" else {3}
        )
        box.ended.set()
        assert (await run).exit_code == 124
    finally:
        box.ended.set()
        await ws.close()


@pytest.mark.asyncio
async def test_a_timeout_keeps_the_status_of_a_program_that_handled_it():
    box = _Handler("a", 10)
    ws = _sleepers(a=box)
    try:
        said = await ws.shell("timeout -p --foreground -s USR1 0.1 train 1")
        assert said.exit_code == 143
    finally:
        box.ended.set()
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("how", ["", "--foreground "])
async def test_a_timeout_forwards_a_kept_signal_to_the_program(how):
    box = _Handler("a", 28)
    ws = _sleepers(a=box)
    try:
        said = await ws.shell(f"timeout {how}-s WINCH 0.1 train 1")
        assert said.exit_code == 124
        assert {signum for _, signum in box.sent} == (
            {28, 18} if how == "" else {28}
        )
    finally:
        box.ended.set()
        await ws.close()


class _Dropping(_Leaver):
    """A leaver whose first scan loses the connection."""

    dropped = False

    async def status(self, workspace):
        if not self.dropped:
            self.dropped = True
            raise ConnectionError("connection lost")
        return await super().status(workspace)


@pytest.mark.asyncio
async def test_a_failed_scan_tries_an_ended_run_again():
    box = _Dropping("a")
    ws = _sleepers(a=box)
    try:
        assert (await ws.shell("train 1")).exit_code == 0
        assert b"daemon" not in (await ws.shell("ps -o args=")).stdout
        assert b"daemon" in (await ws.shell("ps -o args=")).stdout
    finally:
        await ws.close()


class _Shared(_Sleeper):
    """A box that shares one container with every other ``_Shared``."""

    rows_of: "dict[str, list[MachineProcess]]" = {}

    async def _exec_argv(self, argv, stdin, env, cwd, output, errors):
        tag = _tag(argv)
        self.rows_of[self.name] = [
            MachineProcess(tag, self.base, 1, 100.0, " ".join(argv[7:])),
            MachineProcess(tag, self.base + 1, self.base, 101.0, "child"),
        ]
        await self.ended.wait()
        self.rows_of.pop(self.name, None)
        return RunResult(stdout=b"", stderr=None, exit_code=143)

    async def status(self, workspace):
        return [
            r
            for rows in self.rows_of.values()
            for r in rows
            if r.tag.startswith(f"{workspace}:")
        ]


@pytest.mark.asyncio
async def test_two_entries_on_one_container_list_each_process_once():
    a, b = _Shared("a"), _Shared("b", 512)
    ws = _sleepers(a=a, b=b)
    try:
        await ws.shell("train 1 &")
        await ws.shell("train 2 &", machine="b")
        async with asyncio.timeout(5):
            while len(_Shared.rows_of) < 2:
                await asyncio.sleep(0.01)
        said = await ws.shell("ps -o machine=,pid=,args=")
        rows = [line.split()[:2] for line in said.stdout.decode().splitlines()]
        found = [row for row in rows if row[0] != "mirage"]
        assert sorted(found) == [
            ["box:a", "412"],
            ["box:a", "413"],
            ["box:b", "512"],
            ["box:b", "513"],
        ]
    finally:
        a.ended.set()
        b.ended.set()
        await ws.close()
        _Shared.rows_of.clear()


@pytest.mark.asyncio
async def test_a_handle_belongs_to_one_workspace_at_a_time():
    box = _Box("a", 0)

    def workspace() -> Workspace:
        return Workspace(
            {"/": RAMVFS()}, mode=MountMode.EXEC, machines={"a": box}
        )

    first = workspace()
    with pytest.raises(ValueError, match="already in another workspace"):
        workspace()
    await first.close()
    await workspace().close()


@pytest.mark.asyncio
async def test_a_workspace_that_fails_to_build_holds_no_machine():
    box = _Box("a", 0)
    with pytest.raises(ValueError, match="nope"):
        Workspace(
            {"/": RAMVFS()},
            mode=MountMode.EXEC,
            machines={"a": box, "b": {"provider": "nope"}},
        )
    await Workspace(
        {"/": RAMVFS()}, mode=MountMode.EXEC, machines={"a": box}
    ).close()


class _Napper(_Box):
    """A box that can pause, recording its close and pause in ``log``;
    ``refused`` is why another table could not take it while it paused,
    or None if it could."""

    def __init__(
        self,
        name: str,
        log: list[str],
        fail_close: bool = False,
        fail_pause: bool = False,
        gate: asyncio.Event | None = None,
    ) -> None:
        super().__init__(name, 0)
        self.log = log
        self.fail_close = fail_close
        self.fail_pause = fail_pause
        self.gate = gate
        self.refused: str | None = None

    async def close(self) -> None:
        await super().close()
        self.log.append(f"close {self.name}")
        if self.fail_close:
            raise RuntimeError(f"close {self.name} failed")

    async def pause(self) -> None:
        self.log.append(f"pause {self.name}")
        try:
            MachineTable({self.name: self})
        except ValueError as exc:
            self.refused = str(exc)
        if self.gate is not None:
            await self.gate.wait()
            self.log.append(f"paused {self.name}")
        if self.fail_pause:
            raise RuntimeError(f"pause {self.name} failed")


_BOTH = frozenset({"a", "b"})


@pytest.mark.asyncio
async def test_a_pausing_close_closes_every_handle_then_pauses_each_it_held():
    log: list[str] = []
    table = MachineTable({"a": _Napper("a", log), "b": _Box("b", 0)})
    table.hold_handles()
    await table.close(pause=_BOTH)
    assert log == ["close a", "pause a"]


@pytest.mark.asyncio
async def test_a_pausing_close_pauses_only_the_held_handles_it_names():
    log: list[str] = []
    table = MachineTable({"a": _Napper("a", log), "b": _Napper("b", log)})
    table.hold_handles()
    await table.close(pause=frozenset({"b"}))
    assert log == ["close a", "close b", "pause b"]


@pytest.mark.asyncio
async def test_a_plain_close_pauses_nothing():
    log: list[str] = []
    table = MachineTable({"a": _Napper("a", log)})
    table.hold_handles()
    await table.close()
    assert log == ["close a"]


@pytest.mark.asyncio
async def test_a_handle_whose_close_failed_is_still_paused():
    log: list[str] = []
    table = MachineTable({"a": _Napper("a", log, fail_close=True)})
    table.hold_handles()
    with pytest.raises(RuntimeError, match="close a failed"):
        await table.close(pause=_BOTH)
    assert log == ["close a", "pause a"]


@pytest.mark.asyncio
async def test_a_failed_close_and_a_failed_pause_are_both_raised():
    log: list[str] = []
    table = MachineTable(
        {
            "a": _Napper("a", log, fail_close=True),
            "b": _Napper("b", log, fail_pause=True),
        }
    )
    table.hold_handles()
    with pytest.raises(BaseExceptionGroup) as raised:
        await table.close(pause=_BOTH)
    assert sorted(str(e) for e in raised.value.exceptions) == [
        "close a failed",
        "pause b failed",
    ]


@pytest.mark.asyncio
async def test_a_pausing_close_pauses_no_handle_another_table_took():
    log: list[str] = []
    a = _Napper("a", log)
    first = MachineTable({"a": a})
    first.hold_handles()
    await first.close()
    again = MachineTable({"a": a})
    again.hold_handles()
    await first.close(pause=_BOTH)
    assert log == ["close a", "close a"]


@pytest.mark.asyncio
async def test_a_handle_is_held_until_it_has_paused():
    a = _Napper("a", [])
    table = MachineTable({"a": a})
    table.hold_handles()
    await table.close(pause=_BOTH)
    assert a.refused == "machine 'a' is already in another workspace"
    MachineTable({"a": a})


@pytest.mark.asyncio
async def test_a_cancelled_pausing_close_still_pauses_its_machines():
    log: list[str] = []
    gate = asyncio.Event()
    table = MachineTable({"a": _Napper("a", log, gate=gate)})
    table.hold_handles()
    closing = asyncio.ensure_future(table.close(pause=_BOTH))
    while "pause a" not in log:
        await asyncio.sleep(0)
    closing.cancel()
    gate.set()
    for _ in range(20):
        await asyncio.sleep(0)
    assert log == ["close a", "pause a", "paused a"]


@pytest.mark.asyncio
async def test_a_pausing_close_waits_for_the_signals_queued_for_its_machines():
    log: list[str] = []
    table = MachineTable({"a": _Napper("a", log)})
    table.hold_handles()
    signal = table._signaling["box:a"]
    await signal.acquire()
    closing = asyncio.ensure_future(table.close(pause=_BOTH))
    for _ in range(5):
        await asyncio.sleep(0)
    assert log == []
    signal.release()
    await closing
    assert log == ["close a", "pause a"]

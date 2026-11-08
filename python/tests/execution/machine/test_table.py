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

from mirage import Workspace
from mirage.execution.machine.table import MachineTable
from mirage.execution.machine.types import MachineProcess, MachineState
from mirage.execution.process.table import ProcessTable
from mirage.execution.types import MachinePid
from mirage.machine.constants import CHECK_LINE, PROCESS
from mirage.machine.handle import MachineHandle
from mirage.runtime.machine import MachineRuntime
from mirage.runtime.types import RunResult
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS


class _Box(MachineHandle):
    provider = "box"

    def __init__(self, name: str, code: int | None) -> None:
        super().__init__(name)
        self.code = code
        self.lines: list[str] = []

    async def connect(self) -> None:
        if self.code is None:
            raise ConnectionError("no such box")

    async def _exec_argv(self, argv, stdin, env, cwd, output, errors):
        self.lines.append(argv[-1])
        return RunResult(stdout=b"", stderr=None, exit_code=self.code or 0)


@pytest.mark.asyncio
async def test_a_check_tells_how_far_mirage_reaches_each_machine():
    boxes = {"a": _Box("a", 0), "b": _Box("b", 1), "c": _Box("c", None)}
    table = MachineTable(boxes)
    found = await table.check(lambda: 7.0)
    assert [(str(m.id), m.state, m.checked_at) for m in found] == [
        ("box:a", MachineState.MANAGED, 7.0),
        ("box:b", MachineState.REACHABLE, 7.0),
        ("box:c", MachineState.UNREACHABLE, 7.0),
    ]
    assert boxes["a"].lines == [CHECK_LINE]


@pytest.mark.asyncio
async def test_a_check_may_name_one_machine():
    table = MachineTable({"a": _Box("a", 0), "b": _Box("b", 0)})
    assert [str(m.id) for m in await table.check(lambda: 0.0, "box:b")] == [
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

    async def connect(self) -> None:
        return None

    async def _exec_argv(self, argv, stdin, env, cwd, output, errors):
        tag = env[PROCESS]
        self.rows = [
            MachineProcess(tag, self.base, 1, 100.0, " ".join(argv)),
            MachineProcess(tag, self.base + 1, self.base, 101.0, "train 2"),
        ]
        await self.ended.wait()
        self.rows = []
        return RunResult(stdout=b"", stderr=None, exit_code=143)

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


def _sleepers(**boxes: MachineHandle) -> Workspace:
    return Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        machines=boxes,
        runtimes=[MachineRuntime(["train"], machine=next(iter(boxes)))],
    )


@pytest.mark.asyncio
async def test_a_scan_shows_what_a_program_started_on_its_machine():
    box = _Sleeper("a")
    ws = _sleepers(a=box)
    try:
        pid = int((await ws.shell("train 1 & echo $!")).stdout)
        shell = int((await ws.shell("echo $$")).stdout)
        await _started(box)
        said = await ws.shell("ps f -o pid,ppid,machine,mpid,cmd")
        rows = [
            line.split(None, 4) for line in said.stdout.decode().splitlines()
        ]
        assert rows[0] == ["PID", "PPID", "MACHINE", "MPID", "CMD"]
        assert [row[1:] for row in rows[1:]] == [
            ["0", "-", "-", "ps f -o pid,ppid,machine,mpid,cmd"],
            [str(shell), "box:a", "412", "\\_ train 1"],
            [str(pid), "box:a", "413", "\\_ train 2"],
        ]
        assert rows[2][0] == str(pid)
        found = ws.process_table.records()[-1]
        assert (found.runtime, found.parent) == (None, pid)
        killed = await ws.shell(f"kill -USR1 413; kill -0 {pid}; echo $?")
        assert killed.stdout == b"0\n"
        assert box.sent == [(MachinePid(413, 101.0), 10)]
        assert (await ws.shell(f"kill {pid}; wait {pid}")).exit_code == 143
        assert box.sent[-1] == (MachinePid(412, 100.0), 15)
        await ws.shell("ps")
        assert found.pid not in {p.record.pid for p in ws.process_table.live()}
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_signal_reaches_a_program_no_scan_placed_by_its_tag():
    box = _Sleeper("a")
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
    a, b = _Sleeper("a"), _Sleeper("b", base=500)
    ws = _sleepers(a=a, b=b)
    try:
        pid = int((await ws.shell("train 1 & echo $!")).stdout)
        await _started(a)
        said = await ws.shell("ps -p 412 -o pid=; kill -0 412; echo $?")
        assert said.stdout.decode().split() == [str(pid), "0"]
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
        b.rows = [MachineProcess(r.tag, 412, 1, 9.0, "x") for r in b.rows[:1]]
        said = await ws.shell("kill 412")
        assert said.exit_code == 1
        assert said.stderr == b"bash: line 1: kill: 412: ambiguous job spec\n"
        assert (await ws.shell(f"kill 413; kill {pid}; wait {pid}")).exit_code
    finally:
        a.ended.set()
        b.ended.set()
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
            while pid in {p.record.pid for p in ws.process_table.live()}:
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
        found = [p.machine_pid for p in held if p.runtime is None]
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
            MachineProcess(env[PROCESS], self.base + 1, 1, 101.0, "daemon")
        ]
        return RunResult(stdout=b"", stderr=None, exit_code=0)


@pytest.mark.asyncio
async def test_a_scan_finds_what_an_ended_program_left_running():
    box = _Leaver("a")
    ws = _sleepers(a=box)
    try:
        assert (await ws.shell("train 1")).exit_code == 0
        said = await ws.shell("ps -o mpid=,args=")
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
        said = await new.shell("ps -o mpid=,args=")
        assert b"daemon" not in said.stdout
        assert (await new.shell("kill 413")).exit_code == 1
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_host_scan_finds_what_an_ended_program_left_running():
    ws = Workspace(
        {"/": RAMVFS()}, mode=MountMode.EXEC, runtimes=["local", "workspace"]
    )
    spawn = (
        "import subprocess as s; "
        "s.Popen(['sleep', '30'], stdin=s.DEVNULL, stdout=s.DEVNULL, "
        "stderr=s.DEVNULL)"
    )
    try:
        assert (await ws.shell(f'python3 -c "{spawn}"')).exit_code == 0
        said = await ws.shell("ps -o machine=,mpid=,args=")
        rows = [line.split() for line in said.stdout.decode().splitlines()]
        held = [row for row in rows if row[2:] == ["sleep", "30"]]
        assert len(held) == 1 and held[0][0].startswith("host:")
        assert (await ws.shell(f"kill -9 {held[0][1]}")).exit_code == 0
    finally:
        await ws.close()


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
        assert said.stdout == b"[1] running ( train 1; true )\n"
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
        assert set(box.sent) == {
            (MachinePid(412, 100.0), 28),
            (MachinePid(413, 101.0), 28),
        }
        said = await ws.shell("jobs")
        assert said.stdout == b"[1] running train 1\n"
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
        self.rows = [MachineProcess(env[PROCESS], self.base, 1, 100.0, "q")]
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
        listed = (await ws.shell("ps -o pgid=,mpid=")).stdout.decode()
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
        listed = (await ws.shell("ps -o pgid=,mpid=")).stdout.decode()
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
        tag = env[PROCESS]
        self.rows_of[self.name] = [
            MachineProcess(tag, self.base, 1, 100.0, " ".join(argv)),
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
        said = await ws.shell("ps -o machine=,mpid=,args=")
        rows = [line.split()[:2] for line in said.stdout.decode().splitlines()]
        found = [row for row in rows if row[1:] and row[1] != "-"]
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
    with pytest.raises(ValueError, match="unknown machine: 'c'"):
        Workspace(
            {"/": RAMVFS()},
            mode=MountMode.EXEC,
            machines={"a": box},
            runtimes=[MachineRuntime(machine="c"), "workspace"],
        )
    await Workspace(
        {"/": RAMVFS()}, mode=MountMode.EXEC, machines={"a": box}
    ).close()

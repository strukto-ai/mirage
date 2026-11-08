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

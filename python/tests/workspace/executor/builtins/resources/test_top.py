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

from mirage.execution.process.types import Process, ProcessUsage
from mirage.execution.types import (
    CpuShares,
    LineId,
    MachineName,
    ProcessId,
    TaskCounts,
)
from mirage.types import PathSpec
from mirage.workspace.executor.builtins.resources.top import _since, handle_top
from tests.fixtures.machine_resources import resources, table_of

SAMPLED = {
    "tasks": TaskCounts(60, 1, 59),
    "cpu": CpuShares(0.0, 0.0, 100.0, 0.0, 0.0, 0.0, 0.0, 0.0),
    "load": (0.16, 0.03, 0.01),
    "mem_total": int(981.8 * 1024**2),
    "mem_free": int(837.5 * 1024**2),
    "mem_available": int(941.3 * 1024**2),
    "buffers": 0,
    "cached": int(119.7 * 1024**2),
    "swap_total": 0,
    "swap_free": 0,
}


async def top_of(*words: str, table=None) -> tuple[list[str], str, int]:
    out, io, _ = await handle_top(
        table or table_of(resources(**SAMPLED)), ["top", *words]
    )
    text = (
        (out or b"").decode() if isinstance(out, (bytes, type(None))) else ""
    )
    return text.split("\n"), (io.stderr or b"").decode(), io.exit_code


@pytest.mark.asyncio
async def test_summary_lines_are_procps_layout():
    lines, _, code = await top_of("-b", "-n", "1")
    assert lines[0] == (
        "top - 03:35:54 up 0 min,  0 users,  load average: 0.16, 0.03, 0.01"
    )
    assert lines[1] == (
        "Tasks:  60 total,   1 running,  59 sleeping,   0 stopped,   0 zombie"
    )
    assert lines[2] == (
        "%Cpu(s):  0.0 us,  0.0 sy,  0.0 ni,100.0 id,  0.0 wa,  0.0 hi,"
        "  0.0 si,  0.0 st "
    )
    assert lines[3] == (
        "MiB Mem :    981.8 total,    837.5 free,     40.5 used,"
        "    119.7 buff/cache     "
    )
    assert lines[4] == (
        "MiB Swap:      0.0 total,      0.0 free,      0.0 used."
        "    941.3 avail Mem "
    )
    assert lines[5] == ""
    assert lines[6] == (
        "  PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM"
        "     TIME+ COMMAND"
    )
    assert code == 0


@pytest.mark.asyncio
async def test_width_cuts_every_line():
    lines, _, _ = await top_of("-bn1", "-w", "10")
    assert lines[0] == "top - 03:3"
    assert lines[1] == "Tasks:  60"


@pytest.mark.asyncio
async def test_memory_scale():
    lines, _, _ = await top_of("-b", "-n1", "-E", "g")
    assert lines[3].startswith("GiB Mem :      1.0 total,")


@pytest.mark.asyncio
async def test_several_machines_end_each_summary_line_in_the_machine():
    table = table_of(
        resources("docker:a", **SAMPLED), resources("e2b:b", **SAMPLED)
    )
    lines, _, _ = await top_of("-bn1", table=table)
    assert lines[0].endswith("0.01  docker:a")
    assert lines[3].endswith("buff/cache  docker:a")
    assert lines[5].endswith("0.01  e2b:b")
    assert lines[11].endswith("MACHINE COMMAND")


@pytest.mark.parametrize(
    ("words", "said"),
    [
        ([], "top: failed tty get\n"),
        (["-b", "-n", "abc"], "top: bad iterations argument 'abc'\n"),
        (["-b", "-n", "0"], "top: bad iterations argument '0'\n"),
        (["-b", "-d", "abc", "-n1"], "top: bad delay interval 'abc'\n"),
        (["-b", "-d", "-1", "-n1"], "top: -d requires positive argument\n"),
        (["-bn1", "-o", "nosuch"], "top: unrecognized field name 'nosuch'\n"),
        (["-bn1", "-E", "z"], "top: bad memory scaling arg 'z'\n"),
        (["-bn1", "-p", "abc"], "top: bad pid 'abc'\n"),
        (["-bn1", "-w", "abc"], "top: bad width arg 'abc'\n"),
        (["-bn"], "top: option requires an argument -- 'n'\n"),
        (["-x"], "top: invalid option -- 'x'\n"),
        (["-bn1", "extra"], "top: unknown option 'extra'\n"),
    ],
)
@pytest.mark.asyncio
async def test_refusals_are_in_procps_words(words: list[str], said: str):
    _, err, code = await top_of(*words)
    assert err == said
    assert code == 1


def _busy(pid: int, cpu_seconds: float) -> Process:
    return Process(
        id=ProcessId("w", pid),
        session_id="s",
        line=LineId("line_1"),
        parent=None,
        group=pid,
        command="sleep 30",
        cwd=PathSpec.from_str_path("/"),
        machine=MachineName("host", "box"),
        started_at=1.0,
        usage=ProcessUsage(cpu_seconds, 1.0, 0.0, 0, 0),
    )


def test_a_later_frame_shows_the_cpu_since_the_one_before():
    samples: dict[int, tuple[ProcessUsage, float, float | None]] = {}
    first = _since([_busy(7, 10.0)], samples, 100.0)
    assert [row.usage.cpu_percent for row in first if row.usage] == [1.0]
    read = _busy(7, 11.5)
    later = _since([read, _busy(8, 3.0)], samples, 102.0)
    assert [row.usage.cpu_percent for row in later if row.usage] == [75.0, 1.0]
    stale = _since([read], samples, 104.0)
    assert [row.usage.cpu_percent for row in stale if row.usage] == [75.0]
    assert samples[7][1] == 102.0
    back = _since([_busy(7, 13.5)], samples, 106.0)
    assert [row.usage.cpu_percent for row in back if row.usage] == [50.0]

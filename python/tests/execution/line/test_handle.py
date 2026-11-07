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

from mirage.execution.line.handle import LineHandle
from mirage.execution.line.types import LineState
from mirage.execution.types import LineId


def _clock(start: float = 100.0):
    now = [start]
    return now, lambda: now[0]


@pytest.mark.asyncio
async def test_a_line_waits_runs_and_ends_once():
    now, read = _clock()
    started = []

    async def on_start():
        started.append(True)

    line = LineHandle(
        LineId("l1"), "s", "echo hi", on_start=on_start, now=read
    )
    assert (line.record.state, line.record.started_at) == (
        LineState.WAITING,
        100.0,
    )
    await line.start()
    await line.start()
    assert started == [True]
    assert line.record.state == LineState.RUNNING
    now[0] = 105.0
    line.end(0)
    line.end(1, "late")
    record = line.record
    assert (record.state, record.ended_at, record.exit) == (
        LineState.EXITED,
        105.0,
        0,
    )
    assert (record.signal, record.error) == (None, None)


@pytest.mark.asyncio
async def test_a_stopped_line_ends_as_stopped_by_its_signal():
    line = LineHandle(LineId("l1"), "s", "sleep 9")
    await line.start()
    line.stop(2)
    assert line.record.state == LineState.STOPPING
    line.end(130)
    assert (line.record.signal, line.record.exit) == (2, 130)
    line.stop(15)
    assert line.record.signal == 2


async def _refuse() -> None:
    raise RuntimeError("cancelled before admission")


@pytest.mark.asyncio
async def test_an_admission_that_raises_keeps_the_line_waiting():
    line = LineHandle(LineId("l1"), "s", "true", on_start=_refuse)
    with pytest.raises(RuntimeError):
        await line.start()
    assert line.record.state == LineState.WAITING

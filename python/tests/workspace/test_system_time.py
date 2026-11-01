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

from datetime import datetime, timezone

import pytest

from mirage import Workspace
from mirage.types import MountMode
from mirage.utils.clock import ManualClock, parse_system_time
from mirage.vfs.ram import RAMVFS


def _started(
    system_time: str | None, clock: ManualClock | None = None
) -> Workspace:
    return Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        clock=clock if clock is not None else ManualClock(1_000_000),
        system_time=system_time,
    )


async def _out(ws: Workspace, line: str) -> str:
    return await (await ws.shell(line)).stdout_str()


@pytest.mark.asyncio
async def test_system_time_starts_date_file_times_and_jq():
    clock = ManualClock(1_000_000)
    ws = _started("2026-03-02T09:00:00Z", clock)
    try:
        assert await _out(ws, "date -u") == "Mon Mar  2 09:00:00 UTC 2026\n"
        assert await _out(ws, "TZ=Asia/Shanghai date +%H:%M") == "17:00\n"
        assert await _out(ws, "date -u -d tomorrow +%F") == "2026-03-03\n"
        await ws.shell("touch /data/a")
        # ls shows the time of a file stamped before now, as GNU's does.
        clock.advance(60)
        assert " Mar  2 09:00 a\n" in await _out(ws, "ls -l /data")
        assert await _out(ws, "find /data -mtime -1") == "/data/a\n"
        assert (
            await _out(ws, "echo '{}' | jq -r 'now|todate'")
            == "2026-03-02T09:01:00Z\n"
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_system_time_ticks_with_the_workspace_clock():
    clock = ManualClock(1_000_000)
    ws = _started("2026-03-02T09:00:00+08:00", clock)
    try:
        clock.advance(90)
        assert await _out(ws, "date -u +%T") == "01:01:30\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_system_time_stamps_a_file_op_outside_any_line():
    ws = _started("2026-03-02T09:00:00Z")
    try:
        await ws.vfs.write("/data/b", b"x")
        modified = (await ws.vfs.stat("/data/b")).modified
        assert datetime.fromisoformat(modified) == datetime(
            2026, 3, 2, 9, tzinfo=timezone.utc
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_system_time_answers_python():
    ws = _started("2026-03-02T09:00:00Z")
    try:
        line = (
            "python3 -c 'import datetime, time; "
            "print(datetime.datetime.now(datetime.timezone.utc).date(), "
            "datetime.date.today(), int(time.time()))'"
        )
        assert await _out(ws, line) == "2026-03-02 2026-03-02 1772442000\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_unset_keeps_the_hosts_time():
    ws = _started(None, ManualClock(0))
    try:
        year = datetime.now(timezone.utc).year
        assert await _out(ws, "date -u +%Y") == f"{year}\n"
        assert ws.system_time is None
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_system_time_is_reported_and_carried_as_written(tmp_path):
    ws = _started("2026-03-02T09:00:00Z")
    try:
        assert ws.system_time == "2026-03-02T09:00:00Z"
        await ws.snapshot(tmp_path / "ws.tar")
        loaded = await Workspace.load(tmp_path / "ws.tar")
        try:
            assert loaded.system_time == "2026-03-02T09:00:00Z"
            assert await _out(loaded, "date -u +%F") == "2026-03-02\n"
        finally:
            await loaded.close()
    finally:
        await ws.close()


@pytest.mark.parametrize(
    ("text", "seconds"),
    [
        ("2026-03-02T09:00:00Z", 1772442000),
        ("2026-03-02T09:00Z", 1772442000),
        ("2026-03-02T09:00:00+08:00", 1772413200),
        ("2026-03-02T09:00:00.1234567Z", 1772442000.123),
        ("2028-02-29T00:00:00Z", 1835395200),
    ],
)
def test_parse_system_time_reads(text, seconds):
    assert parse_system_time(text) == pytest.approx(seconds, abs=1e-6)


@pytest.mark.parametrize(
    "text",
    [
        "2026-03-02",
        "2026-03-02T09:00:00",
        "2026-02-30T09:00:00Z",
        "2026-03-02T24:00:00Z",
        "2026-03-02T09:00:60Z",
        "2026-03-02T09:00:00+24:00",
    ],
)
def test_parse_system_time_refuses(text):
    with pytest.raises(ValueError, match="is not an ISO 8601 instant"):
        parse_system_time(text)

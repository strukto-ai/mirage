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

from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


def _ws():
    mem = RAMVFS()
    ws = Workspace(
        {"/data": (mem, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )
    return ws, mem


def _run_raw(ws, cmd, cwd="/", stdin=None):
    ws._cwd = cwd
    io = asyncio.run(ws.shell(cmd, stdin=stdin))
    return io.stdout, io


def _bytes(stdout):
    if isinstance(stdout, bytes):
        return stdout
    return b"".join(asyncio.run(_collect(stdout)))


async def _collect(ait):
    return [chunk async for chunk in ait]


def test_date_utc_format():
    ws, _ = _ws()
    stdout, _ = _run_raw(ws, "date -u '+%Y'")
    year = _bytes(stdout).strip().decode()
    assert len(year) == 4
    assert year.isdigit()


def test_date_relative_from_iso_base():
    ws, _ = _ws()
    stdout, io = _run_raw(
        ws, "date -u -d '2026-08-16 12:00:00 24 hours ago' '+%F %T'")
    assert _bytes(stdout).decode() == "2026-08-15 12:00:00\n"
    assert io.exit_code == 0


def test_date_epoch_input():
    ws, _ = _ws()
    stdout, _ = _run_raw(ws, "date -u -d '@1755300000' '+%F %T'")
    assert _bytes(stdout).decode() == "2025-08-15 23:20:00\n"


def test_date_month_addition_normalizes():
    ws, _ = _ws()
    stdout, _ = _run_raw(ws, "date -u -d '2026-01-31 1 month' '+%F'")
    assert _bytes(stdout).decode() == "2026-03-03\n"


def test_date_invalid_date_fails_loud():
    ws, _ = _ws()
    stdout, io = _run_raw(ws, "date -d 'not a date'")
    assert io.exit_code == 1
    assert b"date: invalid date 'not a date'" in io.stderr
    assert _bytes(stdout) == b""

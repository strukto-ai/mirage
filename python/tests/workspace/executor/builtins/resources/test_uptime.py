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

from mirage.workspace.executor.builtins.resources.uptime import (
    handle_uptime,
    pretty,
    since,
    up_text,
)
from tests.fixtures.machine_resources import resources, table_of


@pytest.mark.parametrize(
    ("seconds", "said"),
    [
        (0, "0 min"),
        (59, "0 min"),
        (60, "1 min"),
        (3599, "59 min"),
        (3600, " 1:00"),
        (3660, " 1:01"),
        (86399, "23:59"),
        (86400, "1 day, 0 min"),
        (86460, "1 day, 1 min"),
        (90000, "1 day,  1:00"),
        (172800, "2 days, 0 min"),
        (694861, "8 days,  1:01"),
    ],
)
def test_up_text(seconds: int, said: str):
    assert up_text(seconds) == said


@pytest.mark.parametrize(
    ("seconds", "said"),
    [
        (0.5, "up 0 minutes"),
        (60.5, "up 1 minute"),
        (120.5, "up 2 minutes"),
        (3600.5, "up 1 hour, 0 minutes"),
        (3660.5, "up 1 hour, 1 minute"),
        (86400.5, "up 1 day, 0 minutes"),
        (90060.5, "up 1 day, 1 hour, 1 minute"),
        (604800.5, "up 1 week, 0 minutes"),
        (694861.5, "up 1 week, 1 day, 1 hour, 1 minute"),
        (31536000.5, "up 1 year, 0 minutes"),
        (31622460.5, "up 1 year, 1 day, 1 minute"),
        (63072000.5, "up 2 years, 0 minutes"),
        (315360000.5, "up 1 decade, 0 minutes"),
    ],
)
def test_pretty(seconds: float, said: str):
    assert pretty(seconds) == said


def test_since_reads_the_machines_own_clock():
    row = resources(
        epoch=1762745754.0, up_seconds=59.0, offset="-0800", clock="19:35:54"
    )
    assert since(row) == "2025-11-09 19:34:55"


@pytest.mark.asyncio
async def test_uptime_line():
    out, io, _ = await handle_uptime(table_of(resources()), ["uptime"])
    assert out.decode() == (
        " 03:35:54 up 0 min,  0 users,  load average: 0.00, 0.10, 0.20\n"
    )
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_one_user_is_singular():
    out, _, _ = await handle_uptime(table_of(resources(users=1)), ["uptime"])
    assert "  1 user,  " in out.decode()


@pytest.mark.asyncio
async def test_several_machines_end_each_line_with_the_machine():
    table = table_of(resources("docker:a"), resources("e2b:b"))
    out, _, _ = await handle_uptime(table, ["uptime", "-p"])
    assert out.decode() == "up 0 minutes  docker:a\nup 0 minutes  e2b:b\n"


@pytest.mark.asyncio
async def test_since_outranks_pretty():
    out, _, _ = await handle_uptime(
        table_of(resources()), ["uptime", "-p", "-s"]
    )
    assert out.decode().startswith("2025-")

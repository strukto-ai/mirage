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

from mirage.mount.changes import SERVED_BY, RecentChanges
from mirage.utils.clock import ManualClock


def served_by(machine, changes, path):
    token = SERVED_BY.set(machine)
    try:
        changes.note(path)
    finally:
        SERVED_BY.reset(token)


@pytest.mark.asyncio
async def test_a_change_another_made_is_waited_out_to_the_window():
    clock = ManualClock()
    changes = RecentChanges(clock, 1)
    changes.note("/data/f")
    clock.advance(0.25)
    await changes.wait_out({"/data": 0.0}, "box")
    assert clock.monotonic() == 1.0


@pytest.mark.asyncio
async def test_a_machines_own_change_is_waited_out_only_by_the_others():
    clock = ManualClock()
    changes = RecentChanges(clock, 1)
    served_by("box", changes, "/data/f")
    await changes.wait_out({"/data": 0.0}, "box")
    assert clock.monotonic() == 0.0
    await changes.wait_out({"/data": 0.0}, "gpu")
    assert clock.monotonic() == 1.0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("path", "waited"),
    [
        ("/data", True),
        ("/data/a/b", True),
        ("/", True),
        ("/database/x", False),
        ("/dev/null", False),
        ("/tmp/x", False),
    ],
)
async def test_only_a_change_reaching_a_served_prefix_is_waited_out(
    path, waited
):
    clock = ManualClock()
    changes = RecentChanges(clock, 1)
    changes.note(path)
    await changes.wait_out({"/data": 0.0}, "box")
    assert clock.monotonic() == (1.0 if waited else 0.0)


@pytest.mark.asyncio
async def test_a_change_older_than_the_window_is_not_waited_out():
    clock = ManualClock()
    changes = RecentChanges(clock, 1)
    changes.note("/data/f")
    clock.advance(1)
    await changes.wait_out({"/data": 0.0}, "box")
    assert clock.monotonic() == 1.0


@pytest.mark.asyncio
async def test_a_change_made_before_its_mount_began_is_not_waited_out():
    clock = ManualClock()
    changes = RecentChanges(clock, 1)
    changes.note("/data/f")
    clock.advance(0.25)
    await changes.wait_out({"/data": changes.now()}, "box")
    assert clock.monotonic() == 0.25

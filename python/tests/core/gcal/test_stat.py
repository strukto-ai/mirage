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

from mirage.core.gcal.stat import stat
from mirage.types import FileType, PathSpec

pytestmark = pytest.mark.asyncio


def spec(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual,
                    resource_path=virtual.lstrip("/"))


async def test_root_is_a_directory(api, accessor, index):
    row = await stat(accessor, spec("/"), index)
    assert row.type is FileType.DIRECTORY


async def test_calendar_is_a_directory(api, accessor, index):
    row = await stat(accessor, spec("/primary"), index)
    assert row.type is FileType.DIRECTORY
    assert row.name == "primary"


async def test_day_holding_events_is_a_directory(api, accessor, index):
    row = await stat(accessor, spec("/primary/2026-08-11"), index)
    assert row.type is FileType.DIRECTORY


async def test_event_free_day_still_resolves_as_a_directory(
        api, accessor, index):
    # The range query over that day is positive proof of what is there, so
    # an empty day is an empty directory rather than ENOENT.
    row = await stat(accessor, spec("/primary/2027-03-04"), index)
    assert row.type is FileType.DIRECTORY
    assert row.name == "2027-03-04"


async def test_day_under_an_unknown_calendar_is_enoent(api, accessor, index):
    with pytest.raises(FileNotFoundError):
        await stat(accessor, spec("/nope/2027-03-04"), index)


async def test_malformed_date_is_enoent(api, accessor, index):
    with pytest.raises(FileNotFoundError):
        await stat(accessor, spec("/primary/not-a-date"), index)


async def test_date_shaped_but_impossible_date_is_enoent(api, accessor, index):
    # Shape alone used to be enough, so stat reported a directory that
    # readdir then raised ValueError on.
    for bad in ("2026-02-30", "2026-13-01"):
        with pytest.raises(FileNotFoundError):
            await stat(accessor, spec(f"/primary/{bad}"), index)


async def test_event_reports_json_with_a_rendered_size(api, accessor, index):
    row = await stat(
        accessor,
        spec("/primary/2026-08-11/aaaa1__0900-1030_PhD_Defense.gcal.json"),
        index)
    assert row.type is FileType.JSON
    assert row.extra["event_id"] == "aaaa1"
    # Size is the rendered payload's byte length, never a source-side number.
    assert row.size is not None and row.size > 0


async def test_calendar_json_reports_json(api, accessor, index):
    row = await stat(accessor, spec("/primary/calendar.json"), index)
    assert row.type is FileType.JSON


async def test_unknown_event_is_enoent(api, accessor, index):
    with pytest.raises(FileNotFoundError):
        await stat(accessor,
                   spec("/primary/2026-08-11/zzzz9__0000-0100_Nope.gcal.json"),
                   index)

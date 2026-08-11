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

import json

import pytest

from mirage.core.gcal.read import read
from mirage.types import PathSpec

pytestmark = pytest.mark.asyncio

EVENT = "/primary/2026-08-11/aaaa1__0900-1030_PhD_Defense.gcal.json"


def spec(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual,
                    resource_path=virtual.lstrip("/"))


async def test_event_reads_the_unmodified_api_payload(api, accessor, index):
    body = json.loads(await read(accessor, spec(EVENT), index))
    assert body["id"] == "aaaa1"
    assert body["summary"] == "PhD Defense"
    # The original offset survives: the directory name is a view, the
    # payload is what an absolute-instant comparison is made against.
    assert body["start"]["dateTime"] == "2026-08-11T09:00:00+08:00"


async def test_calendar_json_carries_the_bucket_zone_and_role(
        api, accessor, index):
    body = json.loads(await read(accessor, spec("/primary/calendar.json"),
                                 index))
    assert body["id"] == "integ@example.com"
    assert body["accessRole"] == "owner"
    assert body["primary"] is True
    assert body["bucketTimeZone"] == "Asia/Hong_Kong"


async def test_calendar_json_states_the_mount_wide_zone_not_the_calendars(
        api, accessor, index):
    # The reader calendar is America/Los_Angeles, but its day directories are
    # bucketed mount-wide so every calendar's 2026-08-11 is the same window.
    path = "/Engineering__team@group.calendar.google.com/calendar.json"
    body = json.loads(await read(accessor, spec(path), index))
    assert body["calendarTimeZone"] == "America/Los_Angeles"
    assert body["bucketTimeZone"] == "Asia/Hong_Kong"


async def test_reading_a_directory_raises(api, accessor, index):
    with pytest.raises(IsADirectoryError):
        await read(accessor, spec("/primary"), index)


async def test_unknown_calendar_is_enoent(api, accessor, index):
    with pytest.raises(FileNotFoundError):
        await read(accessor, spec("/nope/calendar.json"), index)


async def test_unknown_event_is_enoent(api, accessor, index):
    with pytest.raises(FileNotFoundError):
        await read(accessor,
                   spec("/primary/2026-08-11/zzzz9__0000-0100_Nope.gcal.json"),
                   index)


async def test_a_name_that_is_not_an_event_file_is_enoent(
        api, accessor, index):
    with pytest.raises(FileNotFoundError):
        await read(accessor, spec("/primary/2026-08-11/notes.txt"), index)

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

from mirage.accessor.gcal import GCalAccessor
from mirage.core.render.json import compact_json_bytes
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.vfs.gcal import GCalVFS
from tests.fixtures.gcal_api import EVENTS, make_accessor, spec
from tests.fixtures.mounted import mounted

pytestmark = [pytest.mark.asyncio, pytest.mark.usefixtures("gcal_api")]


async def stat(accessor: GCalAccessor, path: PathSpec) -> FileStat:
    return await mounted(GCalVFS, accessor).stat(path)


async def test_root_is_a_directory(accessor):
    row = await stat(accessor, spec("/"))
    assert row.type is FileType.DIRECTORY


@pytest.mark.parametrize(
    "size, path",
    [
        (1, "/primary"),
        (1, "/primary/2026-08-11"),
        (7, "/primary/2026-08-10--2026-08-16"),
        # The range query is positive proof of what is there, so a bucket
        # with no events is an empty directory rather than ENOENT.
        (1, "/primary/2027-03-04"),
        (7, "/primary/2027-03-01--2027-03-07"),
    ],
)
async def test_calendars_and_buckets_are_directories(size, path):
    row = await stat(make_accessor(bucket_days=size), spec(path))
    assert row.type is FileType.DIRECTORY
    assert row.name == path.rsplit("/", 1)[-1]


@pytest.mark.parametrize(
    "size, path",
    [
        (1, "/primary/2026-08-11/aaaa1__0900-1030_PhD_Defense.gcal.json"),
        (
            7,
            "/primary/2026-08-10--2026-08-16/"
            "aaaa1__2026-08-11_0900-1030_PhD_Defense.gcal.json",
        ),
    ],
)
async def test_an_event_is_json_sized_as_rendered(size, path):
    row = await stat(make_accessor(bucket_days=size), spec(path))
    assert row.content is ContentType.JSON
    assert row.extra["event_id"] == "aaaa1"
    # The rendered payload's byte length, never a source-side number.
    assert row.size == len(compact_json_bytes(EVENTS[0]))


async def test_calendar_json_reports_json(accessor):
    row = await stat(accessor, spec("/primary/calendar.json"))
    assert row.content is ContentType.JSON


@pytest.mark.parametrize(
    "size, path",
    [
        (1, "/nope/2027-03-04"),
        (1, "/primary/not-a-date"),
        # Shape alone used to be enough, so stat reported a directory that
        # readdir then raised ValueError on.
        (1, "/primary/2026-02-30"),
        (1, "/primary/2026-13-01"),
        (1, "/primary/2026-08-11/zzzz9__0000-0100_Nope.gcal.json"),
        (7, "/primary/2026-08-11"),
        (7, "/primary/2026-08-11--2026-08-17"),
    ],
)
async def test_what_the_tree_does_not_hold_is_enoent(size, path):
    with pytest.raises(FileNotFoundError):
        await stat(make_accessor(bucket_days=size), spec(path))

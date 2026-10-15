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

from mirage.core.gcal.read import read, read_many
from tests.fixtures.gcal_api import EVENTS, HK, make_accessor, spec

pytestmark = [pytest.mark.asyncio, pytest.mark.usefixtures("gcal_api")]

PHD = "aaaa1__0900-1030_PhD_Defense.gcal.json"
DATED_PHD = "aaaa1__2026-08-11_0900-1030_PhD_Defense.gcal.json"


@pytest.mark.parametrize(
    "size, path",
    [
        (1, f"/primary/2026-08-11/{PHD}"),
        (7, f"/primary/2026-08-10--2026-08-16/{DATED_PHD}"),
        (30, f"/primary/2026-08-09--2026-09-07/{DATED_PHD}"),
    ],
)
async def test_an_event_reads_the_unmodified_api_payload(
    gcal_api, size, path, index
):
    # The names are a view; the payload, original offsets included, is what
    # an absolute-instant comparison is made against.
    body = await read(make_accessor(bucket_days=size), spec(path), index)
    assert json.loads(body) == EVENTS[0]
    # Only the day the name is on is queried, whatever the bucket's size.
    assert gcal_api.listed == [
        (
            "integ@example.com",
            "2026-08-11T00:00:00+08:00",
            "2026-08-12T00:00:00+08:00",
        )
    ]


@pytest.mark.parametrize(
    "path, fields",
    [
        (
            "/primary/calendar.json",
            {
                "id": "integ@example.com",
                "accessRole": "owner",
                "primary": True,
                "bucketTimeZone": HK,
            },
        ),
        # The reader calendar lives in Los Angeles, but every calendar is
        # bucketed mount-wide so each 2026-08-11 is the same window.
        (
            "/Engineering__team@group.calendar.google.com/calendar.json",
            {"calendarTimeZone": "America/Los_Angeles", "bucketTimeZone": HK},
        ),
    ],
)
async def test_calendar_json_carries_the_role_and_bucket_zone(
    accessor, index, path, fields
):
    body = json.loads(await read(accessor, spec(path), index))
    assert fields.items() <= body.items()


async def test_reading_a_directory_reports_absence(accessor, index):
    # A probed directory shape is no proof the node exists, so the read
    # reports absence; the mount root, which exists by construction, is
    # the one EISDIR.
    with pytest.raises(FileNotFoundError):
        await read(accessor, spec("/primary"), index)
    with pytest.raises(IsADirectoryError):
        await read(accessor, spec("/"), index)


@pytest.mark.parametrize(
    "size, path",
    [
        (1, "/nope/calendar.json"),
        (1, "/primary/2026-08-11/zzzz9__0000-0100_Nope.gcal.json"),
        (1, "/primary/2026-08-11/notes.txt"),
        # A name carries its day exactly on a multi-day mount, and only a
        # day of its own bucket.
        (1, f"/primary/2026-08-11/{DATED_PHD}"),
        (7, f"/primary/2026-08-10--2026-08-16/{PHD}"),
        (
            7,
            "/primary/2026-08-10--2026-08-16/"
            "aaaa1__2026-08-18_0900-1030_PhD_Defense.gcal.json",
        ),
        (7, f"/primary/2026-08-11/{PHD}"),
    ],
)
async def test_a_name_the_tree_does_not_hold_is_enoent(size, path, index):
    with pytest.raises(FileNotFoundError):
        await read(make_accessor(bucket_days=size), spec(path), index)


async def test_a_batch_lists_each_day_once(gcal_api, index):
    day = "/primary/2026-08-11"
    paths = [
        f"{day}/{PHD}",
        f"{day}/bbbb2__1500-1600_Committee_Meeting.gcal.json",
        f"{day}/zzzz9__0000-0100_Nope.gcal.json",
        "/primary/calendar.json",
    ]
    answers = await read_many(
        make_accessor(), [spec(path) for path in paths], 1 << 20, index
    )
    assert {path: json.loads(body) for path, body in answers.items()} == {
        paths[0]: EVENTS[0],
        paths[1]: EVENTS[1],
    }
    assert len(gcal_api.listed) == 1
    # An event past the limit is left out for its own read.
    small = min(answers, key=lambda path: len(answers[path]))
    assert list(
        await read_many(
            make_accessor(),
            [spec(path) for path in paths],
            len(answers[small]),
            index,
        )
    ) == [small]

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

from mirage.core.gcal.readdir import (
    bucket_zone,
    calendar_index,
    readdir,
    unsearched_text,
)
from tests.fixtures.gcal_api import HK, make_accessor, names, spec

pytestmark = [pytest.mark.asyncio, pytest.mark.usefixtures("gcal_api")]

WEEK = "/primary/2026-08-10--2026-08-16"


async def test_root_lists_one_directory_per_calendar(accessor, index):
    assert names(await readdir(accessor, spec("/"), index)) == [
        "Engineering__team@group.calendar.google.com",
        "Exec__busy@group.calendar.google.com",
        "primary",
    ]


async def test_primary_keeps_its_alias_and_others_carry_the_id(accessor):
    calendars = await calendar_index(accessor)
    assert calendars["primary"]["id"] == "integ@example.com"
    assert (
        calendars["Engineering__team@group.calendar.google.com"]["id"]
        == "team@group.calendar.google.com"
    )


@pytest.mark.parametrize(
    "config, tz",
    [
        # Not the reader calendar's America/Los_Angeles: one zone mount-wide.
        ({}, HK),
        ({"time_zone": "Europe/Berlin"}, "Europe/Berlin"),
    ],
)
async def test_bucket_zone_defaults_to_the_primary_calendar(config, tz):
    accessor = make_accessor(**config)
    assert bucket_zone(accessor, await calendar_index(accessor)) == tz


@pytest.mark.parametrize(
    "size, buckets",
    [
        (
            1,
            [
                "2025-01-05",
                "2026-08-10",
                "2026-08-11",
                "2026-08-12",
                "2026-08-13",
            ],
        ),
        (7, ["2024-12-30--2025-01-05", "2026-08-10--2026-08-16"]),
        (30, ["2024-12-17--2025-01-15", "2026-08-09--2026-09-07"]),
    ],
)
async def test_calendar_lists_every_bucket_holding_events(
    size, buckets, index
):
    # All past events count, so last year's bucket is listed too.
    out = await readdir(
        make_accessor(bucket_days=size), spec("/primary"), index
    )
    assert names(out) == ["calendar.json", *buckets]


async def test_the_window_is_centred_in_the_bucket_zone(gcal_api, accessor):
    # today is pinned, so this asserts the zone reaches the accessor at all:
    # the bound carries the bucket zone's offset rather than the host's.
    await readdir(accessor, spec("/primary"))
    assert gcal_api.listed[-1][1:] == (None, "2026-11-09T16:00:00+00:00")


@pytest.mark.parametrize(
    "size, glob, listed, window",
    [
        (
            1,
            "2025-01-*",
            "2025-01-05",
            ("2024-12-31T16:00:00+00:00", "2025-01-31T16:00:00+00:00"),
        ),
        # Widened to whole weeks: January 1st falls in the week of Dec 30.
        (
            7,
            "2025-01-*",
            "2024-12-30--2025-01-05",
            ("2024-12-29T16:00:00+00:00", "2025-02-02T16:00:00+00:00"),
        ),
        (
            7,
            "2024-12-30--2025-01-05*",
            "2024-12-30--2025-01-05",
            ("2024-12-29T16:00:00+00:00", "2025-01-05T16:00:00+00:00"),
        ),
    ],
)
async def test_a_date_glob_moves_the_window_to_its_buckets(
    gcal_api, size, glob, listed, window, index
):
    accessor = make_accessor(bucket_days=size)
    out = await readdir(accessor, spec(f"/primary/{glob}", glob), index)
    assert listed in names(out)
    assert gcal_api.listed[-1][1:] == window


async def test_a_day_lists_one_file_per_overlapping_event(accessor, index):
    out = await readdir(accessor, spec("/primary/2026-08-11"), index)
    assert names(out) == [
        "aaaa1__0900-1030_PhD_Defense.gcal.json",
        "bbbb2__1500-1600_Committee_Meeting.gcal.json",
        "cccc3__0000-2400_Conference.gcal.json",
        "dddd4__0000-2400_Public_Holiday.gcal.json",
    ]


@pytest.mark.parametrize(
    "day, hhmm",
    [
        ("2026-08-10", "0900-2400"),
        ("2026-08-11", "0000-2400"),
        ("2026-08-12", "0000-2400"),
        ("2026-08-13", "0000-1700"),
    ],
)
async def test_a_multi_day_event_appears_under_every_day_it_covers(
    accessor, index, day, hhmm
):
    out = names(await readdir(accessor, spec(f"/primary/{day}"), index))
    assert f"cccc3__{hhmm}_Conference.gcal.json" in out
    # The all-day holiday's end date is exclusive: it stops at Aug 11.
    assert any("Public_Holiday" in n for n in out) is (day == "2026-08-11")


async def test_a_week_lists_its_days_in_one_query(gcal_api, index):
    out = await readdir(make_accessor(bucket_days=7), spec(WEEK), index)
    assert names(out) == [
        "aaaa1__2026-08-11_0900-1030_PhD_Defense.gcal.json",
        "bbbb2__2026-08-11_1500-1600_Committee_Meeting.gcal.json",
        "cccc3__2026-08-10_0900-2400_Conference.gcal.json",
        "cccc3__2026-08-11_0000-2400_Conference.gcal.json",
        "cccc3__2026-08-12_0000-2400_Conference.gcal.json",
        "cccc3__2026-08-13_0000-1700_Conference.gcal.json",
        "dddd4__2026-08-11_0000-2400_Public_Holiday.gcal.json",
    ]
    assert gcal_api.listed == [
        (
            "integ@example.com",
            "2026-08-10T00:00:00+08:00",
            "2026-08-17T00:00:00+08:00",
        )
    ]


async def test_a_scoped_week_lists_only_its_days_in_scope(index):
    accessor = make_accessor(
        bucket_days=7, start_time="2026-08-12T00:00:00+08:00"
    )
    assert names(await readdir(accessor, spec(WEEK), index)) == [
        "cccc3__2026-08-12_0000-2400_Conference.gcal.json",
        "cccc3__2026-08-13_0000-1700_Conference.gcal.json",
    ]


@pytest.mark.parametrize(
    "size, path",
    [(1, "/primary/2027-03-04"), (7, "/primary/2027-03-01--2027-03-07")],
)
async def test_a_bucket_with_no_events_lists_empty(size, path, index):
    assert (
        await readdir(make_accessor(bucket_days=size), spec(path), index) == []
    )


async def test_free_busy_calendar_renders_events_without_titles(
    accessor, index
):
    out = names(
        await readdir(
            accessor,
            spec("/Exec__busy@group.calendar.google.com/2026-08-11"),
            index,
        )
    )
    # The real API sends no summary on such a calendar; the fake strips it,
    # so this asserts the accessRole is what decides the rendering.
    assert out and all(n.endswith("_busy.gcal.json") for n in out)


@pytest.mark.parametrize(
    "config, path",
    [
        ({}, "/nope"),
        ({}, "/primary/not-a-date"),
        ({}, "/primary/2026-02-30"),
        ({}, "/primary/2026-08-11/x/y"),
        # Each bucket has one spelling per mount: a span on a day mount, a
        # bare day or an off-grid span on a week mount name nothing.
        ({}, WEEK),
        ({"bucket_days": 7}, "/primary/2026-08-11"),
        ({"bucket_days": 7}, "/primary/2026-08-11--2026-08-17"),
        ({"bucket_days": 7, "end_time": "2026-08-10T00:00:00+08:00"}, WEEK),
    ],
)
async def test_a_path_the_tree_does_not_hold_is_enoent(config, path, index):
    with pytest.raises(FileNotFoundError):
        await readdir(make_accessor(**config), spec(path), index)


async def test_min_access_role_filters_the_calendar_list(index):
    out = await readdir(
        make_accessor(min_access_role="owner"), spec("/"), index
    )
    assert names(out) == ["primary"]


async def test_unsearched_text_keeps_all_but_the_plain_words_the_search_reads():
    kept = unsearched_text(
        {
            "id": "x1",
            "summary": "Weekly sync-up",
            "description": "<b>Agenda</b> notes, (draft)",
            "status": "confirmed",
        }
    )
    assert kept == (
        '{"id":"x1","summary":"","description":"","status":"confirmed"}'
        " sync-up <b>agenda</b>"
    )

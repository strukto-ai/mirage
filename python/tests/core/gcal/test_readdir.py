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

from mirage.core.gcal.readdir import bucket_zone, calendar_index, readdir
from mirage.types import PathSpec

pytestmark = pytest.mark.asyncio

HK = "Asia/Hong_Kong"


def spec(virtual: str, pattern: str | None = None) -> PathSpec:
    directory = (virtual.rsplit("/", 1)[0] or "/") if pattern else virtual
    return PathSpec(virtual=virtual,
                    directory=directory,
                    resource_path=virtual.lstrip("/"),
                    pattern=pattern)


def names(paths: list[str]) -> list[str]:
    return [p.rsplit("/", 1)[-1] for p in paths]


async def test_root_lists_one_directory_per_calendar(api, accessor, index):
    out = await readdir(accessor, spec("/"), index)
    assert names(out) == [
        "Engineering__team@group.calendar.google.com",
        "Exec__busy@group.calendar.google.com",
        "primary",
    ]


async def test_primary_keeps_its_alias_and_others_carry_the_id(
        api, accessor, index):
    calendars = await calendar_index(accessor)
    assert calendars["primary"]["id"] == "integ@example.com"
    assert (calendars["Engineering__team@group.calendar.google.com"]["id"] ==
            "team@group.calendar.google.com")


async def test_bucket_zone_defaults_to_the_primary_calendar(api, accessor):
    calendars = await calendar_index(accessor)
    # Not the reader calendar's America/Los_Angeles: one zone mount-wide.
    assert bucket_zone(accessor, calendars) == HK


async def test_bucket_zone_honours_an_explicit_override(api, accessor):
    accessor.config = accessor.config.model_copy(
        update={"time_zone": "Europe/Berlin"})
    calendars = await calendar_index(accessor)
    assert bucket_zone(accessor, calendars) == "Europe/Berlin"


async def test_calendar_lists_only_days_holding_events(api, accessor, index):
    out = await readdir(accessor, spec("/primary"), index)
    assert names(out) == [
        "calendar.json",
        "2026-08-10",
        "2026-08-11",
        "2026-08-12",
        "2026-08-13",
    ]


async def test_calendar_listing_omits_days_outside_the_window(
        api, accessor, index):
    out = names(await readdir(accessor, spec("/primary"), index))
    # 2025-01-05 exists but sits far outside the -30/+90 day window.
    assert "2025-01-05" not in out


async def test_a_date_glob_escapes_the_default_window(api, accessor, index):
    out = await readdir(accessor, spec("/primary/2025-01-*", "2025-01-*"),
                        index)
    assert "2025-01-05" in names(out)
    listed = api.listed[-1]
    assert listed[1].startswith("2025-01-01")
    assert listed[2].startswith("2025-02-01")


async def test_day_lists_one_file_per_overlapping_event(api, accessor, index):
    out = names(await readdir(accessor, spec("/primary/2026-08-11"), index))
    assert out == [
        "aaaa1__0900-1030_PhD_Defense.gcal.json",
        "bbbb2__1500-1600_Committee_Meeting.gcal.json",
        "cccc3__0000-2400_Conference.gcal.json",
        "dddd4__0000-2400_Public_Holiday.gcal.json",
    ]


async def test_a_multi_day_event_appears_under_every_day_it_covers(
        api, accessor, index):
    for day, hhmm in (("2026-08-10", "0900-2400"), ("2026-08-11", "0000-2400"),
                      ("2026-08-12", "0000-2400"), ("2026-08-13",
                                                    "0000-1700")):
        out = names(await readdir(accessor, spec(f"/primary/{day}"), index))
        assert f"cccc3__{hhmm}_Conference.gcal.json" in out


async def test_an_all_day_event_does_not_leak_past_its_exclusive_end(
        api, accessor, index):
    out = names(await readdir(accessor, spec("/primary/2026-08-12"), index))
    assert not any("Public_Holiday" in n for n in out)


async def test_a_day_with_no_events_lists_empty(api, accessor, index):
    assert await readdir(accessor, spec("/primary/2027-03-04"), index) == []


async def test_free_busy_calendar_renders_events_without_titles(
        api, accessor, index):
    out = names(await readdir(
        accessor, spec("/Exec__busy@group.calendar.google.com/2026-08-11"),
        index))
    # The real API sends no summary on such a calendar; the fixture keeps
    # one, so this asserts the accessRole is what decides the rendering.
    assert all(n.endswith("_busy.gcal.json") for n in out)


async def test_unknown_calendar_is_enoent(api, accessor, index):
    with pytest.raises(FileNotFoundError):
        await readdir(accessor, spec("/nope"), index)


async def test_malformed_date_is_enoent(api, accessor, index):
    with pytest.raises(FileNotFoundError):
        await readdir(accessor, spec("/primary/not-a-date"), index)


async def test_too_deep_a_path_is_enoent(api, accessor, index):
    with pytest.raises(FileNotFoundError):
        await readdir(accessor, spec("/primary/2026-08-11/x/y"), index)


async def test_min_access_role_filters_the_calendar_list(api, accessor, index):
    accessor.config = accessor.config.model_copy(
        update={"min_access_role": "owner"})
    out = names(await readdir(accessor, spec("/"), index))
    assert out == ["primary"]

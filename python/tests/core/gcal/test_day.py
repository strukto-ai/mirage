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

from datetime import date, datetime

import pytest

from mirage.core.gcal.day import (
    DEFAULT_TZ,
    bucket_name,
    bucket_start,
    clamped_hhmm,
    day_bounds,
    days_covered,
    event_span,
    local_midnight,
    parse_bucket,
    slot_instant,
    valid_bucket,
    valid_day,
    window_bounds,
    zone,
)
from tests.fixtures.gcal_api import event

HK = "Asia/Hong_Kong"
LA = "America/Los_Angeles"
CONFERENCE = event(
    "c", "", "2026-08-10T09:00:00+08:00", "2026-08-13T17:00:00+08:00"
)
HOLIDAY = event("d", "", "2026-08-11", "2026-08-12")
LA_EVENING = event(
    "e", "", "2026-08-11T20:00:00-07:00", "2026-08-11T21:00:00-07:00"
)


def span_of(item: dict, tz: str) -> tuple[datetime, datetime]:
    span = event_span(item, tz)
    assert span is not None
    return span


def test_unknown_zone_falls_back_to_utc():
    assert str(zone("Not/AZone")) == DEFAULT_TZ
    assert str(zone(HK)) == HK


@pytest.mark.parametrize(
    "day, tz, days, hours",
    [
        ("2026-08-11", HK, 1, 24),
        # Los Angeles leaves DST on 2026-11-01 and enters it on 2026-03-08:
        # a fixed 24h would drop or double the hour the clocks move.
        ("2026-11-01", LA, 1, 25),
        ("2026-03-08", LA, 1, 23),
        ("2026-10-26", LA, 7, 7 * 24 + 1),
    ],
)
def test_day_bounds_run_between_local_midnights(day, tz, days, hours):
    lo, hi = day_bounds(day, tz, days)
    assert lo == local_midnight(day, tz).isoformat()
    span = datetime.fromisoformat(hi) - datetime.fromisoformat(lo)
    assert span.total_seconds() == hours * 3600


def test_day_bounds_carry_the_zone_offset():
    assert day_bounds("2026-08-11", HK) == (
        "2026-08-11T00:00:00+08:00",
        "2026-08-12T00:00:00+08:00",
    )


@pytest.mark.parametrize(
    "size, hi",
    [
        (1, "2026-11-10T00:00:00+08:00"),
        (7, "2026-11-16T00:00:00+08:00"),
        (30, "2026-12-07T00:00:00+08:00"),
    ],
)
def test_window_ends_with_the_bucket_holding_the_horizon(size, hi):
    assert window_bounds(date(2026, 8, 11), HK, size) == (None, hi)


@pytest.mark.parametrize(
    "day, size, start",
    [
        ("2026-08-13", 1, "2026-08-13"),
        ("2026-08-10", 7, "2026-08-10"),
        ("2026-08-16", 7, "2026-08-10"),
        ("2026-08-17", 7, "2026-08-17"),
        ("2026-08-13", 30, "2026-08-09"),
        ("2026-09-07", 30, "2026-08-09"),
        ("2026-09-08", 30, "2026-09-08"),
        # Before the epoch the grid keeps its phase: still Monday to Sunday.
        ("1969-12-31", 7, "1969-12-29"),
        # The era's first bucket is cut short rather than starting before it.
        ("0001-01-02", 30, "0001-01-01"),
    ],
)
def test_buckets_tile_a_fixed_grid(day, size, start):
    assert bucket_start(date.fromisoformat(day), size) == date.fromisoformat(
        start
    )


@pytest.mark.parametrize(
    "start, size, name",
    [
        ("2026-08-11", 1, "2026-08-11"),
        ("2026-08-10", 7, "2026-08-10--2026-08-16"),
        ("2026-08-09", 30, "2026-08-09--2026-09-07"),
    ],
)
def test_a_bucket_is_named_by_its_first_and_last_day(start, size, name):
    assert bucket_name(date.fromisoformat(start), size) == name
    assert parse_bucket(name, size) == date.fromisoformat(start)


@pytest.mark.parametrize(
    "name, size",
    [
        # One spelling per bucket and mount: a bare day on a multi-day
        # mount, a span on a one-day mount, a span off the grid or of the
        # wrong length all spell none.
        ("2026-08-10", 7),
        ("2026-08-10--2026-08-16", 1),
        ("2026-08-11--2026-08-17", 7),
        ("2026-08-10--2026-08-15", 7),
        ("2026-02-30", 1),
    ],
)
def test_parse_bucket_refuses_every_other_spelling(name, size):
    assert parse_bucket(name, size) is None


@pytest.mark.parametrize(
    "name, ok",
    [
        ("2026-02-11", True),
        ("2026-08-10--2026-08-16", True),
        # Date-shaped is not enough: letting 2026-02-30 through made stat
        # report a directory that every later call raised ValueError on.
        ("2026-02-30", False),
        ("2026-13-01", False),
        ("2026-08-10--2026-02-30", False),
        ("2026-08-10--", False),
        ("not-a-date", False),
    ],
)
def test_valid_bucket_wants_real_dates(name, ok):
    assert valid_bucket(name) is ok
    assert valid_day(name) is (ok and "--" not in name)


def test_event_span_parses_offsets_and_z():
    span = span_of(
        event("x", "", "2026-08-11T09:00:00+08:00", "2026-08-11T02:30:00Z"),
        HK,
    )
    assert span == (
        datetime.fromisoformat("2026-08-11T01:00:00+00:00"),
        datetime.fromisoformat("2026-08-11T02:30:00+00:00"),
    )


def test_event_span_reads_all_day_dates_in_the_bucketing_zone():
    assert span_of(HOLIDAY, HK) == (
        local_midnight("2026-08-11", HK),
        local_midnight("2026-08-12", HK),
    )


def test_event_span_is_none_without_usable_slots():
    assert event_span({"start": {}, "end": {}}, HK) is None
    assert event_span({"start": "nope", "end": {}}, HK) is None


@pytest.mark.parametrize(
    "item, tz, days",
    [
        # end.date is EXCLUSIVE: start=D end=D+1 is one day, not two.
        (HOLIDAY, HK, ["2026-08-11"]),
        (
            event("x", "", "2026-08-11", "2026-08-14"),
            HK,
            ["2026-08-11", "2026-08-12", "2026-08-13"],
        ),
        (
            CONFERENCE,
            HK,
            ["2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13"],
        ),
        (
            event(
                "x",
                "",
                "2026-08-11T23:00:00+08:00",
                "2026-08-12T00:00:00+08:00",
            ),
            HK,
            ["2026-08-11"],
        ),
        (
            event(
                "x",
                "",
                "2026-08-11T09:00:00+08:00",
                "2026-08-11T09:00:00+08:00",
            ),
            HK,
            ["2026-08-11"],
        ),
        # 20:00 in Los Angeles on Aug 11 is 03:00Z on Aug 12: the bucketing
        # zone decides the day.
        (LA_EVENING, LA, ["2026-08-11"]),
        (LA_EVENING, "UTC", ["2026-08-12"]),
    ],
    ids=[
        "one-day-all-day",
        "multi-day-all-day",
        "timed-span",
        "ends-at-midnight",
        "zero-length",
        "la-zone",
        "utc-zone",
    ],
)
def test_days_covered(item, tz, days):
    assert days_covered(span_of(item, tz), tz) == days


@pytest.mark.parametrize(
    "item, day, hhmm",
    [
        (
            event(
                "x",
                "",
                "2026-08-11T09:00:00+08:00",
                "2026-08-11T10:30:00+08:00",
            ),
            "2026-08-11",
            "0900-1030",
        ),
        (CONFERENCE, "2026-08-10", "0900-2400"),
        (CONFERENCE, "2026-08-11", "0000-2400"),
        (CONFERENCE, "2026-08-13", "0000-1700"),
        (HOLIDAY, "2026-08-11", "0000-2400"),
    ],
)
def test_clamped_hhmm_reads_local_times_clamped_to_the_day(item, day, hhmm):
    assert clamped_hhmm(span_of(item, HK), day, HK) == hhmm


@pytest.mark.parametrize(
    "slot, tz",
    [
        # Google requires an offset on dateTime UNLESS the slot names its
        # own zone; without one either, the bucket zone is the answer.
        ({"dateTime": "2026-08-11T09:00:00", "timeZone": HK}, "UTC"),
        ({"dateTime": "2026-08-11T09:00:00"}, HK),
    ],
)
def test_a_zone_less_datetime_is_read_in_a_zone(slot, tz):
    assert slot_instant(slot, tz) == datetime.fromisoformat(
        "2026-08-11T01:00:00+00:00"
    )


def test_a_zone_less_event_buckets_without_raising():
    # A naive instant used to reach clamped_hhmm and blow up comparing
    # against the aware local midnights.
    item = {
        "start": {"dateTime": "2026-08-11T09:00:00", "timeZone": HK},
        "end": {"dateTime": "2026-08-11T10:30:00", "timeZone": HK},
    }
    span = span_of(item, "UTC")
    assert days_covered(span, HK) == ["2026-08-11"]
    assert clamped_hhmm(span, "2026-08-11", HK) == "0900-1030"


@pytest.mark.parametrize(
    "slot",
    [
        {"date": "2026-02-30"},
        {"dateTime": "unreadable"},
        {"dateTime": "2026-02-30T03:02:01Z"},
        {"dateTime": "2026-04-01T24:00:00"},
    ],
)
def test_invalid_event_slot_is_absent(slot):
    assert slot_instant(slot, "UTC") is None

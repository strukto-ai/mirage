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

from mirage.core.gcal.day import (DEFAULT_TZ, clamped_hhmm, day_bounds,
                                  days_covered, event_span, is_all_day,
                                  local_midnight, slot_instant, valid_day,
                                  window_bounds, zone)

HK = "Asia/Hong_Kong"
LA = "America/Los_Angeles"


def _timed(start: str, end: str) -> dict:
    return {"start": {"dateTime": start}, "end": {"dateTime": end}}


def _all_day(start: str, end: str) -> dict:
    return {"start": {"date": start}, "end": {"date": end}}


def test_unknown_zone_falls_back_to_utc():
    assert str(zone("Not/AZone")) == DEFAULT_TZ
    assert str(zone(HK)) == HK


def test_day_bounds_are_consecutive_local_midnights():
    lo, hi = day_bounds("2026-08-11", HK)
    assert lo == "2026-08-11T00:00:00+08:00"
    assert hi == "2026-08-12T00:00:00+08:00"


def test_day_bounds_span_25_hours_on_a_dst_fall_back():
    # America/Los_Angeles leaves DST on 2026-11-01, making that local day 25
    # hours. Adding a fixed 24h would drop the repeated hour's events.
    lo, hi = day_bounds("2026-11-01", LA)
    delta = datetime.fromisoformat(hi) - datetime.fromisoformat(lo)
    assert delta.total_seconds() == 25 * 3600


def test_day_bounds_span_23_hours_on_a_dst_spring_forward():
    lo, hi = day_bounds("2026-03-08", LA)
    delta = datetime.fromisoformat(hi) - datetime.fromisoformat(lo)
    assert delta.total_seconds() == 23 * 3600


def test_window_bounds_bracket_the_day():
    lo, hi = window_bounds(date(2026, 8, 11), HK)
    assert lo == "2026-07-12T00:00:00+08:00"
    assert hi == "2026-11-10T00:00:00+08:00"


def test_is_all_day_reads_the_slot_shape():
    assert is_all_day({"date": "2026-08-11"})
    assert not is_all_day({"dateTime": "2026-08-11T09:00:00+08:00"})


def test_event_span_parses_offsets_and_z():
    span = event_span(
        _timed("2026-08-11T09:00:00+08:00", "2026-08-11T02:30:00Z"), HK)
    assert span is not None
    assert span[0] == datetime.fromisoformat("2026-08-11T01:00:00+00:00")
    assert span[1] == datetime.fromisoformat("2026-08-11T02:30:00+00:00")


def test_event_span_reads_all_day_dates_in_the_bucketing_zone():
    span = event_span(_all_day("2026-08-11", "2026-08-12"), HK)
    assert span is not None
    assert span[0] == local_midnight("2026-08-11", HK)
    assert span[1] == local_midnight("2026-08-12", HK)


def test_event_span_is_none_without_usable_slots():
    assert event_span({"start": {}, "end": {}}, HK) is None
    assert event_span({"start": "nope", "end": {}}, HK) is None


def test_single_day_all_day_event_covers_one_day_only():
    # end.date is EXCLUSIVE, so start=D end=D+1 is a one-day event and must
    # not leak into D+1's directory.
    span = event_span(_all_day("2026-08-11", "2026-08-12"), HK)
    assert span is not None
    assert days_covered(span, HK) == ["2026-08-11"]


def test_multi_day_all_day_event_covers_each_day():
    span = event_span(_all_day("2026-08-11", "2026-08-14"), HK)
    assert span is not None
    assert days_covered(span, HK) == ["2026-08-11", "2026-08-12", "2026-08-13"]


def test_timed_event_covers_every_day_it_spans():
    span = event_span(
        _timed("2026-08-10T09:00:00+08:00", "2026-08-13T17:00:00+08:00"), HK)
    assert span is not None
    assert days_covered(
        span, HK) == ["2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13"]


def test_event_ending_exactly_at_midnight_stops_at_the_day_it_started():
    span = event_span(
        _timed("2026-08-11T23:00:00+08:00", "2026-08-12T00:00:00+08:00"), HK)
    assert span is not None
    assert days_covered(span, HK) == ["2026-08-11"]


def test_zero_length_event_still_occupies_its_day():
    span = event_span(
        _timed("2026-08-11T09:00:00+08:00", "2026-08-11T09:00:00+08:00"), HK)
    assert span is not None
    assert days_covered(span, HK) == ["2026-08-11"]


def test_bucketing_zone_decides_the_day():
    # 20:00 in Los Angeles on Aug 11 is 03:00Z on Aug 12: bucketed in the
    # calendar's zone it is Aug 11, bucketed in UTC it would be Aug 12.
    span = event_span(
        _timed("2026-08-11T20:00:00-07:00", "2026-08-11T21:00:00-07:00"), LA)
    assert span is not None
    assert days_covered(span, LA) == ["2026-08-11"]
    assert days_covered(span, "UTC") == ["2026-08-12"]


def test_clamped_hhmm_reports_local_times():
    span = event_span(
        _timed("2026-08-11T09:00:00+08:00", "2026-08-11T10:30:00+08:00"), HK)
    assert span is not None
    assert clamped_hhmm(span, "2026-08-11", HK) == "0900-1030"


def test_clamped_hhmm_clamps_a_spanning_event_to_the_whole_day():
    span = event_span(
        _timed("2026-08-10T09:00:00+08:00", "2026-08-13T17:00:00+08:00"), HK)
    assert span is not None
    assert clamped_hhmm(span, "2026-08-10", HK) == "0900-2400"
    assert clamped_hhmm(span, "2026-08-11", HK) == "0000-2400"
    assert clamped_hhmm(span, "2026-08-13", HK) == "0000-1700"


def test_clamped_hhmm_spells_an_all_day_event_as_the_full_day():
    span = event_span(_all_day("2026-08-11", "2026-08-12"), HK)
    assert span is not None
    assert clamped_hhmm(span, "2026-08-11", HK) == "0000-2400"


def test_valid_day_rejects_a_date_shaped_non_date():
    # Regex-shaped but impossible: letting it through made stat report a
    # directory that every later call raised ValueError on.
    assert valid_day("2026-02-11")
    assert not valid_day("2026-02-30")
    assert not valid_day("2026-13-01")
    assert not valid_day("not-a-date")


def test_zone_less_datetime_uses_the_slots_declared_zone():
    # Google requires an offset on dateTime UNLESS the slot names a zone.
    slot = {"dateTime": "2026-08-11T09:00:00", "timeZone": "Asia/Hong_Kong"}
    got = slot_instant(slot, "UTC")
    assert got is not None and got.tzinfo is not None
    assert got == datetime.fromisoformat("2026-08-11T01:00:00+00:00")


def test_zone_less_datetime_without_a_declared_zone_uses_the_bucket_zone():
    got = slot_instant({"dateTime": "2026-08-11T09:00:00"}, HK)
    assert got is not None
    assert got == datetime.fromisoformat("2026-08-11T01:00:00+00:00")


def test_a_zone_less_event_buckets_without_raising():
    # A naive instant here used to reach clamped_hhmm and blow up comparing
    # against the aware local midnights ("can't compare offset-naive and
    # offset-aware datetimes").
    event = {
        "start": {
            "dateTime": "2026-08-11T09:00:00",
            "timeZone": HK
        },
        "end": {
            "dateTime": "2026-08-11T10:30:00",
            "timeZone": HK
        },
    }
    span = event_span(event, "UTC")
    assert span is not None
    assert days_covered(span, HK) == ["2026-08-11"]
    assert clamped_hhmm(span, "2026-08-11", HK) == "0900-1030"

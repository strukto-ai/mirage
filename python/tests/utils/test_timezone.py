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

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from mirage.commands.builtin.utils.strftime import gnu_strftime
from mirage.utils.timezone import (PosixZone, TransitionRule,
                                   numeric_abbreviation, posix_zone,
                                   resolve_tz, zone_abbreviations,
                                   zone_from_env)

ROOT = Path(__file__).resolve().parents[3]
TZ_ABBREVS_TS = (ROOT / "typescript" / "packages" / "core" / "src" / "utils" /
                 "tz_abbrevs.ts")

# Pinned against GNU date 9.7 (glibc 2.41) on debian:stable-slim with
# tzdata installed: `TZ=<spec> date -d @<epoch> '+%Y-%m-%d %H:%M:%S %z %Z'`.
EPOCH = 0
SUMMER = 1751328000
WINTER = 1735689600
JULY_2024 = 1720000000
NOVEMBER_2023 = 1700000000


def render(spec: str, epoch: int, fmt: str = "%Y-%m-%d %H:%M:%S %z %Z") -> str:
    return gnu_strftime(datetime.fromtimestamp(epoch, tz=resolve_tz(spec)),
                        fmt)


@pytest.mark.parametrize(
    "spec,epoch,expected",
    [
        ("UTC", EPOCH, "1970-01-01 00:00:00 +0000 UTC"),
        ("Asia/Hong_Kong", EPOCH, "1970-01-01 08:00:00 +0800 HKT"),
        ("America/Los_Angeles", EPOCH, "1969-12-31 16:00:00 -0800 PST"),
        ("America/Los_Angeles", SUMMER, "2025-06-30 17:00:00 -0700 PDT"),
        (":Asia/Tokyo", EPOCH, "1970-01-01 09:00:00 +0900 JST"),
        ("Asia/Kolkata", EPOCH, "1970-01-01 05:30:00 +0530 IST"),
        ("Etc/GMT+5", EPOCH, "1969-12-31 19:00:00 -0500 -05"),
        ("EST5EDT", SUMMER, "2025-06-30 20:00:00 -0400 EDT"),
        ("EST5EDT", WINTER, "2024-12-31 19:00:00 -0500 EST"),
        ("Europe/London", EPOCH, "1970-01-01 01:00:00 +0100 BST"),
        ("Europe/London", WINTER, "2025-01-01 00:00:00 +0000 GMT"),
        # A zone's own history: one offset under two names over the years.
        ("Europe/Moscow", 1276848800, "2010-06-18 12:13:20 +0400 MSD"),
        ("Europe/Moscow", 1340000000, "2012-06-18 10:13:20 +0400 MSK"),
        ("Europe/Moscow", 1301180399, "2011-03-27 01:59:59 +0300 MSK"),
        ("Europe/Moscow", 1301180400, "2011-03-27 03:00:00 +0400 MSK"),
        ("Europe/Istanbul", 1435752000, "2015-07-01 15:00:00 +0300 EEST"),
        ("Europe/Istanbul", 1498906800, "2017-07-01 14:00:00 +0300 +03"),
    ])
def test_tzdata_names(spec: str, epoch: int, expected: str) -> None:
    assert render(spec, epoch) == expected


@pytest.mark.parametrize(
    "spec,epoch,expected",
    [
        ("UTC0", EPOCH, "1970-01-01 00:00:00 +0000 UTC"),
        ("EST5", EPOCH, "1969-12-31 19:00:00 -0500 EST"),
        ("JST-9", EPOCH, "1970-01-01 09:00:00 +0900 JST"),
        ("<+0530>-5:30", EPOCH, "1970-01-01 05:30:00 +0530 +0530"),
        ("<+0530>-5:30:30", EPOCH, "1970-01-01 05:30:30 +0530 +0530"),
        ("CET-1CEST,M3.5.0,M10.5.0/3", EPOCH, "1970-01-01 01:00:00 +0100 CET"),
        ("CET-1CEST,M3.5.0,M10.5.0/3", SUMMER,
         "2025-07-01 02:00:00 +0200 CEST"),
        ("CET-1CEST,M3.5.0,M10.5.0/3", WINTER,
         "2025-01-01 01:00:00 +0100 CET"),
        ("CET-1CEST,M03.05.00,M10.5.0", SUMMER,
         "2025-07-01 02:00:00 +0200 CEST"),
        ("CET-1CEST,J60,J300/1", SUMMER, "2025-07-01 02:00:00 +0200 CEST"),
        ("CET-1CEST,59,299", SUMMER, "2025-07-01 02:00:00 +0200 CEST"),
        ("EST5EDT,M3.2.0,M11.1.0", SUMMER, "2025-06-30 20:00:00 -0400 EDT"),
        ("AEST-10AEDT,M10.1.0,M4.1.0/3", EPOCH,
         "1970-01-01 11:00:00 +1100 AEDT"),
        ("AEST-10AEDT,M10.1.0,M4.1.0/3", SUMMER,
         "2025-07-01 10:00:00 +1000 AEST"),
        ("AEST-10AEDT,M10.1.0,M4.1.0/3", WINTER,
         "2025-01-01 11:00:00 +1100 AEDT"),
        ("XXX3YYY", EPOCH, "1969-12-31 21:00:00 -0300 XXX"),
        ("XXX3YYY", SUMMER, "2025-06-30 22:00:00 -0200 YYY"),
        # Coinciding offsets still name their halves by the rules.
        ("CET-1CEST-1,J1,J1", JULY_2024, "2024-07-03 10:46:40 +0100 CET"),
    ])
def test_posix_strings(spec: str, epoch: int, expected: str) -> None:
    assert render(spec, epoch) == expected


@pytest.mark.parametrize("spec,expected", [
    ("Bogus/Zone", "1970-01-01 00:00:00 +0000 Bogus"),
    ("XYZ", "1970-01-01 00:00:00 +0000 XYZ"),
    ("Z", "1970-01-01 00:00:00 +0000 "),
    ("", "1970-01-01 00:00:00 +0000 UTC"),
])
def test_glibc_fallbacks(spec: str, expected: str) -> None:
    # glibc reads an unknown name as a POSIX string with no offset, so
    # it renders UTC under that name; a name under three letters is
    # refused and leaves %Z empty; an empty TZ is UTC (glibc spells
    # that one `Universal`, the one abbreviation here that differs).
    assert render(spec, EPOCH) == expected


# glibc keeps what it had read of a rule it refuses, never reads the rule
# after it, and keeps a daylight half whose name it cannot read as
# nameless UTC; nothing falls back to plain UTC. Every line is GNU's.
@pytest.mark.parametrize("spec,epoch,expected", [
    ("CET-1CEST,bogus", JULY_2024, "+0200 CEST"),
    ("CET-1CEST,bogus", WINTER, "+0200 CEST"),
    ("CET-1CEST,M3.5.0,M13.1.0", NOVEMBER_2023, "+0200 CEST"),
    ("CET-1CEST,M3.5.0,M13.1.0", WINTER, "+0100 CET"),
    ("CET-1CEST,M3.6.0,M10.5.0", JULY_2024, "+0200 CEST"),
    ("CET-1CEST,M3.0.0,M10.5.0", JULY_2024, "+0200 CEST"),
    ("CET-1CEST,M3.5.7,M10.5.0", JULY_2024, "+0200 CEST"),
    ("CET-1CEST,J0,J300", JULY_2024, "+0100 CET"),
    ("CET-1CEST,J0,J300", WINTER, "+0100 CET"),
    ("CET-1CEST,J366,J300", JULY_2024, "+0100 CET"),
    ("CET-1CEST,J1,J366", JULY_2024, "+0200 CEST"),
    ("CET-1CEST,0,366", JULY_2024, "+0200 CEST"),
    ("CET-1CEST,366,100", JULY_2024, "+0200 CEST"),
    ("CET-1CEST,366,100", WINTER, "+0200 CEST"),
    ("CET-1CEST,M3.5.0", JULY_2024, "+0200 CEST"),
    ("CET-1CEST,M3.5.0", NOVEMBER_2023, "+0100 CET"),
    ("CET-1CEST,", JULY_2024, "+0200 CEST"),
    ("CET-1CEST", JULY_2024, "+0200 CEST"),
    ("CET-1CEST,M3.5.0,M10.5.0/3x", NOVEMBER_2023, "+0100 CET"),
    ("CET-1CEST,M3.5.0/x,M10.5.0", NOVEMBER_2023, "+0200 CEST"),
    ("CET-1CEST,M3.5.0,M10.5.0/25", JULY_2024, "+0200 CEST"),
    ("CET-1CEST,M3.5.0/-1,M10.5.0", JULY_2024, "+0200 CEST"),
    ("CET-1CEST,M3.5.0x,M10.5.0", JULY_2024, "+0200 CEST"),
    ("CET-1CEST,M3.5.0/,M10.5.0", JULY_2024, "+0200 CEST"),
    ("CET-1CEST,M3.6.0,M10.5.0", WINTER, "+0100 CET"),
    ("CET-1CEST-1,M3.5.0,M10.5.0", JULY_2024, "+0100 CEST"),
    ("CET-1CEST-1,M3.5.0,M10.5.0", NOVEMBER_2023, "+0100 CET"),
    ("CET-1CESTM3.5.0,M10.5.0", JULY_2024, "+0100 CET"),
    ("EST5x", NOVEMBER_2023, "+0000 "),
    ("EST5x", JULY_2024, "+0000 "),
    ("EST5,M3.2.0,M11.1.0", JULY_2024, "+0000 "),
    ("EST5,M3.2.0,M11.1.0", WINTER, "-0500 EST"),
])
def test_glibc_keeps_what_it_read_of_a_refused_rule(spec: str, epoch: int,
                                                    expected: str) -> None:
    assert render(spec, epoch, "%z %Z") == expected


@pytest.mark.parametrize("spec,epoch,expected", [
    ("CET-1CEST,M13.1.0,M1.1.0", NOVEMBER_2023, "+0100 CET"),
    ("CET-1CEST,M13.1.0,M1.1.0", JULY_2024, "+0100 CET"),
    ("CET-1CEST,M0.5.0,M10.5.0", JULY_2024, "+0100 CET"),
])
def test_month_outside_the_table_is_the_refused_julian_rule(
        spec: str, epoch: int, expected: str) -> None:
    # glibc reads past its month table for a month outside 1 to 12;
    # mirage reads the refused rule as Julian day 0 instead, which is
    # what Debian's glibc happens to print for these too.
    assert render(spec, epoch, "%z %Z") == expected


@pytest.mark.parametrize("spec,expected", [
    ("UTC5:99", "1969-12-31 18:01:00 -0559 UTC"),
    ("UTC5:30:99", "1969-12-31 18:29:01 -0530 UTC"),
    ("UTC5:9", "1969-12-31 18:51:00 -0509 UTC"),
    ("UTC23:59:59", "1969-12-31 00:00:01 -2359 UTC"),
])
def test_offset_fields_clamp_as_glibc_clamps_them(spec: str,
                                                  expected: str) -> None:
    assert render(spec, EPOCH) == expected


@pytest.mark.parametrize("spec,expected", [
    ("UTC24", "1969-12-31 00:00:01 -2359 UTC"),
    ("UTC25", "1969-12-31 00:00:01 -2359 UTC"),
    ("UTC1234", "1969-12-31 00:00:01 -2359 UTC"),
    ("UTC-24", "1970-01-01 23:59:59 +2359 UTC"),
])
def test_a_full_day_offset_stops_one_second_short(spec: str,
                                                  expected: str) -> None:
    # glibc clamps the hours at 24 and prints `-2400` for all of these;
    # a tzinfo cannot carry a full day, so both hosts stop a second
    # short of it, the one documented divergence.
    assert render(spec, EPOCH) == expected


def test_zone_from_env_reads_only_the_command_environment() -> None:
    assert zone_from_env(None) is None
    assert zone_from_env({}) is None
    assert zone_from_env({"TZ": "UTC"}) is timezone.utc or str(
        zone_from_env({"TZ": "UTC"})) == "UTC"
    hong_kong = zone_from_env({"TZ": "Asia/Hong_Kong"})
    assert hong_kong is not None
    assert datetime.fromtimestamp(0, tz=hong_kong).hour == 8


def test_posix_zone_resolves_a_repeated_hour_to_standard_time() -> None:
    # glibc's mktime: 02:30 on the night CEST ends is the later
    # instant, 02:30 CET, unless `fold` says the earlier one.
    zone = resolve_tz("CET-1CEST,M3.5.0,M10.5.0/3")
    later = datetime(2025, 10, 26, 2, 30, tzinfo=zone, fold=1)
    earlier = datetime(2025, 10, 26, 2, 30, tzinfo=zone)
    assert later.timestamp() == 1761442200
    assert later.tzname() == "CET"
    assert earlier.timestamp() == 1761438600
    assert earlier.tzname() == "CEST"


def test_posix_zone_marks_the_second_reading_with_fold() -> None:
    zone = resolve_tz("CET-1CEST,M3.5.0,M10.5.0/3")
    first = datetime.fromtimestamp(1761438600, tz=zone)
    second = datetime.fromtimestamp(1761442200, tz=zone)
    assert (first.hour, first.minute, first.fold) == (2, 30, 0)
    assert (second.hour, second.minute, second.fold) == (2, 30, 1)
    assert first.utcoffset() == timedelta(hours=2)
    assert second.utcoffset() == timedelta(hours=1)


def test_posix_zone_skipped_hour_reads_under_standard_time() -> None:
    zone = resolve_tz("CET-1CEST,M3.5.0,M10.5.0/3")
    gap = datetime(2025, 3, 30, 2, 30, tzinfo=zone)
    assert gap.utcoffset() == timedelta(hours=1)
    assert gap.dst() == timedelta(0)


def test_transition_rule_shapes() -> None:
    last_sunday_march = TransitionRule("M", month=3, week=5, weekday=0)
    assert last_sunday_march.at(2025) == datetime(2025, 3, 30, 2)
    first_sunday_november = TransitionRule("M", month=11, week=1, weekday=0)
    assert first_sunday_november.at(2025) == datetime(2025, 11, 2, 2)
    # J60 is March 1 whatever the year: February 29 is never counted.
    assert TransitionRule("J", day=60).at(2024) == datetime(2024, 3, 1, 2)
    assert TransitionRule("J", day=60).at(2025) == datetime(2025, 3, 1, 2)
    # A bare day is zero-based and counts February 29.
    assert TransitionRule("D", day=59).at(2024) == datetime(2024, 2, 29, 2)
    assert TransitionRule("D", day=59).at(2025) == datetime(2025, 3, 1, 2)
    assert TransitionRule("M", month=10, week=5, weekday=0,
                          seconds=3 * 3600).at(2025) == datetime(
                              2025, 10, 26, 3)


def test_transition_rule_counts_refused_fields_as_glibc_does() -> None:
    # Week 0 is the first such weekday; a weekday past 6 counts on from
    # the month's first day, so 7 is the second Sunday of a month that
    # starts on one (September 2024) and the first of any other; Julian
    # day 0 is the day before January 1. All are states glibc leaves.
    assert TransitionRule("M", month=3, week=0, weekday=0,
                          seconds=0).at(2024) == datetime(2024, 3, 3)
    assert TransitionRule("M", month=3, week=5, weekday=7,
                          seconds=0).at(2024) == datetime(2024, 3, 31)
    assert TransitionRule("M", month=9, week=1, weekday=7,
                          seconds=0).at(2024) == datetime(2024, 9, 8)
    assert TransitionRule("M", month=3, week=1, weekday=7,
                          seconds=0).at(2024) == datetime(2024, 3, 3)
    assert TransitionRule("J", day=0,
                          seconds=0).at(2024) == datetime(2023, 12, 31)


def test_posix_zone_default_rule_is_the_us_one() -> None:
    for spec in ("XXX3YYY", "XXX3YYY,", "XXX3YYY,M3.2.0"):
        zone = posix_zone(spec)
        assert isinstance(zone, PosixZone)
        assert datetime.fromtimestamp(SUMMER, tz=zone).tzname() == "YYY"
        assert datetime.fromtimestamp(WINTER, tz=zone).tzname() == "XXX"


# ── %Z: tzdata's abbreviations, and the table the TypeScript twin ships ──


@pytest.mark.parametrize("offset,expected", [
    (0, "+00"),
    (28800, "+08"),
    (-10800, "-03"),
    (19800, "+0530"),
    (31500, "+0845"),
    (-34200, "-0930"),
])
def test_numeric_abbreviation_spells_the_offset_as_tzdata_does(
        offset, expected):
    assert numeric_abbreviation(offset) == expected


@pytest.mark.parametrize("name,expected", [
    ("Asia/Hong_Kong", [(28800, "HKT", 0), (32400, "HKST", 9315000)]),
    ("Europe/London", [(3600, "BST", 0), (0, "GMT", 57722400)]),
    ("Australia/Sydney", [(36000, "AEST", 0), (39600, "AEDT", 57686400)]),
    ("Asia/Kolkata", [(19800, "IST", 0)]),
    ("EST5EDT", [(-18000, "EST", 0), (-14400, "EDT", 9961200)]),
    ("UTC", [(0, "UTC", 0)]),
    ("Asia/Singapore", []),
    ("America/Sao_Paulo", []),
    ("Etc/GMT+5", []),
])
def test_zone_abbreviations_dates_each_name_and_skips_numeric_zones(
        name, expected):
    # The `since` of a row is the transition second, found between the
    # daily samples: Hong Kong's 1970 summer time began at 9315000.
    assert zone_abbreviations(name) == expected


def test_zone_abbreviations_keeps_every_name_an_offset_carried():
    moscow = zone_abbreviations("Europe/Moscow")
    assert moscow.index((14400, "MSD", 354920400)) < moscow.index(
        (14400, "MSK", 1301180400))
    assert (10800, "EEST", 670374000) in moscow
    # A numeric spelling that followed letters at the same offset is a
    # row too, else Istanbul's +03 would read EEST after 2016.
    istanbul = zone_abbreviations("Europe/Istanbul")
    assert (10800, "EEST", 482799600) in istanbul
    assert istanbul[-1] == (10800, "+03", 1473195600)


def _committed_table() -> dict[str, list[tuple[int, str, int]]]:
    text = re.sub(r"\s+", " ", TZ_ABBREVS_TS.read_text(encoding="utf-8"))
    rows: dict[str, list[tuple[int, str, int]]] = {}
    # prettier leaves an identifier-like key bare (`CET:`), quotes the rest.
    row = (r"(?:'([^']+)'|([A-Za-z_$][A-Za-z0-9_$]*)): "
           r"\[\s*((?:\[-?\d+, '[^']*', \d+\],?\s*)+)\]")
    for quoted, bare, cells in re.findall(row, text):
        rows[quoted or bare] = [(int(offset), abbrev, int(since))
                                for offset, abbrev, since in re.findall(
                                    r"\[(-?\d+), '([^']*)', (\d+)\]", cells)]
    return rows


# The TypeScript `date` renders %Z from this table because Intl has no
# tzdata names; scripts/gen_tz_abbrevs.py regenerates it. These zones
# are the ones a golden is likely to name, and their abbreviations have
# not moved in years, so a mismatch here means the table is stale.
@pytest.mark.parametrize("name", [
    "Asia/Hong_Kong",
    "Asia/Kolkata",
    "Asia/Tokyo",
    "Australia/Sydney",
    "Europe/London",
    "Europe/Berlin",
    "Europe/Moscow",
    "Europe/Istanbul",
    "America/New_York",
    "America/Los_Angeles",
    "America/St_Johns",
    "Africa/Johannesburg",
    "Pacific/Auckland",
    "EST5EDT",
    "UTC",
])
def test_committed_tz_abbrevs_table_matches_zoneinfo(name):
    assert _committed_table()[name] == zone_abbreviations(name)


def test_committed_tz_abbrevs_table_has_no_row_for_a_numeric_zone():
    table = _committed_table()
    assert "Asia/Singapore" not in table
    assert "America/Sao_Paulo" not in table
    assert "Etc/GMT+5" not in table

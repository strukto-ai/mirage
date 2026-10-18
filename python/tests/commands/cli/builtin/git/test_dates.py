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
from dataclasses import replace
from datetime import timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from mirage.commands.cli.builtin.git import dates
from mirage.commands.cli.builtin.git.dates import (
    date_clock,
    parse_date_mode,
    relative_date,
    show_date,
)
from mirage.commands.cli.builtin.git.errors import (
    DateFormatColonError,
    UnknownDateFormatError,
)
from mirage.commands.cli.builtin.git.types import DateKind, DateMode

CLOCK = DateMode(now=1768561800, zone=timezone.utc)


def _mode(value: str) -> DateMode:
    """Parse a ``--date`` value against the fixed test clock.

    Args:
        value (str): the value as typed.
    """
    return parse_date_mode(value, CLOCK)


def test_date_matches_gits_default_format():
    # Pinned against git 2.47.3: the day of the month is not padded,
    # which rules out strftime's %d.
    assert (
        show_date(1768561800, 0, DateMode())
        == "Fri Jan 16 11:10:00 2026 +0000"
    )


def test_single_digit_day_is_not_padded():
    # git 2.47.3 prints "Mon Jan 5", not "Mon Jan 05" and not "Jan  5".
    assert (
        show_date(1767603900, 0, DateMode()) == "Mon Jan 5 09:05:00 2026 +0000"
    )


def test_date_renders_in_the_authors_own_offset():
    assert (
        show_date(1768561800, 8 * 3600, DateMode())
        == "Fri Jan 16 19:10:00 2026 +0800"
    )


def test_negative_offset_renders_with_a_minus():
    assert (
        show_date(1768561800, -7 * 3600, DateMode())
        == "Fri Jan 16 04:10:00 2026 -0700"
    )


@pytest.mark.parametrize(
    "value,expected",
    [
        ("iso", "2026-01-16 16:40:00 +0530"),
        ("iso8601", "2026-01-16 16:40:00 +0530"),
        ("iso-strict", "2026-01-16T16:40:00+05:30"),
        ("iso8601-strict", "2026-01-16T16:40:00+05:30"),
        ("rfc", "Fri, 16 Jan 2026 16:40:00 +0530"),
        ("rfc2822", "Fri, 16 Jan 2026 16:40:00 +0530"),
        ("short", "2026-01-16"),
        ("raw", "1768561800 +0530"),
        ("unix", "1768561800"),
        ("default", "Fri Jan 16 16:40:00 2026 +0530"),
        ("auto:iso", "Fri Jan 16 16:40:00 2026 +0530"),
        ("local", "Fri Jan 16 11:10:00 2026"),
        ("iso-local", "2026-01-16 11:10:00 +0000"),
        ("format:%Y/%m/%d %z [%Z]", "2026/01/16 +0530 []"),
        ("format-local:%H:%M %Z", "11:10 UTC"),
        ("format:", ""),
    ],
)
def test_every_style_git_names(value, expected):
    assert show_date(1768561800, 19800, _mode(value)) == expected


@pytest.mark.parametrize(
    "offset,wall", [(19800, "16:40 +0530"), (-25200, "04:10 -0700")]
)
def test_formatted_epoch_keeps_the_instant_and_percent_escapes(offset, wall):
    mode = _mode("format:%s %%s %%%s %H:%M %z")
    assert show_date(1768561800, offset, mode) == (
        f"1768561800 %s %1768561800 {wall}"
    )


def test_formatted_local_epoch_keeps_the_instant():
    clock = date_clock({"TZ": "Asia/Kolkata"})
    mode = parse_date_mode("format-local:%s %H:%M %z", clock)
    assert show_date(1768561800, -25200, mode) == "1768561800 16:40 +0530"


def test_strict_iso_names_utc_as_z():
    assert (
        show_date(1768561800, 0, _mode("iso-strict")) == "2026-01-16T11:10:00Z"
    )


@pytest.mark.parametrize("value", ["bogus", "iso8601x", "local-bogus"])
def test_a_style_git_lacks_is_refused_whole(value):
    with pytest.raises(UnknownDateFormatError) as info:
        _mode(value)
    assert str(info.value) == f"unknown date format {value}"


def test_format_needs_its_colon():
    with pytest.raises(DateFormatColonError) as info:
        _mode("format")
    assert str(info.value) == "date format missing colon separator: format"


@pytest.mark.parametrize(
    "seconds,expected",
    [
        (-5, "in the future"),
        (0, "0 seconds ago"),
        (1, "1 second ago"),
        (89, "89 seconds ago"),
        (90, "2 minutes ago"),
        (5369, "89 minutes ago"),
        (5399, "2 hours ago"),
        (5400, "2 hours ago"),
        (36 * 3600, "2 days ago"),
        (14 * 86400, "2 weeks ago"),
        (70 * 86400, "2 months ago"),
        (365 * 86400, "1 year ago"),
        (400 * 86400, "1 year, 1 month ago"),
        (800 * 86400, "2 years, 2 months ago"),
        (1825 * 86400, "5 years ago"),
    ],
)
def test_relative_dates_round_as_git_does(seconds, expected):
    assert relative_date(1768561800 - seconds, 1768561800) == expected


@pytest.mark.parametrize(
    "now,expected",
    [
        (1768561800 + 3600, "60 minutes ago"),
        (1768561800 + 3 * 86400, "Fri 16:40 +0530"),
        (1768561800 + 20 * 86400, "Fri Jan 16 16:40"),
        (1768561800 + 400 * 86400, "Jan 16 2026"),
    ],
)
def test_human_dates_hide_what_the_reader_already_knows(now, expected):
    mode = DateMode(kind=DateKind.HUMAN, now=now, zone=timezone.utc)
    assert show_date(1768561800, 19800, mode) == expected


def test_human_dates_hide_the_readers_own_offset():
    mode = DateMode(
        kind=DateKind.HUMAN,
        now=1768561800 + 3 * 86400,
        zone=timezone(timedelta(hours=5, minutes=30)),
    )
    assert show_date(1768561800, 19800, mode) == "Fri 16:40"


def test_the_clock_reads_gits_test_variable_and_tz():
    clock = date_clock({"GIT_TEST_DATE_NOW": "1234 rest", "TZ": "UTC"})
    assert clock.now == 1234
    assert clock.zone is not None
    assert date_clock({"GIT_TEST_DATE_NOW": "x"}).now == 0


@pytest.mark.parametrize(
    "value,expected",
    [
        ("relative-local", "9 months ago"),
        ("unix-local", "1768561800"),
        ("human-local", "Fri Jan 16 11:10"),
        ("short-local", "2026-01-16"),
        ("rfc2822-local", "Fri, 16 Jan 2026 11:10:00 +0000"),
        ("iso8601-strict-local", "2026-01-16T11:10:00Z"),
        ("raw-local", "1768561800 +0000"),
        ("auto:bogus", "Fri Jan 16 16:40:00 2026 +0530"),
        ("format-local:", ""),
        ("format:-local", "-local"),
    ],
)
def test_every_spelling_git_2_50_takes(value, expected):
    # Probed against git 2.50.1 and 2.47.3 with GIT_TEST_DATE_NOW at
    # 2026-10-17 and TZ=UTC.
    clock = date_clock({"TZ": "UTC", "GIT_TEST_DATE_NOW": "1792195200"})
    assert (
        show_date(1768561800, 19800, parse_date_mode(value, clock)) == expected
    )


@pytest.mark.parametrize(
    "value", ["normal", "ISO", "local-local", "iso-", "-local", "auto", " iso"]
)
def test_spellings_git_refuses(value):
    with pytest.raises(UnknownDateFormatError):
        _mode(value)


@pytest.mark.parametrize(
    "value", ["formatx", "format-localx:%Y", "format-local"]
)
def test_a_format_spelling_without_its_colon(value):
    with pytest.raises(DateFormatColonError) as info:
        _mode(value)
    assert str(info.value) == f"date format missing colon separator: {value}"


@pytest.mark.parametrize(
    "seconds,expected",
    [
        (149, "2 minutes ago"),
        (150, "3 minutes ago"),
        (127769, "35 hours ago"),
        (127770, "2 days ago"),
        (1164569, "13 days ago"),
        (1164570, "2 weeks ago"),
        (6002969, "10 weeks ago"),
        (6002970, "2 months ago"),
        (31490969, "12 months ago"),
        (31490970, "1 year ago"),
        (32873370, "1 year, 1 month ago"),
        (156338970, "5 years ago"),
        (173359770, "6 years ago"),
    ],
)
def test_relative_boundaries_measured_to_the_second(seconds, expected):
    assert relative_date(2000000000 - seconds, 2000000000) == expected


@pytest.mark.parametrize(
    "now,timestamp,offset,expected",
    [
        # Later today, and three days ahead.
        (1768561800, 1768561800 + 7200, 0, "in the future"),
        (1768561800, 1768561800 + 3 * 86400, 0, "Mon Jan 19 11:10"),
        # Five days back is past the weekday window.
        (1768561800, 1768561800 - 5 * 86400, 0, "Sun Jan 11 11:10"),
        # Yesterday in the month before.
        (1782907200, 1782907200 - 43201, 0, "Tue Jun 30 23:59"),
        # Already next year at the date's own offset.
        (1767223800, 1767223800, 19800, "Jan 1 2026"),
    ],
)
def test_human_dates_against_measured_clocks(now, timestamp, offset, expected):
    mode = DateMode(kind=DateKind.HUMAN, now=now, zone=timezone.utc)
    assert show_date(timestamp, offset, mode) == expected


@pytest.mark.parametrize(
    "template,local,expected",
    [
        ("%q|%N|%+|%:z|abc%", False, "%q|%N|%+|%:z|abc%"),
        ("%_z|%5z|%05z|%-z", False, "+   0|    +00000|0000+00000|+0"),
        ("%_z|%-z|%Ez", True, "+ 530|+530|+0530"),
        ("%12F|%#Z|%^Z", False, "  2026-01-16|gmt|GMT"),
        ("%10s|%012s|%s", False, "1768581600|001768581600|1768561800"),
        ("%10s|%Z|%#Z", True, "1768561800|IST|ist"),
    ],
)
def test_templates_reach_the_c_library_as_git_hands_them(
    template, local, expected
):
    # git 2.47.3 on glibc, TZ=Asia/Kolkata for -local and UTC otherwise.
    clock = date_clock({"TZ": "Asia/Kolkata" if local else "UTC"})
    prefix = "format-local:" if local else "format:"
    mode = parse_date_mode(prefix + template, clock)
    assert show_date(1768561800, 19800, mode) == expected


def test_a_date_past_year_9999_keeps_counting():
    assert (
        show_date(253402300799, 50400, DateMode())
        == "Sat Jan 1 13:59:59 10000 +1400"
    )


@pytest.mark.parametrize(
    "template,local,expected",
    [
        (
            "%0_12s|%_012s|%0_15F|%_015F|%0_3z|%_03z",
            False,
            "  1768581600|001768581600|     2026-01-16|000002026-01-16"
            "|  +   0|00+0000",
        ),
        (
            "%-3I|%1I|%^#p|%#Z|%3%|%-12a|%0-12F|%-6Y|%0^6b",
            False,
            "  4|04|pm|gmt|  %|         Fri|  2026-01-16|  2026|000JAN",
        ),
        (
            "%0_6z|%-_6z|%_-6z|%0-3H|%-03H|%^#Z",
            True,
            "     +   530|     +   530|     +   530| 16|016|ist",
        ),
    ],
)
def test_templates_pad_by_the_last_padding_flag(template, local, expected):
    # git 2.47.3 on glibc, TZ=Asia/Kolkata for -local and UTC otherwise:
    # the last of _, - and 0 decides, a width pads past a number's own
    # digits, and - still pads to a width.
    clock = date_clock({"TZ": "Asia/Kolkata" if local else "UTC"})
    prefix = "format-local:" if local else "format:"
    mode = parse_date_mode(prefix + template, clock)
    assert show_date(1768561800, 19800, mode) == expected


@pytest.mark.parametrize(
    "zone,timestamp,offset,expected",
    [
        ("Europe/Dublin", 1782907200, 3600, "  1782907200"),
        ("Europe/Dublin", 1768561800, 0, "  1768558200"),
        ("Africa/Windhoek", 962971200, 3600, "   962967600"),
        ("Africa/Casablanca", 1590000000, 0, "  1589996400"),
        ("Australia/Lord_Howe", 1768561800, 39600, "  1768563600"),
        ("Australia/Sydney", 1782907200, 36000, "  1782907200"),
        ("IST-1GMT0,M10.5.0,M3.5.0/1", 1782907200, 3600, "  1782907200"),
        ("America/New_York", 1782907200, -14400, "  1782910800"),
    ],
)
def test_a_padded_epoch_reads_the_wall_clock_as_standard_time(
    zone, timestamp, offset, expected
):
    # git 2.47.3 on glibc: the date's wall clock read back as the standard
    # time nearest it, which in Dublin is IST and in Windhoek until 2017
    # and Casablanca from 2018 the higher offset.
    mode = parse_date_mode("format:%12s", date_clock({"TZ": zone}))
    assert show_date(timestamp, offset, mode) == expected


# git 2.47.3 on glibc, TZ=UTC: every year a template prints is the date's
# own, at 9999 and past it, and a bare %s past 2099 is -1 as an unsigned
# number less the date's offset (only -1 with -local).
@pytest.mark.parametrize(
    "timestamp,offset,template,expected",
    [
        (
            253402300799,
            0,
            "format:%Y|%C|%G|%F|%c|%s|%12s|%12F|%_12Y",
            "9999|99|9999|9999-12-31|Fri Dec 31 23:59:59 9999"
            "|18446744073709551615|253402300799|  9999-12-31|        9999",
        ),
        (
            253402300799,
            50400,
            "format:%Y|%C|%y|%F|%c|%s|%12s|%+6Y",
            "10000|100|00|10000-01-01|Sat Jan  1 13:59:59 10000"
            "|18446744073709501215|253402351199|%+6Y",
        ),
        (
            253402300799,
            -43200,
            "format:%s|%Y|%j",
            "43199|9999|365",
        ),
        (
            2534023007990,
            0,
            "format-local:%Y|%F|%s|%12s|%^c",
            "82269|82269-12-28|18446744073709551615|2534023007990"
            "|TUE DEC 28 23:59:50 82269",
        ),
        (4102444799, 0, "format:%s|%Y", "4102444799|2099"),
        (4102444800, 19800, "format:%s|%Y", "18446744073709531815|2100"),
        (4102444800, -34200, "format:%s|%Y", "4102444800|2099"),
    ],
)
def test_templates_print_the_dates_own_year(
    timestamp, offset, template, expected
):
    mode = parse_date_mode(template, date_clock({"TZ": "UTC"}))
    assert show_date(timestamp, offset, mode) == expected


def test_a_padded_epoch_searches_each_daylight_stretch_once(monkeypatch):
    # 1,000 dates over ten New York years: each of the ten summers is
    # searched once and kept, so a later date in one reads nothing and a
    # winter date reads the zone once.
    reads = []
    reading = dates._zone_reading

    def counted(instant, mode):
        reads.append(instant)
        return reading(instant, mode)

    monkeypatch.setattr(dates, "_zone_reading", counted)
    zone = ZoneInfo.no_cache("America/New_York")
    mode = parse_date_mode(
        "format:%12s", replace(date_clock({"TZ": "UTC"}), zone=zone)
    )
    stamps = [1420070400 + i * 315619 for i in range(1000)]
    first = [show_date(stamp, 0, mode) for stamp in stamps]
    stretches = len(dates.STRETCHES[zone])
    assert stretches == 10
    assert len(reads) < len(stamps) + 400 * stretches
    reads.clear()
    assert [show_date(stamp, 0, mode) for stamp in stamps] == first
    assert len(reads) < 400


# Random POSIX TZ strings whose standard or daylight window lasts 1 to 12
# hours, against git 2.47.3; where glibc missed the short standard window
# and read the clock at the daylight offset less an hour, the row carries
# the nearest standard time's reading too, which is the one printed here.
POSIX_EPOCHS = json.loads(
    (
        Path(__file__).parents[6]
        / "integ/fixtures/git/padded_epoch_posix.json"
    ).read_text()
)["zones"]


@pytest.mark.parametrize(
    "zone", POSIX_EPOCHS, ids=[zone["tz"] for zone in POSIX_EPOCHS]
)
def test_a_padded_epoch_reads_a_posix_zone_off_its_rules(zone):
    mode = parse_date_mode("format:%12s", date_clock({"TZ": zone["tz"]}))
    for timestamp, minutes, printed, *nearest in zone["dates"]:
        expected = nearest[0] if nearest else printed
        assert show_date(timestamp, minutes * 60, mode) == f"{expected:12d}"


def test_a_padded_epoch_finds_a_short_standard_window_far_off():
    # git 2.47.3: a nine-hour standard window in March, read from October.
    mode = parse_date_mode(
        "format:%12s", date_clock({"TZ": "EST5EDT,M3.2.0/11,M3.2.0/3"})
    )
    assert show_date(1792304967, -25200, mode) == "  1792297767"


@pytest.mark.parametrize(
    "zone", ["Australia/Sydney", "AEST-10AEDT,M10.1.0,M4.1.0/3"]
)
def test_a_padded_epoch_in_the_last_southern_summer_a_datetime_holds(zone):
    # git 2.47.3: 9999-11-15, a summer whose standard time follows in the
    # year 10000.
    mode = parse_date_mode("format:%12s", date_clock({"TZ": zone}))
    assert show_date(253398283200, 0, mode) == "253398247200"


def test_a_padded_epoch_reads_a_named_host_zone_as_tzdata(monkeypatch):
    # Without TZ in the session, a host running under America/New_York is
    # read as that tzdata zone: the same dates as a session that names it,
    # its summers searched a day at a time and kept.
    monkeypatch.setenv("TZ", "America/New_York")
    host = parse_date_mode("format:%12s", date_clock({}))
    named = parse_date_mode(
        "format:%12s", date_clock({"TZ": "America/New_York"})
    )
    stamps = [1420070400 + i * 315619 for i in range(1000)]
    assert [show_date(stamp, 0, host) for stamp in stamps] == [
        show_date(stamp, 0, named) for stamp in stamps
    ]
    zone = dates._session_zone(host)
    assert isinstance(zone, ZoneInfo) and zone.key == "America/New_York"
    assert len(dates.STRETCHES[zone]) == 10

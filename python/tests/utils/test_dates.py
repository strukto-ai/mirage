import asyncio
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from mirage.utils.dates import (
    epoch_to_iso,
    iso_timestamp,
    iso_to_epoch,
    now_iso,
    ns_to_iso,
    parse_date_expr,
    parse_date_expr_async,
    parse_posix_time,
    timestamp_iso,
    to_iso_z,
)
from mirage.utils.timezone import resolve_tz

NOW = datetime(2026, 8, 16, 13, 45, 30)
BERLIN = ZoneInfo("Europe/Berlin")
POSIX_CET = resolve_tz("CET-1CEST,M3.5.0,M10.5.0/3")
NEW_YORK = ZoneInfo("America/New_York")


def test_relative_hours_ago():
    assert parse_date_expr("24 hours ago", now=NOW) == datetime(
        2026, 8, 15, 13, 45, 30
    )


def test_relative_days_and_weeks():
    assert parse_date_expr("3 days", now=NOW) == datetime(
        2026, 8, 19, 13, 45, 30
    )
    assert parse_date_expr("-2 weeks", now=NOW) == datetime(
        2026, 8, 2, 13, 45, 30
    )


def test_relative_words():
    assert parse_date_expr("yesterday", now=NOW) == datetime(
        2026, 8, 15, 13, 45, 30
    )
    assert parse_date_expr("tomorrow", now=NOW) == datetime(
        2026, 8, 17, 13, 45, 30
    )
    assert parse_date_expr("now", now=NOW) == NOW
    assert parse_date_expr("last year", now=NOW) == datetime(
        2025, 8, 16, 13, 45, 30
    )
    assert parse_date_expr("next month", now=NOW) == datetime(
        2026, 9, 16, 13, 45, 30
    )


def test_month_overflow_normalizes_like_gnu():
    assert parse_date_expr("2026-01-31 1 month", now=NOW) == datetime(
        2026, 3, 3
    )


def test_iso_base_with_relative_tail():
    assert parse_date_expr(
        "2026-08-16 12:00:00 24 hours ago", now=NOW
    ) == datetime(2026, 8, 15, 12, 0, 0)


# GNU date on debian:stable-slim: a shift landing in the hour a zone skips
# moves past the gap under the offset in force before the change, whichever
# side it started from, and one landing in the hour it repeats keeps the
# base's side of the change. A base in the repeated hour itself takes now's
# side: SUMMER is 2026-10-18 13:45:30 UTC, WINTER 2026-01-15 12:00 UTC.
SUMMER = datetime.fromtimestamp(1792331130, timezone.utc)
WINTER = datetime.fromtimestamp(1768478400, timezone.utc)


@pytest.mark.parametrize("tz", [BERLIN, POSIX_CET], ids=["zoneinfo", "posix"])
@pytest.mark.parametrize(
    "text,now,epoch",
    [
        ("2025-03-29 02:30:00 1 day", SUMMER, 1743298200),
        ("2025-03-31 02:30:00 1 day ago", SUMMER, 1743298200),
        ("2025-03-23 02:30:00 1 week", SUMMER, 1743298200),
        ("2025-04-30 02:30:00 1 month ago", SUMMER, 1743298200),
        ("2024-03-30 02:30:00 1 year", SUMMER, 1743298200),
        ("2025-10-25 02:30:00 1 day", WINTER, 1761438600),
        ("2025-10-27 02:30:00 1 day ago", SUMMER, 1761442200),
        ("2025-10-26 02:30:00 0 day", SUMMER, 1761438600),
        ("2025-10-26 02:30:00 0 day", WINTER, 1761442200),
        ("2025-10-26 02:30:00", SUMMER, 1761438600),
        ("2025-10-26 02:30:00", WINTER, 1761442200),
    ],
)
def test_calendar_shift_reads_the_moved_wall_clock_as_mktime_does(
    tz, text, now, epoch
):
    parsed = parse_date_expr(text, tz=tz, now=now)
    assert parsed is not None
    assert parsed.timestamp() == epoch


@pytest.mark.parametrize(
    "text,epoch",
    [
        ("2025-03-08 02:30:00 1 day", 1741505400),
        ("2025-03-10 02:30:00 1 day ago", 1741505400),
        ("2025-11-01 01:30:00 1 day", 1762061400),
        ("2025-11-03 01:30:00 1 day ago", 1762065000),
    ],
)
def test_calendar_shift_west_of_utc(text, epoch):
    # The same rules on the other side of UTC: 02:30 the night EDT starts
    # is 03:30 EDT, and 01:30 the night it ends keeps the base's side.
    parsed = parse_date_expr(text, tz=NEW_YORK, now=SUMMER)
    assert parsed is not None
    assert parsed.timestamp() == epoch


def test_epoch():
    parsed = parse_date_expr("@1755300000", tz=timezone.utc)
    assert parsed == datetime(2025, 8, 15, 23, 20, tzinfo=timezone.utc)


def test_iso_datetime_with_offset_converts_under_utc():
    parsed = parse_date_expr("2026-08-16T10:00:00+02:00", tz=timezone.utc)
    assert parsed is not None
    assert parsed.hour == 8
    assert parsed.tzinfo == timezone.utc


@pytest.mark.parametrize(
    "zone,epoch",
    [
        ("+23:59", 1767139260),
        ("+24:00", 1767139200),
        ("+23:60", 1767139200),
        ("-24:00", 1767312000),
        ("+2400", 1767139200),
        ("+99:99", None),
        ("+24:01", None),
    ],
)
def test_iso_zone_reaches_a_whole_day(zone, epoch):
    # A zone correction reaches 24 hours either way, a minute field past 59
    # included; GNU refuses `+99:99` and `+24:01`.
    parsed = parse_date_expr(f"2026-01-01T00:00{zone}", tz=timezone.utc)
    assert (None if parsed is None else parsed.timestamp()) == epoch


def test_invalid_returns_none():
    assert parse_date_expr("not a date", now=NOW) is None
    assert parse_date_expr("24 hours agoo", now=NOW) is None
    assert parse_date_expr("@abc", now=NOW) is None


def test_empty_is_midnight_today():
    assert parse_date_expr("", now=NOW) == datetime(2026, 8, 16)
    assert parse_date_expr("   ", now=NOW) == datetime(2026, 8, 16)


def test_number_attached_to_unit():
    assert parse_date_expr("2days", now=NOW) == datetime(
        2026, 8, 18, 13, 45, 30
    )


def test_timestamp_iso_round_trips_through_iso_timestamp():
    assert iso_timestamp(timestamp_iso(1_700_000_123.5)) == 1_700_000_123.5


def test_timestamp_iso_spells_utc():
    assert timestamp_iso(0) == "1970-01-01T00:00:00+00:00"


def test_timestamp_iso_passes_none_through():
    assert timestamp_iso(None) is None


@pytest.mark.parametrize(
    "word,accepted",
    [
        ("@0", True),
        ("@1", True),
        ("@-1", True),
        ("@1.5", True),
        ("@ 1", True),
        ("@+1", True),
        ("@01", True),
        ("@0x1", False),
        ("@1e2", False),
        ("@1.", False),
        ("@.5", False),
    ],
)
def test_epoch_is_a_decimal_count_of_seconds(word, accepted):
    # findutils 4.10 and coreutils 9.7: float() would take `0x1`, `1e2`,
    # `1.` and `.5`, and GNU refuses every one of them.
    assert (parse_date_expr(word, tz=timezone.utc) is not None) is accepted


GNU_NOW = 1791279160


# The date grammar as coreutils 9.7 reads it, measured on debian:stable-slim
# with the clock at 2026-10-06 09:32:40 UTC (faketime) and the zone in TZ:
# None is GNU's `invalid date`. Mirrored in dates.test.ts.
@pytest.mark.parametrize(
    "zone,text,epoch",
    [
        ("Europe/Berlin", "2026-10-06 GMT", 1791244800),
        ("UTC", "2026-10-06 09:32:40,5 +0100", 1791275560.5),
        ("UTC", "2026-10-06 09:32 HKT", None),
        ("UTC", "2026-10-06 09:32 EST DST", 1791293520),
        ("UTC", "2026-10-06 09:00 UTC-1:30", 1791282600),
        ("UTC", "2026-10-06 09:00 A", 1791273600),
        ("UTC", "2026-10-06 09:00 T", 1791302400),
        ("UTC", "2026-10-06 09:00 U.T.C.", 1791277200),
        ("Europe/Berlin", "2026-10-06 9 a.m.", 1791270000),
        ("UTC", "2026-10-06 9:30:15 PM", 1791322215),
        ("UTC", "JUN-17-1992", 708739200),
        ("UTC", "10/06/69", -7516800),
        ("UTC", "monday", 1791763200),
        ("UTC", "next tuesday", 1791849600),
        ("UTC", "last tuesday", 1790640000),
        ("UTC", "third friday", 1792713600),
        ("UTC", "Wed,", 1791331200),
        ("UTC", "3 days ago 10:00", 1791021600),
        ("UTC", "1 year 2 months 3 days ago", 1827826360),
        ("Europe/Berlin", "2 fortnights", 1793698360),
        ("UTC", "2026-01-31 +1 month -1 day", 1772409600),
        ("UTC", "20261006 0930", 1791279000),
        ("UTC", "20261006 +2 days", 1791417600),
        ("UTC", "2026", 1791318360),
        ("UTC", "12345", None),
        ("UTC", "10:00 -5 days", 1791385200),
        ("UTC", "2026-10-06T0930", None),
        ("UTC", "2026-10-06 T", None),
        ("UTC", "2026-10-06 23:59:60", None),
        ("UTC", "noon", None),
        ("UTC", "monday tuesday", None),
        ("UTC", "2026-10-06 10:00 UTC UTC", None),
        ("UTC", "2026-10-06 (comment) 10:00", 1791280800),
        ("Europe/Berlin", "2025-03-30 02:30", None),
        ("Europe/Berlin", "2025-10-26 02:30", 1761438600),
        ("UTC", "1969-12-31 23:00:00 -0100", 0),
        ("Europe/Berlin", "", 1791237600),
    ],
)
def test_gnu_grammar(zone, text, epoch):
    tz = timezone.utc if zone == "UTC" else ZoneInfo(zone)
    now = datetime.fromtimestamp(GNU_NOW, tz)
    parsed = parse_date_expr(text, tz=tz, now=now)
    assert (None if parsed is None else parsed.timestamp()) == epoch


EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
CLOCK = 1792331130.123456


def _seconds(parsed: datetime | None) -> tuple[int, int] | None:
    """A parsed moment as whole epoch seconds and microseconds."""
    if parsed is None:
        return None
    delta = parsed - EPOCH
    return delta.days * 86400 + delta.seconds, delta.microseconds


# More of the grammar, measured the same way with the clock at
# 2026-10-18 13:45:30.123456789 UTC (a Sunday, Berlin and New York on summer
# time) unless a case names another; the expectation is (epoch, nanoseconds).
# Mirrored in dates.test.ts.
@pytest.mark.parametrize(
    "zone,text,now,expected",
    [
        # Signs: the last of a run signs the number.
        ("UTC", "2026--01-15", CLOCK, (1768435200, 0)),
        ("UTC", "- - 2 days", CLOCK, (1792158330, 123456789)),
        ("UTC", "-+2 days", CLOCK, (1792503930, 123456789)),
        # Only seconds take a fraction, and a signed one is no zone.
        (
            "UTC",
            "2026-01-15 12:00:00 0.5 seconds",
            CLOCK,
            (1768478400, 5 * 10**8),
        ),
        (
            "UTC",
            "2026-01-15 12:00:00 1.5 sec ago",
            CLOCK,
            (1768478398, 5 * 10**8),
        ),
        (
            "UTC",
            "2026-01-15 12:00:00 -1.5 sec ago",
            CLOCK,
            (1768478401, 5 * 10**8),
        ),
        (
            "UTC",
            "2026-01-15 12:00:00.7 -0.9 seconds",
            CLOCK,
            (1768478399, 8 * 10**8),
        ),
        (
            "UTC",
            "2026-01-15 12:00:00 0.1234567891 seconds",
            CLOCK,
            (1768478400, 123456789),
        ),
        ("UTC", "2026-01-15 UTC +1.5 sec ago", CLOCK, (1768435198, 5 * 10**8)),
        ("UTC", "-0.25 seconds", CLOCK, (1792331129, 873456789)),
        # A negative one rounds down past its ninth digit.
        (
            "UTC",
            "2026-01-15 12:00:00 -0.0010000001 seconds",
            CLOCK,
            (1768478399, 998999999),
        ),
        ("UTC", "2026-01-15 12:00 +1.5", CLOCK, None),
        ("UTC", "2026-01-15 12:00 1.5 min", CLOCK, None),
        # Only a bare weekday takes a comma after it.
        ("UTC", "monday, 12:00", 1768478400, (1768824000, 0)),
        ("UTC", "next monday,", 1768478400, None),
        ("UTC", "1 monday,", 1768478400, None),
        # Signs with no number after them are dropped.
        ("UTC", "2026-01-15 12:00 +day", CLOCK, (1768564800, 0)),
        ("UTC", "2026-01-15 12:00 5 -day", CLOCK, (1768910400, 0)),
        ("UTC", "2026-01-15 12:00 next +day", CLOCK, (1768564800, 0)),
        ("UTC", "2026-01-15 12:00 +EST", CLOCK, (1768496400, 0)),
        ("UTC", "15 -jan 2026", CLOCK, (1768435200, 0)),
        # Each unit keeps its own 64-bit count.
        (
            "UTC",
            "2026-01-15 12:00 9007199254740993 sec -9007199254740992 sec",
            CLOCK,
            (1768478401, 0),
        ),
        (
            "UTC",
            "2026-01-15 12:00 9223372036854775807 sec 1 min -9223372036854775807 sec",
            CLOCK,
            (1768478460, 0),
        ),
        (
            "UTC",
            "2026-01-15 12:00 4611686018427387904 sec 4611686018427387904 sec"
            " -9223372036854775807 sec",
            CLOCK,
            None,
        ),
        (
            "UTC",
            "2026-01-15 12:00 1317624576693539402 weeks -1317624576693539402 weeks",
            CLOCK,
            None,
        ),
        (
            "UTC",
            "2026-01-15 12:00 9223372036854775808 sec -9223372036854775808 sec",
            CLOCK,
            None,
        ),
        # A number after a date without a year.
        ("UTC", "15 jan 27", CLOCK, (1799971200, 0)),
        ("UTC", "jan 15 27", CLOCK, None),
        ("UTC", "jan 15 7", CLOCK, (1768460400, 0)),
        ("UTC", "jan 15 2027", CLOCK, (1799971200, 0)),
        ("UTC", "jan 15 1030 2027", CLOCK, (-29662255980, 0)),
        ("UTC", "jan 15 10:30 27", CLOCK, (1800009000, 0)),
        ("UTC", "15 jan 10:30", CLOCK, None),
        ("UTC", "260115", CLOCK, (1768435200, 0)),
        ("UTC", "jan15,2027", CLOCK, None),
        ("UTC", "2026/01/15", CLOCK, (1768435200, 0)),
        ("UTC", "026/01/15", CLOCK, None),
        # Zone corrections bind to a clock time, and to a bare hour.
        ("UTC", "10 +0100", CLOCK, (1792314000, 0)),
        ("UTC", "1030 +0100", CLOCK, None),
        ("UTC", "10:30 +1 day", CLOCK, (1792402200, 0)),
        ("UTC", "10:30 +0099", CLOCK, (1792313460, 0)),
        ("UTC", "10:30 +12345", CLOCK, None),
        # A number a zone correction follows is an hour, whatever its digits.
        ("UTC", "Jan 15 010 +0100 2026", CLOCK, (1768467600, 0)),
        ("UTC", "00000010 +0100", 1768478400, (1768467600, 0)),
        ("UTC", "jan 15 060 +0100", CLOCK, None),
        ("UTC", "10 +0100 +1 day", CLOCK, None),
        ("UTC", "10 +01:00 +1 day", 1768478400, (1768554000, 0)),
        # Leading zeros never lengthen one.
        ("UTC", "2026-01-15 12:00 +0000100", CLOCK, (1768474800, 0)),
        ("UTC", "2026-01-15 12:00 +02401", CLOCK, None),
        ("UTC", "10:30 UTC-1:30", CLOCK, (1792324800, 0)),
        ("UTC", "UTC +1 day", CLOCK, (1792417530, 123456789)),
        ("UTC", "UTC +1 day ago", CLOCK, None),
        ("UTC", "UTC DST", CLOCK, (1792278000, 0)),
        ("UTC", "CEST DST", CLOCK, None),
        ("UTC", "10:30 A DST", CLOCK, (1792312200, 0)),
        ("UTC", "a day", CLOCK, (1792413930, 123456789)),
        ("UTC", "J", CLOCK, (1792281600, 0)),
        ("UTC", "10:30 J UTC", CLOCK, None),
        ("UTC", "10:30 U.T.C.", CLOCK, (1792319400, 0)),
        ("UTC", "E.S.T.", CLOCK, (1792299600, 0)),
        # T joins an ISO date to its time, and is a zone anywhere else.
        ("UTC", "2026-01-15 T 10:30", CLOCK, (1768473000, 0)),
        ("UTC", "2026-01-15T10:30pm", CLOCK, None),
        ("UTC", "2026-01-15T10+0100", CLOCK, (1768467600, 0)),
        ("UTC", "2026-01-15T010+05:30", CLOCK, (1768451400, 0)),
        ("UTC", "2026-01-15T10+001:00", CLOCK, (1768467600, 0)),
        ("UTC", "2026-01-15T10+1 day", CLOCK, (1768554000, 0)),
        ("UTC", "2026-01-15T10", CLOCK, None),
        ("UTC", "2026-01-15T10.5+0100", CLOCK, None),
        ("UTC", "jan 15 T 10:30", CLOCK, (1768498200, 0)),
        # Words.
        ("UTC", "second monday", CLOCK, (1792368001, 0)),
        ("UTC", "15 monday", CLOCK, (1800835200, 0)),
        ("UTC", "monday 1 day", CLOCK, (1792454400, 0)),
        ("UTC", "jan 15 next monday", CLOCK, (1768435200, 0)),
        ("UTC", "mon,10:30", CLOCK, (1792405800, 0)),
        ("UTC", ", monday", CLOCK, None),
        ("UTC", "sat.", CLOCK, (1792800000, 0)),
        ("UTC", "tues.", CLOCK, None),
        ("UTC", "wednes", CLOCK, (1792540800, 0)),
        ("UTC", "1 day hence", CLOCK, (1792417530, 123456789)),
        ("UTC", "last day ago", CLOCK, (1792417530, 123456789)),
        ("UTC", "next next day", CLOCK, None),
        ("UTC", "yesterday tomorrow", CLOCK, (1792331130, 123456789)),
        ("UTC", "1 year 2 months 3 days ago", CLOCK, (1828878330, 123456789)),
        ("UTC", "9:30 p.m.", CLOCK, (1792359000, 0)),
        ("UTC", "9:30 pm.", CLOCK, None),
        ("UTC", "12am", CLOCK, (1792281600, 0)),
        ("UTC", "0am", CLOCK, None),
        ("UTC", "10:30:45.1234567895", CLOCK, (1792319445, 123456789)),
        # Comments, epochs and a TZ prefix.
        ("UTC", "(unclosed 10:30", CLOCK, (1792281600, 0)),
        ("UTC", "10(x):30", CLOCK, (1792319400, 0)),
        ("UTC", "@-1.5", CLOCK, (-2, 500000000)),
        ("UTC", "@1 UTC", CLOCK, None),
        ("UTC", 'TZ="Asia/Tokyo" 2026-01-15 10:30', CLOCK, (1768440600, 0)),
        ("UTC", 'TZ="a\\b" 10:30', CLOCK, None),
        ("UTC", 'TZ="Europe/Berlin" 2026-10-25 02:30', CLOCK, (1792891800, 0)),
        ("Europe/Berlin", 'TZ="UTC" 10:30 CET', 1792331130, (1792315800, 0)),
        # A shift of now keeps now's daylight state; one of a date does not.
        ("Europe/Berlin", "1 month", CLOCK, (1795009530, 123456789)),
        ("Europe/Berlin", "UTC 1 month", CLOCK, (1795013130, 123456789)),
        ("Europe/Berlin", "10:30 1 month", CLOCK, (1794994200, 0)),
        ("Europe/Berlin", "1 day", 1774661400, (1774747800, 0)),
        ("Europe/Berlin", "1 day ago", 1774830600, (1774744200, 0)),
        ("Europe/Moscow", "13 years ago", 1768478400, (1358247600, 0)),
        ("Australia/Lord_Howe", "6 months", 1768478400, (1784116800, 0)),
        ("Europe/Berlin", "2026-03-28 02:30 1 day", CLOCK, (1774747800, 0)),
        ("Europe/Berlin", "2026-03-29 02:30", CLOCK, None),
        # A zone given reads a skipped hour as its own.
        ("Europe/Berlin", "2026-03-29 02:30 +0000", CLOCK, (1774751400, 0)),
        (
            "Europe/Berlin",
            "2026-03-29 02:30 UTC 1 month",
            CLOCK,
            (1777429800, 0),
        ),
        ("Europe/Berlin", "2026-03-29 02:30 CEST", CLOCK, None),
        # Ramadan's hour back is a daylight state of its own.
        ("Africa/Casablanca", "40 days", 1768046400, (1771502400, 0)),
        ("Africa/Casablanca", "1 month ago", 1772366400, (1769947200, 0)),
        ("Africa/Casablanca", "2 months", 1735732800, (1740830400, 0)),
        ("America/New_York", "2026-11-01 01:30", CLOCK, (1793511000, 0)),
        ("Europe/Berlin", "2026-10-25 02:30", 1792888200, (1792888200, 0)),
        ("Europe/Berlin", "2026-10-25 02:30", 1792891800, (1792891800, 0)),
        # The zone's own names keep it, in the daylight state they name.
        ("Europe/Berlin", "10:30 CET", CLOCK, None),
        ("Europe/Berlin", "10:30 CEST", CLOCK, (1792312200, 0)),
        ("Europe/Berlin", "CET DST", CLOCK, (1792274400, 0)),
        ("Europe/Berlin", "2026-10-25 02:30 CET", CLOCK, (1792891800, 0)),
        ("Europe/Berlin", "CET 1 month", 1792331130, None),
        ("Europe/Berlin", "CET 9 month", 1792888200, (1816479000, 0)),
        (
            "Europe/Berlin",
            "2026-10-20 10:30 CEST 1 month",
            1792331130,
            (1795163400, 0),
        ),
        ("Europe/Berlin", "10:30 MEZ", 1792331130, (1792315800, 0)),
        ("America/New_York", "10:30 EST", CLOCK, None),
        ("America/New_York", "E.S.T.", CLOCK, None),
        ("America/New_York", "EST DST", 1792331130, (1792296000, 0)),
        # A POSIX zone names both halves when date sees both.
        (
            "STD0SUM-1,M4.1.0,M5.1.0",
            "2026-04-15 12:00 SUM",
            CLOCK,
            (1776250800, 0),
        ),
        ("STD0SUM-1,M4.1.0,M5.1.0", "2026-10-15 12:00 SUM", CLOCK, None),
        # A name both seasons use pins neither.
        (
            "XXX0XXX-1,M3.2.0,M11.1.0",
            "2026-01-15 12:00 XXX",
            1784116800,
            (1768478400, 0),
        ),
        (
            "XXX0XXX-1,M3.2.0,M11.1.0",
            "XXX 6 months ago",
            1784116800,
            (1768482000, 0),
        ),
        # The zone's names come after month, weekday and meridian words
        # and before every other word.
        ("MAY0", "May 15, 2026", CLOCK, (1778803200, 0)),
        ("MON0", "12:00 MON", 1768478400, (1768824000, 0)),
        ("AGO0", "1 day ago", 1768478400, (1768564800, 0)),
        # A daylight time shorter than a day, and whose name date never
        # sees from a clock outside it.
        (
            "STD0SUM-1,M4.1.0/0,M4.1.0/6",
            "2026-04-05 03:00",
            1768478400,
            (1775354400, 0),
        ),
        (
            "STD0SUM-1,M4.1.0/0,M4.1.0/6",
            "2026-04-05 03:00 SUM",
            1768478400,
            None,
        ),
        (
            "STD0SUM-1,M4.1.0/0,M4.1.0/6",
            "2026-04-05 03:00 SUM",
            1775354400,
            (1775354400, 0),
        ),
        # date reads the names now and 90, 180 and 270 days on.
        (
            "STD0SUM-1,J105/0,J106/0",
            "2026-04-15 12:00 SUM",
            1768478400,
            (1776250800, 0),
        ),
        ("STD0SUM-1,J1/0,J2/0", "2026-01-01 12:00 SUM", 1768478400, None),
        # A shift keeps a daylight time shorter than a day.
        (
            "STD0SUM-1,M4.1.0/0,M4.1.0/6",
            "2026-04-05 03:00 STD DST 1 day",
            1768478400,
            (1775440800, 0),
        ),
        # A weekday moves the date before months do.
        (
            "America/New_York",
            "-18 sec -25 month 16:47 third monday",
            CLOCK,
            (1727902002, 0),
        ),
    ],
)
def test_date_grammar(zone, text, now, expected):
    tz = timezone.utc if zone == "UTC" else resolve_tz(zone)
    moment = datetime.fromtimestamp(now, timezone.utc)
    parsed = parse_date_expr(text, tz=tz, now=moment)
    want = None if expected is None else (expected[0], expected[1] // 1000)
    assert _seconds(parsed) == want


def test_a_shift_other_units_cancel_stays_exact():
    # TypeScript refuses this one rather than round it; see dates.test.ts.
    parsed = parse_date_expr(
        "2026-01-15 12:00:01 285426750 years -9007198249190400 seconds",
        tz=timezone.utc,
        now=datetime(2026, 1, 15, 12, tzinfo=timezone.utc),
    )
    assert parsed == datetime(2026, 1, 15, 12, 0, 1, tzinfo=timezone.utc)


def test_a_long_sign_run_is_read_once():
    # A run of signs with no number after it is dropped, read once.
    now = datetime(2026, 1, 15, 12, tzinfo=timezone.utc)
    assert parse_date_expr("+" * 100_000, tz=timezone.utc, now=now) == (
        datetime(2026, 1, 15, tzinfo=timezone.utc)
    )


_NOW = datetime(2026, 9, 22, 12, 0, tzinfo=timezone.utc)


# A clock setting as coreutils 9.7 date reads it (`date
# MMDDhhmm[[CC]YY][.ss]` as a user without the privilege to set the clock).
# Mirrored in dates.test.ts.
@pytest.mark.parametrize(
    "text,expected",
    [
        ("01010000", datetime(2026, 1, 1, tzinfo=timezone.utc)),
        ("0101000024", datetime(2024, 1, 1, tzinfo=timezone.utc)),
        ("0101000069", datetime(1969, 1, 1, tzinfo=timezone.utc)),
        ("010100002024", datetime(2024, 1, 1, tzinfo=timezone.utc)),
        ("01010000.30", datetime(2026, 1, 1, 0, 0, 30, tzinfo=timezone.utc)),
        ("0229000024", datetime(2024, 2, 29, tzinfo=timezone.utc)),
        ("1231235924.60", datetime(2025, 1, 1, tzinfo=timezone.utc)),
    ],
)
def test_posix_time_reads_a_clock_setting(text, expected):
    assert parse_posix_time(text, tz=timezone.utc, now=_NOW) == expected


@pytest.mark.parametrize(
    "text",
    [
        "x",
        "0101",
        "0101000",
        "010100002",
        "01010000.3",
        "01010000.61",
        "1301000024",
        "01320000",
        "01012500",
        "0229000025",
        "0101000０",
    ],
)
def test_posix_time_refuses_what_gnu_calls_invalid(text):
    assert parse_posix_time(text, tz=timezone.utc, now=_NOW) is None


# mirage holds what datetime holds, years 1-9999 in UTC and on the wall
# clock, where GNU also shows year 0 and year 10000. Mirrored in
# dates.test.ts.
@pytest.mark.parametrize(
    "text,zone",
    [
        ("010100000000", "UTC"),
        ("123123599999.60", "UTC"),
        ("123123599999", "America/New_York"),
        ("123118599999.60", "America/New_York"),
        ("010100000001", "Asia/Tokyo"),
        ("123123599999.60", "Asia/Tokyo"),
    ],
)
def test_posix_time_refuses_a_moment_datetime_cannot_hold(text, zone):
    assert parse_posix_time(text, tz=ZoneInfo(zone)) is None


def test_posix_time_reads_the_last_second_datetime_holds():
    assert parse_posix_time("123123599999.59", tz=timezone.utc) == datetime(
        9999, 12, 31, 23, 59, 59, tzinfo=timezone.utc
    )
    assert parse_posix_time("123118599999.59", tz=NEW_YORK) == datetime(
        9999, 12, 31, 18, 59, 59, tzinfo=NEW_YORK
    )


def test_posix_time_refuses_a_wall_clock_the_zone_skips():
    berlin = ZoneInfo("Europe/Berlin")
    assert parse_posix_time("033002302025", tz=berlin) is None
    assert parse_posix_time("033003302025", tz=berlin) == datetime(
        2025, 3, 30, 3, 30, tzinfo=berlin
    )


@pytest.mark.parametrize(
    "text,expected,name",
    [
        ("040503002026", 1775354400, "SUM"),
        # The repeated hour reads as its later, standard reading.
        ("040505302026", 1775367000, "STD"),
    ],
)
def test_posix_time_reads_a_daylight_time_shorter_than_a_day(
    text, expected, name
):
    placed = parse_posix_time(
        text, tz=resolve_tz("STD0SUM-1,M4.1.0/0,M4.1.0/6")
    )
    assert placed is not None
    assert (placed.timestamp(), placed.tzname()) == (expected, name)


def test_to_iso_z_converts_utc_offset_to_z():
    dt = datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
    assert to_iso_z(dt) == "2026-01-02T03:04:05Z"


def test_to_iso_z_normalizes_non_utc_to_z():
    tz = timezone(timedelta(hours=5))
    dt = datetime(2026, 1, 2, 8, 4, 5, tzinfo=tz)
    assert to_iso_z(dt) == "2026-01-02T03:04:05Z"


def test_now_iso_uses_z_suffix():
    s = now_iso()
    assert s.endswith("Z")
    assert "+00:00" not in s


def test_epoch_to_iso_whole_second():
    assert epoch_to_iso(1609459200) == "2021-01-01T00:00:00Z"


def test_epoch_to_iso_truncates_sub_second():
    assert epoch_to_iso(1609459200.987) == "2021-01-01T00:00:00Z"


def test_iso_to_epoch_inverts_epoch_to_iso():
    assert iso_to_epoch("2021-01-01T00:00:00Z") == 1609459200
    assert iso_to_epoch("2026-01-02T15:30:45Z") == 1767367845


def test_iso_to_epoch_reads_naive_stamp_as_utc():
    assert iso_to_epoch("2026-01-02T15:30:45") == 1767367845


def test_iso_to_epoch_honors_offset_and_truncates_sub_second():
    assert iso_to_epoch("2021-01-01T01:00:00+01:00") == 1609459200
    assert iso_to_epoch("2026-07-22T06:57:48.064802Z") == 1784703468


def test_epoch_floors_negative_fractional_like_typescript():
    # A pre-1970 fractional second floors to -1 (matching Math.floor in TS),
    # not 0 as int() truncation would give.
    assert iso_to_epoch("1969-12-31T23:59:59.500Z") == -1
    assert epoch_to_iso(-0.5) == "1969-12-31T23:59:59Z"


@pytest.mark.parametrize(
    "input,expected",
    [
        ("2026-09-05T10:55:39.000Z", "2026-09-05T10:55:39Z"),
        ("2026-09-05T10:55:39.001Z", "2026-09-05T10:55:39.001000Z"),
        ("2026-09-05T10:55:39.120Z", "2026-09-05T10:55:39.120000Z"),
        ("2026-09-05T12:55:39.123+02:00", "2026-09-05T10:55:39.123000Z"),
        ("1969-12-31T23:59:59.500Z", "1969-12-31T23:59:59.500000Z"),
    ],
)
def test_to_iso_z_fraction_policy(input, expected):
    assert to_iso_z(datetime.fromisoformat(input)) == expected


@pytest.mark.parametrize(
    "ns,want",
    [
        (1_609_459_200_000_000_000, "2021-01-01T00:00:00.000Z"),
        (1_704_067_200_500_000_000, "2024-01-01T00:00:00.500Z"),
        (1_759_216_160_567_499_999, "2025-09-30T07:09:20.568Z"),
        (1_759_216_160_999_999_999, "2025-09-30T07:09:21.000Z"),
        (-1_500_000, "1969-12-31T23:59:59.999Z"),
    ],
)
def test_ns_to_iso_rounds_as_node_stat_dates(ns, want):
    # Pinned against node 24: `fs.statSync(p).mtime.toISOString()` for a
    # file whose mtime was set to `ns`, and `new Date(-1)` for the last.
    assert ns_to_iso(ns) == want


@pytest.mark.asyncio
async def test_async_date_parser_can_cancel_a_long_expression():
    task = asyncio.create_task(
        parse_date_expr_async("1 day " * 100000, tz=timezone.utc, now=NOW)
    )
    asyncio.get_running_loop().call_later(0.001, task.cancel)
    with pytest.raises(asyncio.CancelledError):
        await task


def test_date_parser_refuses_invalid_raw_utf8_as_a_date():
    assert parse_date_expr("\udcff", tz=timezone.utc, now=NOW) is None

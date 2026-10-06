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
# base's side of the change, as gnulib hands mktime the base's tm_isdst.
@pytest.mark.parametrize("tz", [BERLIN, POSIX_CET], ids=["zoneinfo", "posix"])
@pytest.mark.parametrize(
    "text,epoch",
    [
        ("2025-03-29 02:30:00 1 day", 1743298200),
        ("2025-03-31 02:30:00 1 day ago", 1743298200),
        ("2025-03-23 02:30:00 1 week", 1743298200),
        ("2025-04-30 02:30:00 1 month ago", 1743298200),
        ("2024-03-30 02:30:00 1 year", 1743298200),
        ("2025-10-25 02:30:00 1 day", 1761438600),
        ("2025-10-27 02:30:00 1 day ago", 1761442200),
        ("2025-10-26 02:30:00 0 day", 1761442200),
    ],
)
def test_calendar_shift_reads_the_moved_wall_clock_as_mktime_does(
    tz, text, epoch
):
    parsed = parse_date_expr(text, tz=tz)
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
    parsed = parse_date_expr(text, tz=NEW_YORK)
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
    # gnulib's time_zone_hhmm takes up to 24 hours either way, a minute
    # field past 59 included; GNU refuses `+99:99` and `+24:01`.
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
    # findutils 4.10 (gnulib): float() would take `0x1`, `1e2`, `1.` and
    # `.5`, and GNU refuses every one of them.
    assert (parse_date_expr(word, tz=timezone.utc) is not None) is accepted


GNU_NOW = 1791279160


# gnulib's parse-datetime grammar as coreutils 9.7 reads it, measured on
# debian:stable-slim with the clock at 2026-10-06 09:32:40 UTC (faketime)
# and the zone in TZ: None is GNU's `invalid date`. Mirrored in
# dates.test.ts.
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
        ("Europe/Berlin", "2025-10-26 02:30", 1761442200),
        ("UTC", "1969-12-31 23:00:00 -0100", 0),
        ("Europe/Berlin", "", 1791237600),
    ],
)
def test_gnu_grammar(zone, text, epoch):
    tz = timezone.utc if zone == "UTC" else ZoneInfo(zone)
    now = datetime.fromtimestamp(GNU_NOW, tz)
    parsed = parse_date_expr(text, tz=tz, now=now)
    assert (None if parsed is None else parsed.timestamp()) == epoch


_NOW = datetime(2026, 9, 22, 12, 0, tzinfo=timezone.utc)


# gnulib's posixtime with date's syntax bits, measured on coreutils 9.7
# (`date MMDDhhmm[[CC]YY][.ss]` as a user without the privilege to set
# the clock). Mirrored in dates.test.ts.
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

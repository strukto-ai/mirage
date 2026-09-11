from datetime import datetime, timezone

import pytest

from mirage.utils.dates import iso_timestamp, parse_date_expr, timestamp_iso

NOW = datetime(2026, 8, 16, 13, 45, 30)


def test_relative_hours_ago():
    assert parse_date_expr("24 hours ago",
                           now=NOW) == datetime(2026, 8, 15, 13, 45, 30)


def test_relative_days_and_weeks():
    assert parse_date_expr("3 days",
                           now=NOW) == datetime(2026, 8, 19, 13, 45, 30)
    assert parse_date_expr("-2 weeks",
                           now=NOW) == datetime(2026, 8, 2, 13, 45, 30)


def test_relative_words():
    assert parse_date_expr("yesterday",
                           now=NOW) == datetime(2026, 8, 15, 13, 45, 30)
    assert parse_date_expr("tomorrow",
                           now=NOW) == datetime(2026, 8, 17, 13, 45, 30)
    assert parse_date_expr("now", now=NOW) == NOW
    assert parse_date_expr("last year",
                           now=NOW) == datetime(2025, 8, 16, 13, 45, 30)
    assert parse_date_expr("next month",
                           now=NOW) == datetime(2026, 9, 16, 13, 45, 30)


def test_month_overflow_normalizes_like_gnu():
    assert parse_date_expr("2026-01-31 1 month",
                           now=NOW) == datetime(2026, 3, 3)


def test_iso_base_with_relative_tail():
    assert parse_date_expr("2026-08-16 12:00:00 24 hours ago",
                           now=NOW) == datetime(2026, 8, 15, 12, 0, 0)


def test_epoch():
    parsed = parse_date_expr("@1755300000", utc=True)
    assert parsed == datetime(2025, 8, 15, 23, 20, tzinfo=timezone.utc)


def test_iso_datetime_with_offset_converts_under_utc():
    parsed = parse_date_expr("2026-08-16T10:00:00+02:00", utc=True)
    assert parsed is not None
    assert parsed.hour == 8
    assert parsed.tzinfo == timezone.utc


def test_iso_zone_past_a_day_is_invalid():
    # GNU refuses `+99:99`; a zone strictly inside a day is also the
    # rule datetime enforces, and the TypeScript twin mirrors it.
    for zone in ("+99:99", "+24:00", "+23:60"):
        assert parse_date_expr(f"2026-01-01T00:00{zone}", utc=True) is None
    assert parse_date_expr("2026-01-01T00:00+23:59", utc=True) is not None


def test_invalid_returns_none():
    assert parse_date_expr("not a date", now=NOW) is None
    assert parse_date_expr("24 hours agoo", now=NOW) is None
    assert parse_date_expr("", now=NOW) is None
    assert parse_date_expr("@abc", now=NOW) is None


def test_number_attached_to_unit():
    assert parse_date_expr("2days",
                           now=NOW) == datetime(2026, 8, 18, 13, 45, 30)


def test_timestamp_iso_round_trips_through_iso_timestamp():
    assert iso_timestamp(timestamp_iso(1_700_000_123.5)) == 1_700_000_123.5


def test_timestamp_iso_spells_utc():
    assert timestamp_iso(0) == "1970-01-01T00:00:00+00:00"


def test_timestamp_iso_passes_none_through():
    assert timestamp_iso(None) is None


@pytest.mark.parametrize("word,accepted", [
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
])
def test_epoch_is_a_decimal_count_of_seconds(word, accepted):
    # findutils 4.10 (gnulib): float() would take `0x1`, `1e2`, `1.` and
    # `.5`, and GNU refuses every one of them.
    assert (parse_date_expr(word, utc=True) is not None) is accepted

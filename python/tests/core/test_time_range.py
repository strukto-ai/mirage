import asyncio
import time
from dataclasses import dataclass
from datetime import date, datetime, timezone

import pytest

from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.time_range import (
    TimeRange,
    followed_day,
    guard_day,
    parse_time,
)

JUNE_1 = datetime(2026, 6, 1, tzinfo=timezone.utc).timestamp()
JUNE_2 = datetime(2026, 6, 2, tzinfo=timezone.utc).timestamp()


def test_parse_time_honors_the_offset_and_milliseconds():
    assert parse_time("2026-06-01T00:00:00Z") == JUNE_1
    assert parse_time("2026-06-01T08:00:00+08:00") == JUNE_1
    assert parse_time("2026-06-01T00:00:00.250Z") == JUNE_1 + 0.25


@pytest.mark.parametrize(
    "value",
    [
        "2026-06-01",
        "2026-06-01T00:00:00",
        "2026-06-01T00:00:00.000001Z",
        "2026-06-01T24:00:00Z",
        "2026-02-30T00:00:00Z",
        "2026-06-01T00:00:00+24:00",
        "2026-06-01T00:00:00+01:60",
    ],
)
def test_parse_time_refuses_what_rfc3339_with_a_zone_does_not_spell(value):
    with pytest.raises(ValueError):
        parse_time(value)


def test_bounded_is_either_bound():
    assert not TimeRange().bounded
    assert TimeRange.from_strings("2026-06-01T00:00:00Z", None).bounded
    assert TimeRange.from_strings(None, "2026-06-01T00:00:00Z").bounded


def test_clip_keeps_the_overlap():
    scope = TimeRange(JUNE_1 + 3600, JUNE_2)
    assert scope.clip(JUNE_1, JUNE_2 + 3600) == (JUNE_1 + 3600, JUNE_2)
    assert TimeRange().clip(JUNE_1, JUNE_2) == (JUNE_1, JUNE_2)


def test_day_bounds_clip_a_partial_day():
    scope = TimeRange(JUNE_1 + 3600, JUNE_2 + 7200)
    assert scope.day_bounds("2026-06-01") == (JUNE_1 + 3600, JUNE_2)
    assert scope.day_bounds("2026-06-02") == (JUNE_2, JUNE_2 + 7200)


def test_require_day_refuses_a_day_outside_the_scope():
    scope = TimeRange(JUNE_1 + 3600, JUNE_2)
    scope.require_day("2026-06-01", "/slack/channels/c/2026-06-01")
    with pytest.raises(FileNotFoundError, match="2026-06-02"):
        scope.require_day("2026-06-02", "/slack/channels/c/2026-06-02")
    with pytest.raises(FileNotFoundError):
        scope.require_day("2026-05-31", "/slack/channels/c/2026-05-31")


def test_listing_days_stop_before_an_exclusive_midnight_end():
    scope = TimeRange(JUNE_1 - 1, JUNE_2)
    assert scope.listing_days(date(2026, 5, 1), date(2026, 6, 30)) == [
        "2026-05-31",
        "2026-06-01",
    ]


def test_listing_days_clip_to_a_glob_span():
    scope = TimeRange(None, JUNE_2)
    days = scope.listing_days(
        date(2026, 1, 1),
        date(2026, 6, 30),
        (date(2026, 5, 30), date(2026, 6, 1)),
    )
    assert days == ["2026-05-30", "2026-05-31"]


def test_prompt_states_both_ends():
    assert "start_time=unbounded" in TimeRange().prompt()
    prompt = TimeRange(JUNE_1, None).prompt()
    assert "start_time=2026-06-01T00:00:00+00:00 (inclusive)" in prompt
    assert "end_time=unbounded (exclusive)" in prompt


@dataclass
class _Scoped:
    time_range: TimeRange


@pytest.mark.asyncio
async def test_guard_day_reads_the_day_slot():
    accessor = _Scoped(TimeRange(JUNE_1, JUNE_2))
    await guard_day(
        accessor,
        ScopeMatch(
            kind="day", vfs_path="/c/2026-06-01", slots={"day": "2026-06-01"}
        ),
        "/m/c/2026-06-01",
    )
    with pytest.raises(FileNotFoundError, match="/m/c/2026-06-02"):
        await guard_day(
            accessor,
            ScopeMatch(
                kind="day",
                vfs_path="/c/2026-06-02",
                slots={"day": "2026-06-02"},
            ),
            "/m/c/2026-06-02",
        )


def _messages(*stamps: str) -> list[dict]:
    return [{"ts": stamp} for stamp in stamps]


@pytest.mark.asyncio
async def test_a_followed_day_prints_its_last_lines_then_what_lands():
    asked: list[dict | None] = []
    answers = [_messages("3"), [], _messages("4", "5")]

    async def after(last):
        asked.append(last)
        return answers.pop(0) if answers else []

    stream = followed_day(
        _messages("1", "2"), 1, time.time() + 60, 0.001, after
    )
    try:
        assert await anext(stream) == b'{"ts":"2"}\n'
        assert await anext(stream) == b'{"ts":"3"}\n'
        assert await anext(stream) == b'{"ts":"4"}\n{"ts":"5"}\n'
    finally:
        await stream.aclose()
    assert asked == [{"ts": "2"}, {"ts": "3"}, {"ts": "3"}]


@pytest.mark.asyncio
async def test_a_followed_day_asks_for_the_whole_day_while_it_has_none():
    asked: list[dict | None] = []

    async def after(last):
        asked.append(last)
        return _messages("1")

    stream = followed_day([], 5, time.time() + 60, 0.001, after)
    try:
        assert await anext(stream) == b'{"ts":"1"}\n'
    finally:
        await stream.aclose()
    assert asked == [None]


@pytest.mark.asyncio
async def test_a_day_that_is_over_is_asked_once_more_then_waits():
    asked: list[dict | None] = []

    async def after(last):
        asked.append(last)
        return _messages("9") if len(asked) == 1 else []

    stream = followed_day(_messages("1"), 0, time.time(), 0.001, after)
    try:
        assert await anext(stream) == b'{"ts":"9"}\n'
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(anext(stream), 0.05)
    finally:
        await stream.aclose()
    assert asked == [{"ts": "1"}]

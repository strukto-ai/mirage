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

from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.gcal.client import PAGE_LIMIT
from mirage.core.gcal.search import files_containing
from tests.fixtures.gcal_api import (
    PRIMARY,
    FakeCalendarApi,
    event,
    make_accessor,
    spec,
)

pytestmark = pytest.mark.asyncio

DAY = "2026-08-11"


def _api(monkeypatch: pytest.MonkeyPatch, events: list) -> FakeCalendarApi:
    fake = FakeCalendarApi([PRIMARY], events)
    for target, fn in (
        ("readdir.list_calendars", fake.list_calendars),
        ("readdir.list_events", fake.list_events),
        ("search.list_events", fake.list_events),
    ):
        monkeypatch.setattr(f"mirage.core.gcal.{target}", fn)
    return fake


def _day(event_id: str, summary: str, **fields: str) -> dict:
    found = event(
        event_id, summary, f"{DAY}T09:00:00+08:00", f"{DAY}T10:00:00+08:00"
    )
    return found | fields


async def _ids(text: str, under: str = "/", **config: str | int) -> list:
    accessor = make_accessor(content_search=True, **config)
    out = await files_containing(
        accessor, text, [spec(under)], RAMIndexCacheStore()
    )
    if out is None:
        return None
    return sorted(p.virtual.rsplit("/", 1)[-1].split("__")[0] for p in out)


EVENTS = [
    _day("aaaa1", "PhD Defense"),
    _day("bbbb2", "Weekly sync-up", description="Q&amp;A after"),
    _day("cccc3", "Lunch", location="Room 4"),
]


# Calendar's search names the events whose own words hold the text; the
# rest of an event's file (ids, status, times) is the listing's to check.
async def test_search_names_events_and_the_listing_checks_the_rest(
    monkeypatch,
):
    fake = _api(monkeypatch, EVENTS)
    assert await _ids("defense") == ["aaaa1"]
    assert ("integ@example.com", "defense") in fake.asked
    assert await _ids("confirmed") == ["aaaa1", "bbbb2", "cccc3"]


# A word the search may split otherwise (hyphenated, an entity) is kept by
# the listing, and each word of a phrase is found in either place.
async def test_a_word_the_search_may_split_is_kept_by_the_listing(
    monkeypatch,
):
    _api(monkeypatch, EVENTS)
    assert await _ids("sync") == ["bbbb2"]
    assert await _ids("amp") == ["bbbb2"]
    assert await _ids("Weekly sync") == ["bbbb2"]
    assert await _ids("room") == ["cccc3"]


async def test_a_bucket_scope_and_a_multi_day_mount(monkeypatch):
    _api(monkeypatch, EVENTS)
    assert await _ids("lunch", f"/primary/{DAY}") == ["cccc3"]
    assert await _ids("lunch", bucket_days=7) == ["cccc3"]


@pytest.mark.parametrize(
    "text, under",
    [
        # Nothing found, a digit, and a scope inside a bucket.
        ("nowhere", "/"),
        ("room4", "/"),
        ("lunch", f"/primary/{DAY}/cccc3.gcal.json"),
    ],
)
async def test_reads_every_file_when_it_cannot_say(monkeypatch, text, under):
    _api(monkeypatch, EVENTS)
    assert await _ids(text, under) is None


async def test_a_listing_without_kept_text_reads_every_file(monkeypatch):
    _api(monkeypatch, EVENTS)
    accessor = make_accessor()
    out = await files_containing(
        accessor, "lunch", [spec("/")], RAMIndexCacheStore()
    )
    assert out is None


@pytest.mark.parametrize(
    "error", [OSError("connection reset"), RuntimeError(PAGE_LIMIT)]
)
async def test_a_failed_search_reads_every_file(monkeypatch, error):
    fake = _api(monkeypatch, EVENTS)

    async def refused(*args, query=None, **kwargs):
        if query is not None:
            raise error
        return await fake.list_events(*args, **kwargs)

    monkeypatch.setattr("mirage.core.gcal.search.list_events", refused)
    assert await _ids("lunch") is None


# A read fetches the event as it is now, and so does the search: each
# bucket is listed again rather than served from the walk's listing.
async def test_a_text_changed_since_the_listing_is_found(monkeypatch):
    events = list(EVENTS)
    _api(monkeypatch, events)
    accessor = make_accessor(content_search=True)
    index = RAMIndexCacheStore()

    async def ids(text: str) -> list | None:
        out = await files_containing(accessor, text, [spec("/")], index)
        if out is None:
            return None
        return sorted(p.virtual.rsplit("/", 1)[-1].split("__")[0] for p in out)

    assert await ids("tentative") is None
    events[0] = _day("aaaa1", "PhD Defense", status="tentative")
    assert await ids("tentative") == ["aaaa1"]

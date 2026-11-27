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

from typing import Any
from urllib.parse import parse_qs

import pytest
import pytest_asyncio

from mirage.core.gcal.search import files_containing
from mirage.core.google.constants import MAX_RETRIES
from mirage.utils.clock import ManualClock
from tests.fixtures.gcal_seed import make_accessor, spec
from tests.fixtures.google_account import (
    EVENTS,
    PRIMARY,
    UNTIL_CLEARED,
    GoogleAccount,
)

pytestmark = pytest.mark.asyncio

DAY = "2026-08-11"
NOTHING = {"kind": "calendar#events", "items": []}


@pytest_asyncio.fixture
async def calendar(google_account: GoogleAccount) -> GoogleAccount:
    """The primary calendar holding three events on ``DAY``, its requests
    recorded from here."""
    start, end = f"{DAY}T09:00:00+08:00", f"{DAY}T10:00:00+08:00"
    await google_account.reset()
    await google_account.event("PhD Defense", start, end, event_id="aaaa1")
    await google_account.event(
        "Weekly sync-up",
        start,
        end,
        event_id="bbbb2",
        description="Q&amp;A after",
    )
    await google_account.event(
        "Lunch", start, end, event_id="cccc3", location="Room 4"
    )
    await google_account.run.record_requests()
    return google_account


async def _ids(
    account: GoogleAccount, text: str, under: str = "/", **config: Any
) -> list | None:
    accessor = make_accessor(account, **config)
    out = await files_containing(accessor, text, [spec(under)])
    if out is None:
        return None
    return sorted(p.virtual.rsplit("/", 1)[-1].split("__")[0] for p in out)


async def search_query(account: GoogleAccount, word: str) -> str:
    """The query string the last search for ``word`` was sent with.

    Args:
        account (GoogleAccount): the account searched.
        word (str): the word searched for.
    """
    asked = [
        r["query"]
        for r in await account.asked("GET", EVENTS)
        if parse_qs(r["query"]).get("q") == [word]
    ]
    return asked[-1]


async def served(account: GoogleAccount) -> list[int]:
    """How many requests each answer armed on the fake has served."""
    listed = await account.run.call("GET", "/_kit/faults")
    return [plan["served"] for plan in listed["plans"]]


# Calendar's search names the events whose own words hold the text; the
# rest of an event's file (ids, status, times) is the listing's to check.
async def test_search_names_events_and_the_listing_checks_the_rest(
    calendar,
):
    assert await _ids(calendar, "defense") == ["aaaa1"]
    assert ("search", PRIMARY, "defense") in await calendar.calendar_log()
    assert await _ids(calendar, "confirmed") == ["aaaa1", "bbbb2", "cccc3"]


# A word the search may split otherwise (hyphenated, an entity) is kept by
# the listing, and each word of a phrase is found in either place. The
# fake's search finds both words, so each is searched once as it is, and
# then with the search finding nothing for it, as Calendar's may.
async def test_a_word_the_search_may_split_is_kept_by_the_listing(calendar):
    assert await _ids(calendar, "sync") == ["bbbb2"]
    assert await _ids(calendar, "amp") == ["bbbb2"]
    for word in ("sync", "amp"):
        await calendar.run.answer_next(
            "GET",
            EVENTS,
            200,
            NOTHING,
            times=UNTIL_CLEARED,
            query=await search_query(calendar, word),
        )
    assert await _ids(calendar, "sync") == ["bbbb2"]
    assert await _ids(calendar, "amp") == ["bbbb2"]
    assert await _ids(calendar, "Weekly sync") == ["bbbb2"]
    assert await _ids(calendar, "room") == ["cccc3"]
    assert await served(calendar) == [2, 1]


async def test_a_bucket_scope_and_a_multi_day_mount(calendar):
    assert await _ids(calendar, "lunch", f"/primary/{DAY}") == ["cccc3"]
    assert await _ids(calendar, "lunch", bucket_days=7) == ["cccc3"]


@pytest.mark.parametrize(
    "text, under",
    [
        # Nothing found, a digit, and a scope inside a bucket.
        ("nowhere", "/"),
        ("room4", "/"),
        ("lunch", f"/primary/{DAY}/cccc3.gcal.json"),
    ],
)
async def test_reads_every_file_when_it_cannot_say(calendar, text, under):
    assert await _ids(calendar, text, under) is None


async def test_a_listing_without_kept_text_reads_every_file(calendar):
    accessor = make_accessor(calendar, capped=lambda: False)
    out = await files_containing(accessor, "lunch", [spec("/")])
    assert out is None


async def test_a_dropped_search_reads_every_file(calendar):
    # The connection drops on the search and on each retry of it; the
    # listings are served.
    assert await _ids(calendar, "lunch") == ["cccc3"]
    await calendar.run.answer_next(
        "GET",
        EVENTS,
        None,
        times=UNTIL_CLEARED,
        query=await search_query(calendar, "lunch"),
    )
    assert await _ids(calendar, "lunch", clock=ManualClock()) is None
    assert await served(calendar) == [1 + MAX_RETRIES]


async def test_a_search_past_the_page_cap_reads_every_file(calendar):
    # Each page of the search names a next one, so it runs past the cap.
    assert await _ids(calendar, "lunch") == ["cccc3"]
    query = await search_query(calendar, "lunch")
    page = {**NOTHING, "nextPageToken": "1"}
    for asked in (query, f"{query}&pageToken=1"):
        await calendar.run.answer_next(
            "GET", EVENTS, 200, page, times=UNTIL_CLEARED, query=asked
        )
    assert await _ids(calendar, "lunch") is None
    assert await served(calendar) == [1, 49]


# A read fetches the event as it is now, and so does the search: each
# bucket is listed again rather than served from the walk's listing.
async def test_a_text_changed_since_the_listing_is_found(calendar):
    accessor = make_accessor(calendar)

    async def ids(text: str) -> list | None:
        out = await files_containing(accessor, text, [spec("/")])
        if out is None:
            return None
        return sorted(p.virtual.rsplit("/", 1)[-1].split("__")[0] for p in out)

    assert await ids("tentative") is None
    await calendar.change_event("aaaa1", status="tentative")
    assert await ids("tentative") == ["aaaa1"]

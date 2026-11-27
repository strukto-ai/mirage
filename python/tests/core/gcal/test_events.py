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

from mirage.core.gcal.events import build_delta_hook, event_paths
from mirage.types import FileChangeKind, JsonValue
from tests.fixtures.gcal_seed import HK, make_accessor, spec
from tests.fixtures.google_account import EVENTS

pytestmark = pytest.mark.asyncio

DAY = "/primary/2026-08-11"
RETRO = "/primary/2026-08-12/ffff6__0900-1000_Retro.gcal.json"


def event(
    event_id: str, summary: str, start: str, end: str
) -> dict[str, JsonValue]:
    """An events.list item.

    Args:
        event_id (str): the event id.
        summary (str): the title.
        start (str): RFC3339 start.
        end (str): RFC3339 end.
    """
    return {
        "id": event_id,
        "status": "confirmed",
        "summary": summary,
        "start": {"dateTime": start},
        "end": {"dateTime": end},
    }


async def sync_tokens(account) -> list[str | None]:
    """The sync token each events request was asked from, None for a
    whole listing."""
    return [
        p.get("syncToken") for p in await account.run.params("GET", EVENTS)
    ]


async def test_events_follow_each_event_s_files(calendar):
    hook = build_delta_hook(make_accessor(calendar))
    root = spec("/primary")
    first = await calendar.sync_token()
    baseline = await hook.pull(root, None)
    assert baseline.changes == ()
    await calendar.change_event(
        "aaaa1",
        start={"dateTime": "2026-08-11T10:00:00+08:00"},
        end={"dateTime": "2026-08-11T11:30:00+08:00"},
    )
    await calendar.delete_event("bbbb2")
    await calendar.event(
        "Retro",
        "2026-08-12T09:00:00+08:00",
        "2026-08-12T10:00:00+08:00",
        event_id="ffff6",
    )
    second = await calendar.sync_token()
    moved = await hook.pull(root, baseline.checkpoint)
    assert [(c.kind, c.path.virtual) for c in moved.changes] == [
        (
            FileChangeKind.DELETE,
            f"{DAY}/aaaa1__0900-1030_PhD_Defense.gcal.json",
        ),
        (
            FileChangeKind.CREATE,
            f"{DAY}/aaaa1__1000-1130_PhD_Defense.gcal.json",
        ),
        (
            FileChangeKind.DELETE,
            f"{DAY}/bbbb2__1500-1600_Committee_Meeting.gcal.json",
        ),
        (FileChangeKind.CREATE, RETRO),
    ]
    # A token Calendar dropped is answered by the whole calendar, where
    # only an event whose stamp moved since is reported.
    await calendar.change_event("ffff6", description="Bring notes")
    await calendar.refuse(
        "GET",
        EVENTS,
        410,
        "Sync token is no longer valid, a full sync is required.",
        reason="fullSyncRequired",
    )
    expired = await hook.pull(root, moved.checkpoint)
    assert [(c.kind, c.path.virtual) for c in expired.changes] == [
        (FileChangeKind.UPDATE, RETRO),
    ]
    assert await sync_tokens(calendar) == [None, first, second, None]


async def test_an_event_outside_the_time_range_is_no_file(google_account):
    # The listing of its day leaves it out, so its changes name nothing.
    accessor = make_accessor(
        google_account,
        start_time="2026-08-12T12:00:00+08:00",
        end_time="2026-08-12T18:00:00+08:00",
    )
    outside = event(
        "ffff6",
        "Retro",
        "2026-08-12T09:00:00+08:00",
        "2026-08-12T10:00:00+08:00",
    )
    inside = event(
        "eeee5",
        "Lunch",
        "2026-08-12T13:00:00+08:00",
        "2026-08-12T14:00:00+08:00",
    )
    assert event_paths(accessor, "/primary", outside, HK, False) == []
    assert event_paths(accessor, "/primary", inside, HK, False) == [
        "/primary/2026-08-12/eeee5__1300-1400_Lunch.gcal.json"
    ]


async def test_events_follow_a_calendar_s_details_and_zone(google_account):
    # The primary calendar alone, holding one event.
    await google_account.reset()
    await google_account.event(
        "PhD Defense",
        "2026-08-11T09:00:00+08:00",
        "2026-08-11T10:30:00+08:00",
        event_id="aaaa1",
    )
    await google_account.run.record_requests()
    hook = build_delta_hook(make_accessor(google_account))
    root = spec("/primary")
    baseline = await hook.pull(root, None)
    # Its own details are its calendar.json, which no event names.
    await google_account.change_calendar(summary="Renamed")
    renamed = await hook.pull(root, baseline.checkpoint)
    assert [(c.kind, c.path.virtual) for c in renamed.changes] == [
        (FileChangeKind.UPDATE, "/primary/calendar.json")
    ]
    # A new zone moves the day an event falls on: it is synced whole.
    await google_account.change_calendar(timeZone="America/Los_Angeles")
    moved = await hook.pull(root, renamed.checkpoint)
    assert (await sync_tokens(google_account))[-1] is None
    assert [(c.kind, c.path.virtual) for c in moved.changes] == [
        (FileChangeKind.UPDATE, "/primary/calendar.json"),
        (
            FileChangeKind.DELETE,
            f"{DAY}/aaaa1__0900-1030_PhD_Defense.gcal.json",
        ),
        (
            FileChangeKind.CREATE,
            "/primary/2026-08-10/aaaa1__1800-1930_PhD_Defense.gcal.json",
        ),
    ]

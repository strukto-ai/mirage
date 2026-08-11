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

from datetime import datetime

import pytest

from mirage.accessor.gcal import GCalAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.gcal.day import event_span
from mirage.core.google._client import TokenManager
from mirage.resource.gcal.config import GCalConfig

HK = "Asia/Hong_Kong"

PRIMARY = {
    "id": "integ@example.com",
    "summary": "Integ User",
    "timeZone": HK,
    "accessRole": "owner",
    "primary": True,
}
TEAM = {
    "id": "team@group.calendar.google.com",
    "summary": "Engineering",
    "timeZone": "America/Los_Angeles",
    "accessRole": "reader",
}
SHARED = {
    "id": "busy@group.calendar.google.com",
    "summary": "Exec",
    "timeZone": HK,
    "accessRole": "freeBusyReader",
}


def timed(event_id: str, summary: str, start: str, end: str) -> dict:
    return {
        "id": event_id,
        "status": "confirmed",
        "summary": summary,
        "start": {
            "dateTime": start
        },
        "end": {
            "dateTime": end
        },
        "updated": "2026-08-01T00:00:00.000Z",
    }


def all_day(event_id: str, summary: str, start: str, end: str) -> dict:
    return {
        "id": event_id,
        "status": "confirmed",
        "summary": summary,
        "start": {
            "date": start
        },
        "end": {
            "date": end
        },
        "updated": "2026-08-01T00:00:00.000Z",
    }


EVENTS = [
    timed("aaaa1", "PhD Defense", "2026-08-11T09:00:00+08:00",
          "2026-08-11T10:30:00+08:00"),
    timed("bbbb2", "Committee Meeting", "2026-08-11T15:00:00+08:00",
          "2026-08-11T16:00:00+08:00"),
    timed("cccc3", "Conference", "2026-08-10T09:00:00+08:00",
          "2026-08-13T17:00:00+08:00"),
    all_day("dddd4", "Public Holiday", "2026-08-11", "2026-08-12"),
    timed("eeee5", "Last Year", "2025-01-05T09:00:00+08:00",
          "2025-01-05T10:00:00+08:00"),
]


class FakeCalendarApi:

    def __init__(self, calendars: list[dict], events: list[dict]) -> None:
        self.calendars = calendars
        self.events = events
        self.listed: list[tuple[str, str, str]] = []
        self.deleted: list[tuple[str, str]] = []

    async def list_calendars(self, token_manager, min_access_role=None):
        if not min_access_role:
            return list(self.calendars)
        return [
            c for c in self.calendars if c["accessRole"] == min_access_role
        ]

    async def list_events(self,
                          token_manager,
                          calendar_id,
                          time_min,
                          time_max,
                          time_zone=None):
        self.listed.append((calendar_id, time_min, time_max))
        lo = datetime.fromisoformat(time_min)
        hi = datetime.fromisoformat(time_max)
        free_busy = calendar_id == SHARED["id"]
        out = []
        for event in self.events:
            span = event_span(event, time_zone or HK)
            if span is None:
                continue
            # timeMin bounds the END and timeMax the START, both exclusive.
            if span[1] <= lo or span[0] >= hi:
                continue
            if free_busy:
                # What Google actually returns for a freeBusyReader role:
                # availability with no summary, description or location.
                event = {
                    k: v
                    for k, v in event.items()
                    if k not in ("summary", "description", "location")
                }
            out.append(event)
        return out

    async def delete_event(self, token_manager, calendar_id, event_id):
        self.deleted.append((calendar_id, event_id))


@pytest.fixture
def api(monkeypatch):
    fake = FakeCalendarApi([PRIMARY, TEAM, SHARED], EVENTS)
    for module in ("readdir", "read", "unlink"):
        mod = __import__(f"mirage.core.gcal.{module}", fromlist=["x"])
        for name in ("list_calendars", "list_events", "delete_event"):
            if hasattr(mod, name):
                monkeypatch.setattr(mod, name, getattr(fake, name))
    return fake


@pytest.fixture
def accessor():
    config = GCalConfig(client_id="cid",
                        refresh_token="rt",
                        today="2026-08-11")
    return GCalAccessor(config, TokenManager(config))


@pytest.fixture
def index():
    return RAMIndexCacheStore()

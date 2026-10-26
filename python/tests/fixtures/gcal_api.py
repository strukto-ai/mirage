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

from collections.abc import Awaitable, Callable
from datetime import datetime, timezone

import pytest

from mirage.accessor.gcal import GCalAccessor
from mirage.core.gcal.day import event_span
from mirage.core.google.client import TokenManager
from mirage.core.time_range import TimeRange
from mirage.types import JsonValue, PathSpec
from mirage.vfs.gcal.config import GCalConfig
from tests.fixtures.google_api import install_api

HK = "Asia/Hong_Kong"
TODAY = "2026-08-11"

PRIMARY: dict[str, JsonValue] = {
    "id": "integ@example.com",
    "summary": "Integ User",
    "timeZone": HK,
    "accessRole": "owner",
    "primary": True,
}
TEAM: dict[str, JsonValue] = {
    "id": "team@group.calendar.google.com",
    "summary": "Engineering",
    "timeZone": "America/Los_Angeles",
    "accessRole": "reader",
}
SHARED: dict[str, JsonValue] = {
    "id": "busy@group.calendar.google.com",
    "summary": "Exec",
    "timeZone": HK,
    "accessRole": "freeBusyReader",
}


def event(
    event_id: str, summary: str, start: str, end: str
) -> dict[str, JsonValue]:
    """An events.list item: a ``YYYY-MM-DD`` pair is an all-day event.

    Args:
        event_id (str): the event id.
        summary (str): the title.
        start (str): RFC3339 start, or the first all-day date.
        end (str): RFC3339 end, or the exclusive all-day end date.
    """
    key = "date" if len(start) == 10 else "dateTime"
    return {
        "id": event_id,
        "status": "confirmed",
        "summary": summary,
        "start": {key: start},
        "end": {key: end},
        "updated": "2026-08-01T00:00:00.000Z",
    }


EVENTS = [
    event(
        "aaaa1",
        "PhD Defense",
        "2026-08-11T09:00:00+08:00",
        "2026-08-11T10:30:00+08:00",
    ),
    event(
        "bbbb2",
        "Committee Meeting",
        "2026-08-11T15:00:00+08:00",
        "2026-08-11T16:00:00+08:00",
    ),
    event(
        "cccc3",
        "Conference",
        "2026-08-10T09:00:00+08:00",
        "2026-08-13T17:00:00+08:00",
    ),
    event("dddd4", "Public Holiday", "2026-08-11", "2026-08-12"),
    event(
        "eeee5",
        "Last Year",
        "2025-01-05T09:00:00+08:00",
        "2025-01-05T10:00:00+08:00",
    ),
]


def _found(item: dict[str, JsonValue], query: str) -> bool:
    """Calendar's search at its strictest: each word of ``query`` is a
    whole space-separated word of the summary, description or location,
    sentence punctuation aside, so ``sync-up`` holds no ``sync``.

    Args:
        item (dict[str, JsonValue]): the event.
        query (str): the words asked.
    """
    words = {
        word.strip(".,;:!?\"'()[]").lower()
        for field in ("summary", "description", "location")
        if isinstance(value := item.get(field), str)
        for word in value.split()
    }
    return all(word in words for word in query.lower().split())


class FakeCalendarApi:
    def __init__(
        self,
        calendars: list[dict[str, JsonValue]],
        events: list[dict[str, JsonValue]],
    ) -> None:
        self.calendars = calendars
        self.events = events
        self.listed: list[tuple[str, str | None, str]] = []
        self.asked: list[tuple[str, str]] = []
        self.deleted: list[tuple[str, str]] = []
        # Calendar's incremental sync, armed by a test that pulls events.
        self.syncs: (
            Callable[
                ..., Awaitable[tuple[list[dict[str, JsonValue]], str | None]]
            ]
            | None
        ) = None

    async def list_calendars(
        self, min_access_role: str | None = None
    ) -> list[dict[str, JsonValue]]:
        if not min_access_role:
            return list(self.calendars)
        return [
            c for c in self.calendars if c["accessRole"] == min_access_role
        ]

    async def list_events(
        self,
        calendar_id: str,
        time_min: str | None,
        time_max: str,
        time_zone: str | None = None,
        *,
        scope: TimeRange = TimeRange(),
        query: str | None = None,
    ) -> list[dict[str, JsonValue]]:
        if query is None:
            self.listed.append((calendar_id, time_min, time_max))
        else:
            self.asked.append((calendar_id, query))
        lo = (
            datetime.fromisoformat(time_min)
            if time_min is not None
            else datetime.min.replace(tzinfo=timezone.utc)
        )
        hi = datetime.fromisoformat(time_max)
        out = []
        for item in self.events:
            span = event_span(item, time_zone or HK)
            if span is None:
                continue
            # timeMin bounds the END and timeMax the START, both exclusive.
            if (
                span[1] <= lo
                or span[0] >= hi
                or scope.start is not None
                and span[1].timestamp() <= scope.start
                or scope.end is not None
                and span[0].timestamp() >= scope.end
            ):
                continue
            if calendar_id == SHARED["id"]:
                # What Google actually returns for a freeBusyReader role:
                # availability with no summary, description or location.
                item = {
                    k: v
                    for k, v in item.items()
                    if k not in ("summary", "description", "location")
                }
            if query is not None and not _found(item, query):
                continue
            out.append(item)
        return out

    async def sync_events(
        self,
        calendar_id: str,
        sync_token: str | None,
        time_zone: str | None = None,
    ) -> tuple[list[dict[str, JsonValue]], str | None]:
        if self.syncs is None:
            raise AssertionError("the test reached sync_events unarmed")
        return await self.syncs(calendar_id, sync_token, time_zone)

    async def delete_event(self, calendar_id: str, event_id: str) -> None:
        self.deleted.append((calendar_id, event_id))


@pytest.fixture
def gcal_api(monkeypatch: pytest.MonkeyPatch) -> FakeCalendarApi:
    fake = FakeCalendarApi([PRIMARY, TEAM, SHARED], EVENTS)
    install_api(monkeypatch, calendar=fake)
    return fake


def gcal_config(**overrides: str | int) -> GCalConfig:
    """A mount config against the fake, today pinned to ``TODAY``.

    Args:
        **overrides (str | int): GCalConfig fields to set.
    """
    return GCalConfig(
        **{"client_id": "cid", "refresh_token": "rt", "today": TODAY}
        | overrides
    )


def make_accessor(
    capped: Callable[[], bool] = lambda: True, **overrides: str | int
) -> GCalAccessor:
    """An accessor for ``gcal_config(**overrides)``.

    Args:
        capped (Callable[[], bool]): whether its mount walks under a
            ``walk_limit``.
        **overrides (str | int): GCalConfig fields to set.
    """
    config = gcal_config(**overrides)
    return GCalAccessor(config, TokenManager(config), capped)


def spec(virtual: str, pattern: str | None = None) -> PathSpec:
    """A mount-relative PathSpec, globbed when a pattern is given.

    Args:
        virtual (str): the path below the mount root.
        pattern (str | None): the glob typed for the directory's children.
    """
    directory = (virtual.rsplit("/", 1)[0] or "/") if pattern else virtual
    return PathSpec(
        virtual=virtual,
        directory=directory,
        vfs_path=virtual.lstrip("/"),
        pattern=pattern,
    )


def names(paths: list[str]) -> list[str]:
    """The last segment of each listed path.

    Args:
        paths (list[str]): what a readdir returned.
    """
    return [p.rsplit("/", 1)[-1] for p in paths]

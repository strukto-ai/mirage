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

import math
from datetime import datetime, timezone
from urllib.parse import quote

from mirage.core.gcal.day import event_span
from mirage.core.google.client import (
    TokenManager,
    calendar_base,
    google_delete,
    google_get,
)
from mirage.core.google.constants import CALENDAR_API_BASE
from mirage.core.time_range import TimeRange, parse_time
from mirage.types import JsonValue

__all__ = [
    "CALENDAR_API_BASE",
    "TokenManager",
    "calendar_base",
    "google_delete",
    "google_get",
    "list_calendars",
    "list_events",
    "sync_events",
    "delete_event",
]

MAX_PAGES = 50

PAGE_LIMIT = "gcal: listing exceeded 50 pages; narrow the date range"


async def list_calendars(
    token_manager: TokenManager, min_access_role: str | None = None
) -> list[dict[str, JsonValue]]:
    """List the account's calendars.

    showHidden is left at its default (false) so the mount shows what the
    Calendar UI shows; a subscribed holiday calendar the user hid stays out.

    Args:
        token_manager (TokenManager): the mount's OAuth handle.
        min_access_role (str | None): keep only calendars at or above this
            role, e.g. "writer" for ones the agent can schedule into.

    Returns:
        list[dict]: calendarList entries.
    """
    url = f"{calendar_base(token_manager)}/users/me/calendarList"
    params: dict[str, str] = {}
    if min_access_role:
        params["minAccessRole"] = min_access_role
    items: list[dict[str, JsonValue]] = []
    token: str | None = None
    for _ in range(MAX_PAGES):
        page = dict(params)
        if token:
            page["pageToken"] = token
        data = await google_get(token_manager, url, params=page)
        if not isinstance(data, dict):
            break
        rows = data.get("items")
        if isinstance(rows, list):
            items.extend(r for r in rows if isinstance(r, dict))
        nxt = data.get("nextPageToken")
        if not isinstance(nxt, str) or not nxt:
            break
        token = nxt
    else:
        raise RuntimeError(PAGE_LIMIT)
    return items


async def list_events(
    token_manager: TokenManager,
    calendar_id: str,
    time_min: str | None,
    time_max: str,
    time_zone: str | None = None,
    *,
    scope: TimeRange = TimeRange(),
    query: str | None = None,
) -> list[dict[str, JsonValue]]:
    """List a calendar's events overlapping a time window.

    timeMin bounds an event's END and timeMax its START, both exclusive, so
    the pair is an overlap query: a multi-day or midnight-crossing event is
    returned by every day window it touches, with no extra request.

    singleEvents expands a recurring series into its instances, which is what
    makes a day directory well defined; without it the series' own record
    would stand in for every occurrence.

    Args:
        token_manager (TokenManager): the mount's OAuth handle.
        calendar_id (str): the calendar id, or "primary".
        time_min (str): RFC3339 lower bound, offset mandatory.
        time_max (str): RFC3339 upper bound, offset mandatory.
        time_zone (str | None): zone the response renders times in; Google
            defaults it to the calendar's own.
        scope (TimeRange): the mount's time range, which clips the window.
        query (str | None): words Calendar's search must find in an
            event's summary, description, location or people.

    Returns:
        list[dict]: events.list items.
    """
    # The id is one path segment and several real ones are not URL-safe: a
    # holiday calendar is "en.usa#holiday@group.v.calendar.google.com", and
    # an unencoded "#" opens a fragment, so the request would reach
    # /calendars/en.usa instead.
    url = (
        f"{calendar_base(token_manager)}/calendars/"
        f"{quote(calendar_id, safe='')}/events"
    )
    lo, hi = scope.clip(
        parse_time(time_min) if time_min is not None else -math.inf,
        parse_time(time_max),
    )
    if lo >= hi:
        return []
    params = {
        "timeMax": datetime.fromtimestamp(
            math.ceil(hi), timezone.utc
        ).isoformat(),
        "singleEvents": "true",
        "orderBy": "startTime",
        "maxResults": "2500",
    }
    if math.isfinite(lo):
        params["timeMin"] = datetime.fromtimestamp(
            math.floor(lo), timezone.utc
        ).isoformat()
    if time_zone:
        params["timeZone"] = time_zone
    if query is not None:
        params["q"] = query
    items: list[dict[str, JsonValue]] = []
    token: str | None = None
    for _ in range(MAX_PAGES):
        page = dict(params)
        if token:
            page["pageToken"] = token
        data = await google_get(token_manager, url, params=page)
        if not isinstance(data, dict):
            break
        rows = data.get("items")
        if isinstance(rows, list):
            items.extend(r for r in rows if isinstance(r, dict))
        nxt = data.get("nextPageToken")
        if not isinstance(nxt, str) or not nxt:
            break
        token = nxt
    else:
        raise RuntimeError(PAGE_LIMIT)
    if scope.bounded:
        items = [
            event
            for event in items
            if (span := event_span(event, time_zone or "UTC")) is not None
            and span[0].timestamp() < hi
            and (
                span[1].timestamp() > lo
                or span[0] == span[1]
                and span[0].timestamp() >= lo
            )
        ]
    return items


async def sync_events(
    token_manager: TokenManager,
    calendar_id: str,
    sync_token: str | None,
    time_zone: str | None = None,
) -> tuple[list[dict[str, JsonValue]], str | None]:
    """A calendar's events changed since ``sync_token``, every event when
    None, and the token the next sync starts from.

    Instances of a recurring series come one by one (singleEvents), as a
    listing names them, and one deleted since the token comes back with
    status ``cancelled``. Calendar answers 410 for a token it no longer
    honors, which raises as any failed call does.

    Args:
        token_manager (TokenManager): the mount's OAuth handle.
        calendar_id (str): the calendar id, or "primary".
        sync_token (str | None): where the last sync ended, None for a
            full one.
        time_zone (str | None): zone the response renders times in.
    """
    url = (
        f"{calendar_base(token_manager)}/calendars/"
        f"{quote(calendar_id, safe='')}/events"
    )
    params = {"singleEvents": "true", "maxResults": "2500"}
    if time_zone:
        params["timeZone"] = time_zone
    if sync_token is not None:
        params["syncToken"] = sync_token
    items: list[dict[str, JsonValue]] = []
    token: str | None = None
    for _ in range(MAX_PAGES):
        page = dict(params)
        if token:
            page["pageToken"] = token
        data = await google_get(token_manager, url, params=page)
        rows = data.get("items")
        if isinstance(rows, list):
            items.extend(r for r in rows if isinstance(r, dict))
        nxt = data.get("nextPageToken")
        if not isinstance(nxt, str) or not nxt:
            done = data.get("nextSyncToken")
            return items, done if isinstance(done, str) else None
        token = nxt
    raise RuntimeError(PAGE_LIMIT)


async def delete_event(
    token_manager: TokenManager, calendar_id: str, event_id: str
) -> None:
    """Delete one event.

    Args:
        token_manager (TokenManager): the mount's OAuth handle.
        calendar_id (str): the calendar id, or "primary".
        event_id (str): the event id.
    """
    url = (
        f"{calendar_base(token_manager)}/calendars/"
        f"{quote(calendar_id, safe='')}/events/"
        f"{quote(event_id, safe='')}"
    )
    await google_delete(token_manager, url)

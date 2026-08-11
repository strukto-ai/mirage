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

from mirage.core.google._client import (CALENDAR_API_BASE, TokenManager,
                                        calendar_base, google_delete,
                                        google_get)
from mirage.types import JsonValue

__all__ = [
    "CALENDAR_API_BASE",
    "TokenManager",
    "calendar_base",
    "google_delete",
    "google_get",
    "list_calendars",
    "list_events",
    "delete_event",
]

MAX_PAGES = 50


async def list_calendars(
        token_manager: TokenManager,
        min_access_role: str | None = None) -> list[dict[str, JsonValue]]:
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
    return items


async def list_events(
    token_manager: TokenManager,
    calendar_id: str,
    time_min: str,
    time_max: str,
    time_zone: str | None = None,
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

    Returns:
        list[dict]: events.list items.
    """
    url = (f"{calendar_base(token_manager)}/calendars/"
           f"{calendar_id}/events")
    params = {
        "timeMin": time_min,
        "timeMax": time_max,
        "singleEvents": "true",
        "orderBy": "startTime",
        "maxResults": "2500",
    }
    if time_zone:
        params["timeZone"] = time_zone
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
    return items


async def delete_event(token_manager: TokenManager, calendar_id: str,
                       event_id: str) -> None:
    """Delete one event.

    Args:
        token_manager (TokenManager): the mount's OAuth handle.
        calendar_id (str): the calendar id, or "primary".
        event_id (str): the event id.
    """
    url = (f"{calendar_base(token_manager)}/calendars/"
           f"{calendar_id}/events/{event_id}")
    await google_delete(token_manager, url)

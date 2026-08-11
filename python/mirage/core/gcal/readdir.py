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

import json
from datetime import date, timedelta

from mirage.accessor.gcal import GCalAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.core.gcal._client import list_calendars, list_events
from mirage.core.gcal.day import (DATE_RE, WINDOW_AHEAD_DAYS, WINDOW_BACK_DAYS,
                                  clamped_hhmm, day_bounds, days_covered,
                                  event_span, window_bounds)
from mirage.core.google.date_glob import glob_to_date_range
from mirage.resource.gcal.event_entry import (CALENDAR_FILE, PRIMARY_DIR,
                                              event_title,
                                              make_calendar_dirname,
                                              make_event_filename)
from mirage.types import JsonValue, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_prefix_of

CALENDAR_DIR = "gcal/calendar_dir"
CALENDAR_JSON = "gcal/calendar_json"
DAY_DIR = "gcal/day_dir"
EVENT = "gcal/event"
FREE_BUSY_ROLE = "freeBusyReader"


def calendar_payload(entry: dict[str, JsonValue], tz: str) -> bytes:
    """Render the per-calendar metadata file.

    Args:
        entry (dict): the calendarList entry.
        tz (str): the mount-wide bucketing zone.

    Returns:
        bytes: the rendered ``calendar.json``.
    """
    body = {
        "id": entry.get("id"),
        "summary": entry.get("summary"),
        "accessRole": entry.get("accessRole"),
        "primary": bool(entry.get("primary")),
        "calendarTimeZone": entry.get("timeZone"),
        # The zone the day directories are bucketed in, which is mount-wide
        # and therefore not always this calendar's own.
        "bucketTimeZone": tz,
    }
    return json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()


def normalize(path: PathSpec) -> tuple[str, str, str]:
    """Split a path into (mount prefix, mount-relative key, virtual key).

    Args:
        path (PathSpec): the path being listed.

    Returns:
        tuple[str, str, str]: prefix, key, virtual key.
    """
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    raw = path.directory if path.pattern else path.virtual
    if prefix and raw.startswith(prefix):
        rest = raw[len(prefix):]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            raw = rest or "/"
    key = raw.strip("/")
    virtual_key = prefix + "/" + key if key else prefix or "/"
    return prefix, key, virtual_key


async def calendar_index(
        accessor: GCalAccessor) -> dict[str, dict[str, JsonValue]]:
    """Map each calendar's directory name to its calendarList entry.

    Args:
        accessor (GCalAccessor): the mount's accessor.

    Returns:
        dict[str, dict]: directory name to entry.
    """
    rows = await list_calendars(accessor.token_manager,
                                accessor.config.min_access_role)
    out: dict[str, dict[str, JsonValue]] = {}
    for row in rows:
        cal_id = row.get("id")
        if not isinstance(cal_id, str) or not cal_id:
            continue
        summary = row.get("summary")
        name = make_calendar_dirname(
            summary if isinstance(summary, str) else cal_id,
            cal_id,
            primary=bool(row.get("primary")))
        out[name] = row
    return out


def bucket_zone(accessor: GCalAccessor,
                calendars: dict[str, dict[str, JsonValue]]) -> str:
    """The one zone every day directory on this mount is bucketed in.

    Defaults to the primary calendar's zone, matching how the Calendar UI
    draws its grid: bucketing each calendar in its own zone would make the
    same directory name mean different 24-hour windows on different
    calendars, so a cross-calendar free/busy comparison would be wrong.

    Args:
        accessor (GCalAccessor): the mount's accessor.
        calendars (dict): the calendar index.

    Returns:
        str: an IANA zone name.
    """
    if accessor.config.time_zone:
        return accessor.config.time_zone
    primary = calendars.get(PRIMARY_DIR)
    if primary is not None:
        tz = primary.get("timeZone")
        if isinstance(tz, str) and tz:
            return tz
    for entry in calendars.values():
        tz = entry.get("timeZone")
        if isinstance(tz, str) and tz:
            return tz
    return "UTC"


def day_span(pattern: str | None, today: date,
             tz: str) -> tuple[str, str, date, date]:
    """The listing window, honouring a date glob when one was typed.

    A bare readdir reports a rolling window around today because a calendar
    is unbounded in both directions and the API offers no descending
    startTime order. A glob escapes it by pushing its own bounds down.

    Args:
        pattern (str | None): the glob as typed, or None.
        today (date): the day the default window centres on.
        tz (str): the bucketing zone.

    Returns:
        tuple[str, str, date, date]: timeMin, timeMax, first day, last day.
    """
    span = glob_to_date_range(pattern)
    if span is not None:
        last = span[1] - timedelta(days=1)
        return day_bounds(span[0].isoformat(),
                          tz)[0], day_bounds(last.isoformat(),
                                             tz)[1], span[0], last
    lo, hi = window_bounds(today, tz)
    return (lo, hi, today - timedelta(days=WINDOW_BACK_DAYS),
            today + timedelta(days=WINDOW_AHEAD_DAYS))


def event_entries(events: list[dict[str, JsonValue]], day: str, tz: str,
                  free_busy: bool) -> list[tuple[str, IndexEntry]]:
    """Build the index entries for one day directory.

    Args:
        events (list): events overlapping the day.
        day (str): the local day, ``YYYY-MM-DD``.
        tz (str): the bucketing zone.
        free_busy (bool): whether the calendar hides event details.

    Returns:
        list[tuple[str, IndexEntry]]: (filename, entry) pairs.
    """
    rows: list[tuple[str, IndexEntry]] = []
    for event in events:
        event_id = event.get("id")
        if not isinstance(event_id, str) or not event_id:
            continue
        span = event_span(event, tz)
        if span is None or day not in days_covered(span, tz):
            continue
        summary = event.get("summary")
        title = event_title(summary if isinstance(summary, str) else None,
                            free_busy=free_busy)
        name = make_event_filename(event_id, clamped_hhmm(span, day, tz),
                                   title)
        updated = event.get("updated")
        payload = json.dumps(event, ensure_ascii=False,
                             separators=(",", ":")).encode()
        rows.append(
            (name,
             IndexEntry(
                 id=event_id,
                 name=title,
                 resource_type=EVENT,
                 remote_time=updated if isinstance(updated, str) else "",
                 vfs_name=name,
                 size=len(payload),
             )))
    return rows


async def readdir(
    accessor: GCalAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> list[str]:
    """List one level of the calendar tree.

    Args:
        accessor (GCalAccessor): the mount's accessor.
        path (PathSpec): the directory being listed.
        index (IndexCacheStore): the mount's index cache.

    Returns:
        list[str]: virtual paths of the directory's children.
    """
    prefix, key, virtual_key = normalize(path)
    calendars = await calendar_index(accessor)
    tz = bucket_zone(accessor, calendars)

    if not key:
        entries = [(name,
                    IndexEntry(id=str(entry.get("id") or name),
                               name=name,
                               resource_type=CALENDAR_DIR,
                               vfs_name=name))
                   for name, entry in sorted(calendars.items())]
        await index.set_dir(virtual_key, entries)
        return [f"{prefix}/{name}" for name, _ in entries]

    parts = key.split("/")
    entry = calendars.get(parts[0])
    if entry is None or len(parts) > 2:
        raise enoent(path.virtual)
    cal_id = entry.get("id")
    if not isinstance(cal_id, str):
        raise enoent(path.virtual)
    free_busy = entry.get("accessRole") == FREE_BUSY_ROLE

    if len(parts) == 1:
        time_min, time_max, first, last = day_span(path.pattern,
                                                   accessor.today(), tz)
        events = await list_events(accessor.token_manager, cal_id, time_min,
                                   time_max, tz)
        seen: set[str] = set()
        for event in events:
            span = event_span(event, tz)
            if span is None:
                continue
            for day in days_covered(span, tz):
                if first.isoformat() <= day <= last.isoformat():
                    seen.add(day)
        rows: list[tuple[str, IndexEntry]] = [
            (CALENDAR_FILE,
             IndexEntry(id=f"{cal_id}:calendar",
                        name=CALENDAR_FILE,
                        resource_type=CALENDAR_JSON,
                        vfs_name=CALENDAR_FILE,
                        size=len(calendar_payload(entry, tz))))
        ]
        for day in sorted(seen):
            rows.append((day,
                         IndexEntry(id=f"{cal_id}:{day}",
                                    name=day,
                                    resource_type=DAY_DIR,
                                    vfs_name=day)))
        if path.pattern:
            # A globbed listing is a filtered view, not the directory: caching
            # it as the directory would pin a short listing until it expires.
            for name, row in rows:
                await index.put(f"{virtual_key}/{name}", row)
        else:
            await index.set_dir(virtual_key, rows)
        return [f"{prefix}/{key}/{name}" for name, _ in rows]

    day = parts[1]
    if not DATE_RE.match(day):
        raise enoent(path.virtual)
    time_min, time_max = day_bounds(day, tz)
    events = await list_events(accessor.token_manager, cal_id, time_min,
                               time_max, tz)
    rows = event_entries(events, day, tz, free_busy)
    await index.set_dir(virtual_key, rows)
    return [f"{prefix}/{key}/{name}" for name, _ in rows]

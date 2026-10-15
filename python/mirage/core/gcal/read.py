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

import logging

from mirage.accessor.gcal import GCalAccessor
from mirage.core.gcal.client import list_events
from mirage.core.gcal.day import day_bounds
from mirage.core.gcal.readdir import (
    bucket_zone,
    calendar_index,
    calendar_payload,
    scoped_bucket,
)
from mirage.core.gcal.scope import detect_scope
from mirage.core.hierarchy.read import make_read
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.render.json import compact_json_bytes
from mirage.errors.fs import enoent
from mirage.types import FileStat, JsonValue, PathSpec
from mirage.vfs.gcal.event_entry import parse_event_filename

logger = logging.getLogger(__name__)


async def _read_calendar_json(
    accessor: GCalAccessor,
    match: ScopeMatch,
    path: PathSpec,
    entry: FileStat | None,
    parent: FileStat | None,
) -> bytes:
    calendars = await calendar_index(accessor)
    calendar = calendars.get(match.slots["calendar"])
    if calendar is None:
        raise enoent(path.virtual)
    return calendar_payload(calendar, bucket_zone(accessor, calendars))


def _event_of(
    accessor: GCalAccessor,
    calendars: dict[str, dict[str, JsonValue]],
    match: ScopeMatch,
    path: PathSpec,
) -> tuple[str, str, str]:
    """The calendar id, day and event id an event file names.

    Only the day the name is on is listed for it, so a read in a
    multi-day bucket costs what one in a day directory does.

    Args:
        accessor (GCalAccessor): the mount's accessor.
        calendars (dict[str, dict[str, JsonValue]]): the calendar index.
        match (ScopeMatch): a match holding ``calendar``, ``bucket`` and
            ``event``.
        path (PathSpec): the event file.
    """
    entry = calendars.get(match.slots["calendar"])
    cal_id = entry.get("id") if entry is not None else None
    if not isinstance(cal_id, str):
        raise enoent(path.virtual)
    days = scoped_bucket(
        accessor,
        match.slots["bucket"],
        bucket_zone(accessor, calendars),
        path.virtual,
    )
    event_id, day = parse_event_filename(match.slots["event"])
    # A name carries its day exactly when the mount's buckets span several.
    if (day is not None) != (accessor.config.bucket_days > 1):
        raise enoent(path.virtual)
    day = day or days[0]
    if day not in days:
        raise enoent(path.virtual)
    return cal_id, day, event_id


async def _day_events(
    accessor: GCalAccessor, cal_id: str, day: str, tz: str
) -> list[dict[str, JsonValue]]:
    """The events one local day of a calendar holds.

    Args:
        accessor (GCalAccessor): the mount's accessor.
        cal_id (str): the calendar's id.
        day (str): the day, ``YYYY-MM-DD``.
        tz (str): the zone the mount buckets days in.
    """
    time_min, time_max = day_bounds(day, tz)
    return await list_events(
        accessor.token_manager,
        cal_id,
        time_min,
        time_max,
        tz,
        scope=accessor.time_range,
    )


async def _read_event(
    accessor: GCalAccessor,
    match: ScopeMatch,
    path: PathSpec,
    entry: FileStat | None,
    parent: FileStat | None,
) -> bytes:
    """Read one event's raw API payload.

    The event file holds the events.list item unmodified: the directory
    name and the HHMM segment are a view, while the payload is the truth
    an absolute-instant comparison has to be made against.

    Args:
        accessor (GCalAccessor): the mount's accessor.
        match (ScopeMatch): a match holding ``calendar``, ``bucket`` and
            ``event``.
        path (PathSpec): the file to read.
        entry (FileStat | None): unused; the read asks Calendar.
        parent (FileStat | None): unused.
    """
    calendars = await calendar_index(accessor)
    cal_id, day, event_id = _event_of(accessor, calendars, match, path)
    tz = bucket_zone(accessor, calendars)
    for event in await _day_events(accessor, cal_id, day, tz):
        if event.get("id") == event_id:
            return compact_json_bytes(event)
    raise enoent(path.virtual)


async def read_many(
    accessor: GCalAccessor,
    paths: list[PathSpec],
    limit: int,
) -> dict[str, bytes]:
    """Read several event files, listing each day they name once.

    A day's listing answers every event asked of it, so a batch of one
    day's events costs what one read does. A path that is not an event
    file, names an event its day does not hold, or renders past
    ``limit`` bytes is left out for its own read to answer.

    Args:
        accessor (GCalAccessor): the mount's accessor.
        paths (list[PathSpec]): the files.
        limit (int): the most bytes worth reading for one file.
    """
    calendars = await calendar_index(accessor)
    tz = bucket_zone(accessor, calendars)
    days: dict[tuple[str, str], dict[str, str]] = {}
    for path in paths:
        match = detect_scope(path)
        if match.kind != "event":
            continue
        try:
            cal_id, day, event_id = _event_of(accessor, calendars, match, path)
        except FileNotFoundError as exc:
            logger.debug("read_many leaves out %s: %s", path.virtual, exc)
            continue
        days.setdefault((cal_id, day), {})[event_id] = path.virtual
    answers: dict[str, bytes] = {}
    for (cal_id, day), events in days.items():
        for event in await _day_events(accessor, cal_id, day, tz):
            virtual = events.get(str(event.get("id")))
            body = compact_json_bytes(event)
            if virtual is not None and len(body) <= limit:
                answers[virtual] = body
    return answers


read = make_read(
    detect_scope,
    readers={
        "calendar_json": _read_calendar_json,
        "event": _read_event,
    },
)

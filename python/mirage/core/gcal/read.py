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

from mirage.accessor.gcal import GCalAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.gcal.client import list_events
from mirage.core.gcal.day import day_bounds
from mirage.core.gcal.readdir import (bucket_zone, calendar_index,
                                      calendar_payload)
from mirage.core.gcal.scope import detect_scope
from mirage.core.hierarchy.read import make_read
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.render.json import compact_json_bytes
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.vfs.gcal.event_entry import parse_event_filename


async def _read_calendar_json(accessor: GCalAccessor, match: ScopeMatch,
                              path: PathSpec, index: IndexCacheStore) -> bytes:
    calendars = await calendar_index(accessor)
    entry = calendars.get(match.slots["calendar"])
    if entry is None:
        raise enoent(path.virtual)
    return calendar_payload(entry, bucket_zone(accessor, calendars))


async def _read_event(accessor: GCalAccessor, match: ScopeMatch,
                      path: PathSpec, index: IndexCacheStore) -> bytes:
    """Read one event's raw API payload.

    The event file holds the events.list item unmodified: the directory
    name and the HHMM segment are a view, while the payload is the truth
    an absolute-instant comparison has to be made against.

    Args:
        accessor (GCalAccessor): the mount's accessor.
        match (ScopeMatch): a match holding ``calendar``, ``day`` and
            ``event``.
        path (PathSpec): the file to read.
        index (IndexCacheStore): the mount's index cache.
    """
    calendars = await calendar_index(accessor)
    entry = calendars.get(match.slots["calendar"])
    if entry is None:
        raise enoent(path.virtual)
    tz = bucket_zone(accessor, calendars)
    cal_id = entry.get("id")
    if not isinstance(cal_id, str):
        raise enoent(path.virtual)
    event_id, _ = parse_event_filename(match.slots["event"])
    time_min, time_max = day_bounds(match.slots["day"], tz)
    for event in await list_events(accessor.token_manager, cal_id, time_min,
                                   time_max, tz):
        if event.get("id") == event_id:
            return compact_json_bytes(event)
    raise enoent(path.virtual)


read = make_read(
    detect_scope,
    readers={
        "calendar_json": _read_calendar_json,
        "event": _read_event,
    },
)

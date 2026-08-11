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
import logging

from mirage.accessor.gcal import GCalAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.gcal._client import list_events
from mirage.core.gcal.day import day_bounds
from mirage.core.gcal.readdir import (bucket_zone, calendar_index,
                                      calendar_payload, normalize)
from mirage.resource.gcal.event_entry import parse_event_filename
from mirage.types import PathSpec
from mirage.utils.errors import enoent

logger = logging.getLogger(__name__)


async def read(
    accessor: GCalAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> bytes:
    """Read one calendar.json or one event's raw API payload.

    The event file holds the events.list item unmodified: the directory name
    and the HHMM segment are a view, while the payload is the truth an
    absolute-instant comparison has to be made against.

    Args:
        accessor (GCalAccessor): the mount's accessor.
        path (PathSpec): the file to read.
        index (IndexCacheStore): the mount's index cache.

    Returns:
        bytes: the rendered file.
    """
    prefix, key, virtual_key = normalize(path)
    parts = key.split("/")
    if len(parts) < 2:
        raise IsADirectoryError(path.virtual)

    calendars = await calendar_index(accessor)
    entry = calendars.get(parts[0])
    if entry is None:
        raise enoent(path.virtual)
    tz = bucket_zone(accessor, calendars)

    if len(parts) == 2 and parts[1] == "calendar.json":
        return calendar_payload(entry, tz)

    if len(parts) != 3:
        raise enoent(path.virtual)

    cal_id = entry.get("id")
    if not isinstance(cal_id, str):
        raise enoent(path.virtual)
    event_id, _ = parse_event_filename(parts[2])
    time_min, time_max = day_bounds(parts[1], tz)
    for event in await list_events(accessor.token_manager, cal_id, time_min,
                                   time_max, tz):
        if event.get("id") == event_id:
            return json.dumps(event, ensure_ascii=False,
                              separators=(",", ":")).encode()
    raise enoent(path.virtual)

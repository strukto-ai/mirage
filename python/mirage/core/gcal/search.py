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

import aiohttp

from mirage.accessor.gcal import GCalAccessor
from mirage.core.gcal.day import day_bounds
from mirage.core.gcal.readdir import (
    bucket_zone,
    calendar_index,
    normalize,
    readdir,
    scoped_bucket,
)
from mirage.core.gcal.scope import detect_scope
from mirage.core.google.client import GoogleApiError
from mirage.core.hierarchy.probe import rows_of
from mirage.core.hierarchy.scope import ROOT
from mirage.core.time_range import parse_time
from mirage.types import PathSpec
from mirage.utils.key_prefix import mounted_path
from mirage.utils.record_search import may_hold, record_queries
from mirage.vfs.gcal.event_entry import CALENDAR_FILE

logger = logging.getLogger(__name__)


async def _buckets(
    accessor: GCalAccessor, scope: PathSpec
) -> list[PathSpec] | None:
    """The bucket directories under ``scope``; None for a scope inside a
    bucket or a calendar's file.

    Args:
        accessor (GCalAccessor): the mount's accessor.
        scope (PathSpec): a directory grep walks.
    """
    match = detect_scope(normalize(scope)[1])
    if match.kind == "bucket":
        return [scope]
    base = scope.mount_path.rstrip("/")
    if match.kind == ROOT:
        calendars = [
            mounted_path(scope, f"{base}/{row.name}")
            for row in rows_of(await readdir(accessor, scope))
        ]
    elif match.kind == "calendar":
        calendars = [scope]
    else:
        return None
    buckets: list[PathSpec] = []
    for calendar in calendars:
        parent = calendar.mount_path.rstrip("/")
        for row in rows_of(await readdir(accessor, calendar)):
            if row.name != CALENDAR_FILE:
                buckets.append(mounted_path(calendar, f"{parent}/{row.name}"))
    return buckets


async def files_containing(
    accessor: GCalAccessor,
    text: str,
    under: list[PathSpec],
) -> list[PathSpec] | None:
    """The event files under ``under`` whose event holds every word of
    ``text`` where Calendar's search finds it or where the listing kept it.

    Calendar searches an event's summary, description, location and
    people by word, so each word is asked on its own over the walked
    buckets' time window, and an event is read when each word is either
    found there or held by the text the listing kept (``unsearched_text``):
    the event's other fields, and the words of those three the search may
    split otherwise. The text goes through ``record_queries`` for its
    escapes. None when the text cannot be searched, a scope lies inside a
    bucket, a search fails or runs past ``MAX_PAGES`` pages, or nothing is
    found.

    Args:
        accessor (GCalAccessor): the mount's accessor.
        text (str): the whole word or words searched for.
        under (list[PathSpec]): the directories walked.
    """
    queries = record_queries(text, frozenset(), whole_word=True)
    if queries is None:
        return None
    asked = [query.lower().split() for query in queries]
    found: list[PathSpec] = []
    try:
        calendars = await calendar_index(accessor)
        tz = bucket_zone(accessor, calendars)
        walked: dict[str, list[PathSpec]] = {}
        for scope in under:
            buckets = await _buckets(accessor, scope)
            if buckets is None:
                return None
            for bucket in buckets:
                slots = detect_scope(normalize(bucket)[1]).slots
                walked.setdefault(slots["calendar"], []).append(bucket)
        for name, buckets in walked.items():
            cal_id = calendars.get(name, {}).get("id")
            if not isinstance(cal_id, str):
                return None
            spans = [
                day_bounds(days[0], tz, len(days))
                for days in (
                    scoped_bucket(
                        accessor,
                        detect_scope(normalize(bucket)[1]).slots["bucket"],
                        tz,
                        bucket.virtual,
                    )
                    for bucket in buckets
                )
            ]
            time_min = min((span[0] for span in spans), key=parse_time)
            time_max = max((span[1] for span in spans), key=parse_time)
            named: dict[str, set[str]] = {}
            for word in sorted({word for words in asked for word in words}):
                events = await accessor.calendar.list_events(
                    cal_id,
                    time_min,
                    time_max,
                    tz,
                    scope=accessor.time_range,
                    query=word,
                )
                named[word] = {
                    event_id
                    for event in events
                    if isinstance(event_id := event.get("id"), str)
                }
            for bucket in buckets:
                parent = bucket.mount_path.rstrip("/")
                for row in rows_of(await readdir(accessor, bucket)):
                    kept = row.extra.get("unsearched")
                    if not isinstance(kept, str):
                        return None
                    if may_hold(
                        asked, named, str(row.extra.get("event_id")), kept
                    ):
                        found.append(
                            mounted_path(bucket, f"{parent}/{row.name}")
                        )
    except (
        OSError,
        aiohttp.ClientError,
        GoogleApiError,
        ValueError,
        RuntimeError,
    ) as exc:
        logger.debug("calendar search failed (%s); reading every file", exc)
        return None
    return found or None

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

from datetime import date, datetime, timedelta, timezone

from mirage.accessor.gcal import GCalAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.core.gcal.client import list_calendars, list_events
from mirage.core.gcal.day import (
    SPAN_SEP,
    bucket_name,
    bucket_start,
    clamped_hhmm,
    day_bounds,
    days_covered,
    event_span,
    parse_bucket,
    window_bounds,
    zone,
)
from mirage.core.gcal.scope import detect_scope
from mirage.core.hierarchy.scope import ROOT
from mirage.core.render.json import compact_json_bytes
from mirage.core.time_range import TimeRange, parse_time
from mirage.errors.fs import enoent
from mirage.types import JsonValue, PathSpec
from mirage.utils.glob_walk import glob_prefix, literal_span
from mirage.utils.key_prefix import mount_prefix_of
from mirage.vfs.gcal.event_entry import (
    CALENDAR_FILE,
    PRIMARY_DIR,
    event_title,
    make_calendar_dirname,
    make_event_filename,
)

CALENDAR_DIR = "gcal/calendar_dir"
CALENDAR_JSON = "gcal/calendar_json"
BUCKET_DIR = "gcal/bucket_dir"
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
    return compact_json_bytes(body)


def normalize(path: PathSpec) -> tuple[str, str, str]:
    """Split a path into (mount prefix, mount-relative key, virtual key).

    Args:
        path (PathSpec): the path being listed.

    Returns:
        tuple[str, str, str]: prefix, key, virtual key.
    """
    prefix = mount_prefix_of(path.virtual, path.vfs_path)
    raw = path.directory if path.pattern else path.virtual
    if prefix and raw.startswith(prefix):
        rest = raw[len(prefix) :]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            raw = rest or "/"
    key = raw.strip("/")
    virtual_key = prefix + "/" + key if key else prefix or "/"
    return prefix, key, virtual_key


async def calendar_index(
    accessor: GCalAccessor,
) -> dict[str, dict[str, JsonValue]]:
    """Map each calendar's directory name to its calendarList entry.

    Args:
        accessor (GCalAccessor): the mount's accessor.

    Returns:
        dict[str, dict]: directory name to entry.
    """
    rows = await list_calendars(
        accessor.token_manager, accessor.config.min_access_role
    )
    out: dict[str, dict[str, JsonValue]] = {}
    for row in rows:
        cal_id = row.get("id")
        if not isinstance(cal_id, str) or not cal_id:
            continue
        summary = row.get("summary")
        name = make_calendar_dirname(
            summary if isinstance(summary, str) else cal_id,
            cal_id,
            primary=bool(row.get("primary")),
        )
        out[name] = row
    return out


def bucket_zone(
    accessor: GCalAccessor, calendars: dict[str, dict[str, JsonValue]]
) -> str:
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


def day_span(
    pattern: str | None,
    today: date,
    tz: str,
    scope: TimeRange = TimeRange(),
    size: int = 1,
) -> tuple[str | None, str, date, date]:
    """Resolve a listing's date glob and configured scope.

    A glob's span widens to whole buckets, so a bucket the glob reaches
    into is decided on all of its days, not only on the ones it named.
    A glob is read up to its first span separator: a bucket name is keyed
    on its first day, so ``2027-03-01--2027-03-07*`` bounds the listing
    as ``2027-03-01*`` does.

    Args:
        pattern (str | None): date glob, if present.
        today (date): anchor for the finite future horizon.
        tz (str): mount's bucketing timezone.
        scope (TimeRange): explicit inclusive/exclusive mount bounds.
        size (int): the mount's bucket length in days.
    """
    span = literal_span(glob_prefix(pattern).partition(SPAN_SEP)[0])
    lo = scope.start
    hi = scope.end
    if span is not None:
        head = bucket_start(span[0], size)
        tail = bucket_start(span[1] - timedelta(days=1), size)
        first = parse_time(day_bounds(head.isoformat(), tz)[0])
        last = parse_time(day_bounds(tail.isoformat(), tz, size)[1])
        lo = max(first, lo) if lo is not None else first
        hi = min(last, hi) if hi is not None else last
    elif hi is None:
        hi = parse_time(window_bounds(today, tz, size)[1])
    lower = (
        datetime.fromtimestamp(lo, timezone.utc).isoformat()
        if lo is not None
        else None
    )
    upper = datetime.fromtimestamp(hi, timezone.utc).isoformat()
    first_day = (
        datetime.fromtimestamp(lo, zone(tz)).date()
        if lo is not None
        else date.min
    )
    last_day = (
        datetime.fromtimestamp(hi, zone(tz)) - timedelta(microseconds=1)
    ).date()
    return lower, upper, first_day, last_day


def scoped_bucket(
    accessor: GCalAccessor, name: str, tz: str, virtual: str
) -> list[str]:
    """The days of a bucket directory inside the configured mount scope.

    A name off this mount's grid is absent, as is a bucket wholly outside
    the scope: direct paths are bounded exactly as listings are.

    Args:
        accessor (GCalAccessor): scoped mount accessor.
        name (str): the bucket directory name.
        tz (str): mount timezone.
        virtual (str): path reported in ENOENT.

    Returns:
        list[str]: the bucket's in-scope days, ascending and consecutive.
    """
    size = accessor.config.bucket_days
    start = parse_bucket(name, size)
    if start is None:
        raise enoent(virtual)
    days: list[str] = []
    for offset in range(size):
        day = (start + timedelta(days=offset)).isoformat()
        lo, hi = day_bounds(day, tz)
        clipped = accessor.time_range.clip(parse_time(lo), parse_time(hi))
        if clipped[0] < clipped[1]:
            days.append(day)
    if not days:
        raise enoent(virtual)
    return days


def event_entries(
    events: list[dict[str, JsonValue]],
    days: list[str],
    tz: str,
    free_busy: bool,
    dated: bool,
) -> list[tuple[str, IndexEntry]]:
    """Build the index entries for one bucket directory.

    An event gets one entry for each of the bucket's days it covers, so a
    multi-day bucket lists what its day directories would, flattened.

    Args:
        events (list): events overlapping the bucket.
        days (list[str]): the bucket's days, ``YYYY-MM-DD``.
        tz (str): the bucketing zone.
        free_busy (bool): whether the calendar hides event details.
        dated (bool): whether the names carry their day, as a multi-day
            bucket's do.

    Returns:
        list[tuple[str, IndexEntry]]: (filename, entry) pairs.
    """
    rows: list[tuple[str, IndexEntry]] = []
    for event in events:
        event_id = event.get("id")
        if not isinstance(event_id, str) or not event_id:
            continue
        span = event_span(event, tz)
        if span is None:
            continue
        summary = event.get("summary")
        title = event_title(
            summary if isinstance(summary, str) else None, free_busy=free_busy
        )
        updated = event.get("updated")
        size = len(compact_json_bytes(event))
        for day in days_covered(span, tz):
            if day not in days:
                continue
            name = make_event_filename(
                event_id,
                clamped_hhmm(span, day, tz),
                title,
                day if dated else None,
            )
            rows.append(
                (
                    name,
                    IndexEntry(
                        id=event_id,
                        name=title,
                        resource_type=EVENT,
                        remote_time=(
                            updated if isinstance(updated, str) else ""
                        ),
                        vfs_name=name,
                        size=size,
                    ),
                )
            )
    return rows


async def readdir(
    accessor: GCalAccessor,
    path_spec: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> list[str]:
    """List one level of the calendar tree.

    Args:
        accessor (GCalAccessor): the mount's accessor.
        path_spec (PathSpec): the directory being listed.
        index (IndexCacheStore): the mount's index cache.

    Returns:
        list[str]: virtual paths of the directory's children.
    """
    path = path_spec
    prefix, key, virtual_key = normalize(path)
    # Bespoke below the classifier: the date-glob push-down filters the
    # events query itself, and a globbed listing must not be cached as
    # the directory, which the kit readdir has no notion of.
    match = detect_scope(key)
    if match.kind not in (ROOT, "calendar", "bucket"):
        raise enoent(path.virtual)
    calendars = await calendar_index(accessor)
    tz = bucket_zone(accessor, calendars)

    if match.kind == ROOT:
        entries = [
            (
                name,
                IndexEntry(
                    id=str(entry.get("id") or name),
                    name=name,
                    resource_type=CALENDAR_DIR,
                    vfs_name=name,
                ),
            )
            for name, entry in sorted(calendars.items())
        ]
        await index.set_dir(virtual_key, entries)
        return [f"{prefix}/{name}" for name, _ in entries]

    entry = calendars.get(match.slots["calendar"])
    if entry is None:
        raise enoent(path.virtual)
    cal_id = entry.get("id")
    if not isinstance(cal_id, str):
        raise enoent(path.virtual)
    free_busy = entry.get("accessRole") == FREE_BUSY_ROLE
    size = accessor.config.bucket_days

    if match.kind == "calendar":
        time_min, time_max, first, last = day_span(
            path.pattern, accessor.today(tz), tz, accessor.time_range, size
        )
        events = await list_events(
            accessor.token_manager,
            cal_id,
            time_min,
            time_max,
            tz,
            scope=accessor.time_range,
        )
        seen: set[str] = set()
        for event in events:
            span = event_span(event, tz)
            if span is None:
                continue
            for day in days_covered(span, tz):
                if first.isoformat() <= day <= last.isoformat():
                    start = bucket_start(date.fromisoformat(day), size)
                    seen.add(bucket_name(start, size))
        rows: list[tuple[str, IndexEntry]] = [
            (
                CALENDAR_FILE,
                IndexEntry(
                    id=f"{cal_id}:calendar",
                    name=CALENDAR_FILE,
                    resource_type=CALENDAR_JSON,
                    vfs_name=CALENDAR_FILE,
                    size=len(calendar_payload(entry, tz)),
                ),
            )
        ]
        for name in sorted(seen):
            rows.append(
                (
                    name,
                    IndexEntry(
                        id=f"{cal_id}:{name}",
                        name=name,
                        resource_type=BUCKET_DIR,
                        vfs_name=name,
                    ),
                )
            )
        if path.pattern:
            # A globbed listing is a filtered view, not the directory: caching
            # it as the directory would pin a short listing until it expires.
            for name, row in rows:
                await index.put(f"{virtual_key}/{name}", row)
        else:
            await index.set_dir(virtual_key, rows)
        return [f"{prefix}/{key}/{name}" for name, _ in rows]

    days = scoped_bucket(accessor, match.slots["bucket"], tz, path.virtual)
    time_min, time_max = day_bounds(days[0], tz, len(days))
    events = await list_events(
        accessor.token_manager,
        cal_id,
        time_min,
        time_max,
        tz,
        scope=accessor.time_range,
    )
    rows = event_entries(events, days, tz, free_busy, dated=size > 1)
    await index.set_dir(virtual_key, rows)
    return [f"{prefix}/{key}/{name}" for name, _ in rows]

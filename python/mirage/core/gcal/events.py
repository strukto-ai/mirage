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
from datetime import date, datetime, timezone
from http import HTTPStatus

import aiohttp

from mirage.accessor.gcal import GCalAccessor
from mirage.core.gcal.client import listed
from mirage.core.gcal.day import (
    bucket_name,
    bucket_start,
    clamped_hhmm,
    day_bounds,
    days_covered,
    event_span,
)
from mirage.core.gcal.readdir import (
    FREE_BUSY_ROLE,
    bucket_zone,
    calendar_index,
    calendar_payload,
    scoped_bucket,
)
from mirage.core.gcal.scope import detect_scope
from mirage.core.hierarchy.scope import ROOT
from mirage.core.time_range import parse_time
from mirage.events.base import DeltaHook
from mirage.events.delta import changes_between, changes_under
from mirage.events.payload import text_field
from mirage.types import Delta, FileChangeKind, JsonValue, PathSpec
from mirage.utils.key_prefix import mount_prefix_of
from mirage.vfs.gcal.event_entry import (
    CALENDAR_FILE,
    event_title,
    make_event_filename,
)

logger = logging.getLogger(__name__)

# Each event's files and ``updated`` stamp, by event id.
Known = dict[str, tuple[list[str], str | None]]

# One calendar's sync state: where its last sync ended, and its events.
CalendarState = tuple[str | None, Known]


def event_paths(
    accessor: GCalAccessor,
    base: str,
    event: dict[str, JsonValue],
    tz: str,
    free_busy: bool,
) -> list[str]:
    """The files an event is: one per day it covers that the mount's scope
    holds, named as the bucket listing names it. A bucket whose listing
    leaves the event out (it falls outside the mount's time range) holds
    none of it.

    Args:
        accessor (GCalAccessor): the mount's accessor.
        base (str): the calendar directory, as a virtual path.
        event (dict[str, JsonValue]): an events.list item.
        tz (str): the zone the mount buckets days in.
        free_busy (bool): whether the calendar hides event details.
    """
    event_id = text_field(event, "id")
    span = event_span(event, tz)
    if not event_id or span is None:
        return []
    size = accessor.config.bucket_days
    scope = accessor.time_range
    title = event_title(text_field(event, "summary"), free_busy=free_busy)
    paths: list[str] = []
    for day in days_covered(span, tz):
        bucket = bucket_name(bucket_start(date.fromisoformat(day), size), size)
        try:
            in_scope = scoped_bucket(accessor, bucket, tz, base)
        except FileNotFoundError as exc:
            logger.debug("gcal events skip %s/%s: %s", base, bucket, exc)
            continue
        lo, hi = day_bounds(in_scope[0], tz, len(in_scope))
        if day in in_scope and (
            not scope.bounded
            or listed(span, *scope.clip(parse_time(lo), parse_time(hi)))
        ):
            name = make_event_filename(
                event_id,
                clamped_hhmm(span, day, tz),
                title,
                day if size > 1 else None,
            )
            paths.append(f"{base}/{bucket}/{name}")
    return paths


class GCalDeltaHook:
    """Checkpointed delta over Calendar's incremental sync.

    Each calendar's checkpoint holds its sync token and, by event id, the
    files the event is and its ``updated`` stamp. An event names no file
    itself (its files follow from its start, its title and the days it
    covers), so the files it was are what the checkpoint remembers: an
    event moved or renamed is its old files leaving and its new ones
    appearing, and a deleted one comes back ``cancelled``, which leaves
    every file it was. A token Calendar no longer honors (410) is answered
    by listing the calendar whole and comparing each event's stamp, so
    nothing is lost or reported twice. A calendar added to or removed from
    the account is its directory appearing or leaving, and its own
    details changed are its calendar.json, which the checkpoint keeps as
    it was rendered. The checkpoint also keeps the zone days are bucketed
    in: when it moves, every event's files may move, so each calendar is
    synced whole again.
    """

    def __init__(self, accessor: GCalAccessor) -> None:
        """Args:
        accessor (GCalAccessor): the mount's accessor.
        """
        self._accessor = accessor

    async def pull(self, root: PathSpec, checkpoint: str | None) -> Delta:
        """Return the changes under ``root`` since ``checkpoint``.

        Args:
            root (PathSpec): Event root.
            checkpoint (str | None): The previous pull's state, or None for
                a baseline.
        """
        accessor = self._accessor
        calendars = await calendar_index(accessor)
        tz = bucket_zone(accessor, calendars)
        prefix = mount_prefix_of(root.virtual, root.vfs_path)
        match = detect_scope(root)
        wanted = None if match.kind == ROOT else match.slots.get("calendar")
        decoded = _decode(checkpoint)
        zone, previous, shown = (
            (None, None, {}) if decoded is None else decoded
        )
        states: dict[str, CalendarState] = {}
        details: dict[str, str] = {}
        changes: list[tuple[FileChangeKind, str]] = []
        for name, entry in sorted(calendars.items()):
            cal_id = entry.get("id")
            if (wanted is not None and name != wanted) or not isinstance(
                cal_id, str
            ):
                continue
            base = f"{prefix}/{name}"
            free_busy = entry.get("accessRole") == FREE_BUSY_ROLE
            last = None if previous is None else previous.get(name)
            details[name] = calendar_payload(entry, tz).decode()
            if previous is not None and last is None:
                changes.append((FileChangeKind.CREATE, base))
            elif last is not None and shown.get(name) != details[name]:
                changes.append(
                    (FileChangeKind.UPDATE, f"{base}/{CALENDAR_FILE}")
                )
            if last is not None and zone != tz:
                last = (None, last[1])
            states[name] = await self._sync(
                cal_id,
                base,
                tz,
                free_busy,
                last,
                changes if last is not None else [],
            )
        if previous is None:
            return Delta((), _encode(tz, states, details))
        changes.extend(
            (FileChangeKind.DELETE, f"{prefix}/{name}")
            for name in sorted(set(previous) - set(states))
            if wanted is None or name == wanted
        )
        observed = datetime.now(timezone.utc)
        return Delta(
            tuple(changes_under(root, changes, observed)),
            _encode(tz, states, details),
        )

    async def _sync(
        self,
        cal_id: str,
        base: str,
        tz: str,
        free_busy: bool,
        last: CalendarState | None,
        changes: list[tuple[FileChangeKind, str]],
    ) -> CalendarState:
        """One calendar's events since its last sync, recorded as changes
        to its files, and its state after them.

        Args:
            cal_id (str): The calendar's id.
            base (str): Its directory, as a virtual path.
            tz (str): The zone the mount buckets days in.
            free_busy (bool): Whether it hides event details.
            last (CalendarState | None): Its state after the last pull,
                None for a calendar not synced before.
            changes (list[tuple[FileChangeKind, str]]): Where the changes
                go.
        """
        calendar = self._accessor.calendar
        token, known = last if last is not None else (None, {})
        known = dict(known)
        whole = token is None
        try:
            events, nxt = await calendar.sync_events(cal_id, token, tz)
        except aiohttp.ClientResponseError as exc:
            if exc.status != HTTPStatus.GONE:
                raise
            logger.debug("gcal sync token for %s expired: %s", cal_id, exc)
            whole = True
            events, nxt = await calendar.sync_events(cal_id, None, tz)
        seen: set[str] = set()
        for event in events:
            event_id = text_field(event, "id")
            if event_id is None:
                continue
            seen.add(event_id)
            before, stamp = known.get(event_id, ([], None))
            after = (
                []
                if event.get("status") == "cancelled"
                else event_paths(self._accessor, base, event, tz, free_busy)
            )
            updated = text_field(event, "updated")
            same = event_id in known and stamp == updated
            changes.extend(changes_between(before, after, lambda _: not same))
            if after:
                known[event_id] = (after, updated)
            else:
                known.pop(event_id, None)
        if whole:
            for event_id in sorted(set(known) - seen):
                gone = known.pop(event_id)[0]
                changes.extend(changes_between(gone, [], lambda _: False))
        return nxt, known


def _encode(
    zone: str, states: dict[str, CalendarState], details: dict[str, str]
) -> str:
    return json.dumps(
        {
            "gcal": {
                "zone": zone,
                "calendars": {
                    name: {
                        "token": token,
                        "details": details.get(name, ""),
                        "events": {
                            event_id: {"paths": paths, "updated": updated}
                            for event_id, (paths, updated) in known.items()
                        },
                    }
                    for name, (token, known) in states.items()
                },
            }
        },
        sort_keys=True,
    )


def _decode(
    checkpoint: str | None,
) -> tuple[str | None, dict[str, CalendarState], dict[str, str]] | None:
    """The bucket zone, each calendar's state and each calendar's
    calendar.json a checkpoint holds, None for a baseline.

    Args:
        checkpoint (str | None): What the previous pull handed out.
    """
    if checkpoint is None:
        return None
    data = json.loads(checkpoint)
    state = data.get("gcal") if isinstance(data, dict) else None
    if not isinstance(state, dict):
        return None
    zone = state.get("zone")
    out: dict[str, CalendarState] = {}
    details: dict[str, str] = {}
    for name, row in (state.get("calendars") or {}).items():
        token = row.get("token")
        events = row.get("events") or {}
        details[name] = str(row.get("details") or "")
        out[name] = (
            token if isinstance(token, str) else None,
            {
                event_id: (
                    [str(v) for v in event.get("paths") or []],
                    event.get("updated"),
                )
                for event_id, event in events.items()
            },
        )
    return zone if isinstance(zone, str) else None, out, details


def build_delta_hook(accessor: GCalAccessor) -> DeltaHook:
    """Build the Calendar delta hook (``GCalDeltaHook``).

    Args:
        accessor (GCalAccessor): the mount's accessor.
    """
    return GCalDeltaHook(accessor)
